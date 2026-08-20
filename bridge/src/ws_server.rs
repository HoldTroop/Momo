use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::{header, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio::time::{interval, timeout};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::{BridgeRequest, BridgeResponse, BridgeServer};

/// How long `send_command` waits for the extension's `CommandResult` before
/// resolving as a timeout. Defaults to 30 s (mirroring the extension's own
/// `WsClient` timeout, PHASE9_MCP_PLAN.md §6.4); overridable via
/// `MOMO_COMMAND_TIMEOUT_MS` so tests can exercise the timeout path quickly.
fn command_timeout() -> Duration {
    std::env::var("MOMO_COMMAND_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(30))
}

/// Failure modes for a bridge→extension command round-trip.
#[derive(Debug)]
pub enum CommandError {
    /// No extension is connected to the WebSocket.
    Disconnected,
    /// The extension did not answer within `COMMAND_TIMEOUT`.
    Timeout,
}

/// A single WebSocket connection to the extension.
struct WsConnection {
    id: Uuid,
    sender: mpsc::Sender<BridgeResponse>,
    session_id: Option<String>,
    last_pong: Instant,
}

/// In-flight bridge→extension commands: outer key is the connection id, inner
/// key is the `request_id` the bridge generated when issuing the `Command`.
/// The read loop resolves the matching entry when the extension replies with
/// `CommandResult`. Per-connection so one connection's disconnect only fails
/// its own in-flight commands (PHASE9_MCP_PLAN.md §6.4).
type PendingCommands =
    Arc<Mutex<HashMap<Uuid, HashMap<String, oneshot::Sender<serde_json::Value>>>>>;

/// Manages all active WebSocket connections.
pub struct ConnectionManager {
    connections: Arc<RwLock<HashMap<Uuid, WsConnection>>>,
    bridge_server: Arc<BridgeServer>,
    pending_commands: PendingCommands,
}

impl ConnectionManager {
    pub fn new(bridge_server: Arc<BridgeServer>) -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            bridge_server,
            pending_commands: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register a new connection and spawn its read/write loops.
    pub async fn register(&self, ws: WebSocket) {
        let conn_id = Uuid::new_v4();
        // Bounded (128): a client that stops reading cannot accumulate frames
        // without limit; send sites use `try_send` so a full channel is seen.
        let (tx, mut rx) = mpsc::channel::<BridgeResponse>(128);
        let expected_token = self.bridge_server.auth_token();

        let conn = WsConnection {
            id: conn_id,
            sender: tx,
            session_id: None,
            last_pong: Instant::now(),
        };

        self.connections.write().await.insert(conn_id, conn);
        info!("WS connection opened: {} (total: {})", conn_id, self.connections.read().await.len());

        let (mut ws_sender, mut ws_receiver) = ws.split();
        let connections = self.connections.clone();
        let bridge_server = self.bridge_server.clone();
        let pending_commands = self.pending_commands.clone();

        // H29: a shutdown signal lets the heartbeat evict a dead connection by
        // closing the socket: both loops break and their WebSocket halves drop.
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let write_shutdown_rx = shutdown_rx.clone();
        let read_shutdown_rx = shutdown_rx.clone();
        let read_shutdown_tx = shutdown_tx.clone();

        // Write loop: drain the response channel and send frames
        let write_loop = tokio::spawn(async move {
            let mut shutdown_rx = write_shutdown_rx;
            loop {
                // `biased`: drain queued responses (e.g. a final error frame)
                // before honoring a shutdown signal; the two can race.
                tokio::select! {
                    biased;
                    response = rx.recv() => {
                        match response {
                            Some(response) => {
                                match serde_json::to_vec(&response) {
                                    Ok(bytes) => {
                                        if ws_sender.send(Message::Binary(bytes.into())).await.is_err() {
                                            debug!("WS write error (connection likely closed): {}", conn_id);
                                            break;
                                        }
                                    }
                                    Err(e) => error!("Failed to serialize WS response: {}", e),
                                }
                            }
                            None => break,
                        }
                    }
                    _ = shutdown_rx.changed() => break,
                }
            }
            debug!("WS write loop ended: {}", conn_id);
        });

        // Read loop: parse frames, gate on auth, dispatch to bridge
        let read_loop = tokio::spawn(async move {
            let mut authenticated = false;
            let mut shutdown_rx = read_shutdown_rx;
            // C6: the connection must authenticate within 15 s of being opened.
            let auth_deadline = tokio::time::sleep(Duration::from_secs(15));
            tokio::pin!(auth_deadline);
            loop {
                let msg = if !authenticated {
                    tokio::select! {
                        biased;
                        _ = shutdown_rx.changed() => break,
                        _ = &mut auth_deadline => break,
                        m = ws_receiver.next() => m,
                    }
                } else {
                    tokio::select! {
                        biased;
                        _ = shutdown_rx.changed() => break,
                        m = ws_receiver.next() => m,
                    }
                };
                let Some(msg) = msg else { break };
                if matches!(
                    process_message(
                        conn_id,
                        &connections,
                        &bridge_server,
                        &pending_commands,
                        &mut authenticated,
                        &expected_token,
                        msg,
                    )
                    .await,
                    FrameFlow::Break
                ) {
                    break;
                }
            }

            // Cleanup on disconnect (idempotent: also runs after eviction)
            connections.write().await.remove(&conn_id);
            // Fail THIS connection's in-flight commands: dropping the oneshot
            // Senders makes the awaiting `send_command` calls resolve as
            // Disconnected rather than hang until the timeout (§6.4). Other
            // connections' pending commands are untouched.
            pending_commands.lock().await.remove(&conn_id);
            info!("WS connection closed: {} (remaining: {})", conn_id, connections.read().await.len());
            // Close the write half promptly too.
            let _ = read_shutdown_tx.send(true);
        });

        // Heartbeat task: send PING every 15s, expect PONG within 5s.
        // On timeout (or channel closed/full) it evicts the connection and
        // signals shutdown so the read/write loops end and the socket closes (H29).
        let heartbeat_connections = self.connections.clone();
        let heartbeat_conn_id = conn_id;
        tokio::spawn(async move {
            let mut ticker = interval(Duration::from_secs(15));
            loop {
                ticker.tick().await;
                let should_remove = {
                    let conns = heartbeat_connections.read().await;
                    if let Some(conn) = conns.get(&heartbeat_conn_id) {
                        // Send application-level PING
                        let ping = BridgeResponse::Ok {
                            request_id: Uuid::new_v4().to_string(),
                            data: serde_json::json!({ "status": "ping", "timestamp": chrono::Utc::now().timestamp_millis() }),
                        };
                        // try_send: Err means the channel is closed or full — a
                        // full channel means the client has stalled reading and the
                        // connection should be dropped (evict below).
                        if conn.sender.try_send(ping).is_err() {
                            true // channel closed or full: stalled client
                        } else {
                            // Check if PONG received recently
                            conn.last_pong.elapsed() > Duration::from_secs(20)
                        }
                    } else {
                        true // connection gone
                    }
                };
                if should_remove {
                    heartbeat_connections.write().await.remove(&heartbeat_conn_id);
                    let _ = shutdown_tx.send(true);
                    break;
                }
            }
        });

        // Wait for both loops to finish; once both halves break, the WebSocket
        // splits are dropped and the socket closes.
        let _ = tokio::join!(write_loop, read_loop);
    }

    /// Broadcast an event to all connected clients.
    pub async fn broadcast(&self, event: BridgeResponse) {
        let conns = self.connections.read().await;
        for conn in conns.values() {
            // try_send: a full channel means the client has stalled reading;
            // drop the event (the heartbeat will evict the connection).
            let _ = conn.sender.try_send(event.clone());
        }
    }

    /// Issue a bridge→extension command and await its `CommandResult`
    /// (PHASE9_MCP_PLAN.md §6). Used by the MCP server (Mode B) to request
    /// perception and actions from the extension over the same WebSocket the
    /// extension already connects to.
    ///
    /// Semantics (§6.4):
    /// - No connected extension → `Err(CommandError::Disconnected)` immediately.
    /// - No `CommandResult` within `COMMAND_TIMEOUT` → `Err(CommandError::Timeout)`.
    /// - Extension disconnects mid-flight → the oneshot is dropped, so this
    ///   resolves as `Err(CommandError::Disconnected)`.
    ///
    /// Concurrent commands are supported: each call owns its own `request_id`
    /// slot in the target connection's pending registry. The command is issued
    /// to the first registered connection (single-extension model).
    pub async fn send_command(
        &self,
        command: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, CommandError> {
        // Target the first registered connection; fail fast when nothing is
        // connected (avoids a pointless 30 s wait).
        let (target_id, target_sender) = {
            let conns = self.connections.read().await;
            match conns.iter().next() {
                Some((id, conn)) => (*id, conn.sender.clone()),
                None => return Err(CommandError::Disconnected),
            }
        };

        let request_id = self.bridge_server.next_request_id();
        let (tx, rx) = oneshot::channel::<serde_json::Value>();
        self.pending_commands
            .lock()
            .await
            .entry(target_id)
            .or_default()
            .insert(request_id.clone(), tx);

        let message = BridgeResponse::Command {
            request_id: request_id.clone(),
            command: command.to_string(),
            params,
        };

        // try_send: a full channel means the target client has stalled reading
        // and the connection should be dropped (eviction via the heartbeat will
        // follow; no extra action needed) — fail the command immediately.
        if target_sender.try_send(message).is_err() {
            if let Some(inner) = self.pending_commands.lock().await.get_mut(&target_id) {
                inner.remove(&request_id);
            }
            return Err(CommandError::Disconnected);
        }

        match timeout(command_timeout(), rx).await {
            Ok(Ok(result)) => Ok(result),
            // Sender dropped (the target connection closed and cleaned up) →
            // treat as a disconnect, not a silent hang.
            Ok(Err(_)) => Err(CommandError::Disconnected),
            Err(_) => {
                if let Some(inner) = self.pending_commands.lock().await.get_mut(&target_id) {
                    inner.remove(&request_id);
                }
                Err(CommandError::Timeout)
            }
        }
    }

    /// Get the number of active connections.
    pub async fn connection_count(&self) -> usize {
        self.connections.read().await.len()
    }

    /// Access the underlying `BridgeServer` (needed by a later integration wave).
    pub(crate) fn bridge_server(&self) -> Arc<BridgeServer> {
        self.bridge_server.clone()
    }
}

/// Extract session_id from a BridgeRequest if present.
fn extract_session_id(request: &BridgeRequest) -> Option<String> {
    match request {
        BridgeRequest::PolicyCheck { session_id, .. }
        | BridgeRequest::SimulateClick { session_id, .. }
        | BridgeRequest::SimulateType { session_id, .. }
        | BridgeRequest::SimulateScroll { session_id, .. }
        | BridgeRequest::SimulateMouseMove { session_id, .. }
        | BridgeRequest::Observe { session_id, .. }
        | BridgeRequest::Extract { session_id, .. } => Some(session_id.clone()),
        _ => None,
    }
}

/// What the read loop should do after processing one frame.
enum FrameFlow {
    /// Keep reading frames.
    Continue,
    /// Stop reading and close the connection.
    Break,
}

/// Handle one inbound WebSocket message (read loop body).
async fn process_message(
    conn_id: Uuid,
    connections: &Arc<RwLock<HashMap<Uuid, WsConnection>>>,
    bridge_server: &BridgeServer,
    pending_commands: &PendingCommands,
    authenticated: &mut bool,
    expected_token: &str,
    msg: Result<Message, axum::Error>,
) -> FrameFlow {
    match msg {
        Ok(Message::Binary(data)) => {
            // Explicit size cap (1 MiB): tungstenite's default 64 MiB limit is
            // generous for this protocol; drop oversized frames unparsed.
            if data.len() > 1_048_576 {
                warn!("WS frame too large ({} bytes) from {}: dropping", data.len(), conn_id);
                return FrameFlow::Continue;
            }
            process_frame(
                conn_id,
                connections,
                bridge_server,
                pending_commands,
                authenticated,
                expected_token,
                data,
            )
            .await
        }
        Ok(Message::Pong(_)) => {
            if let Some(conn) = connections.write().await.get_mut(&conn_id) {
                conn.last_pong = Instant::now();
            }
            FrameFlow::Continue
        }
        Ok(Message::Close(_)) => {
            info!("WS close frame from {}", conn_id);
            FrameFlow::Break
        }
        Err(e) => {
            warn!("WS read error {}: {}", conn_id, e);
            FrameFlow::Break
        }
        _ => FrameFlow::Continue,
    }
}

/// Parse and dispatch one binary frame (read loop body).
async fn process_frame(
    conn_id: Uuid,
    connections: &Arc<RwLock<HashMap<Uuid, WsConnection>>>,
    bridge_server: &BridgeServer,
    pending_commands: &PendingCommands,
    authenticated: &mut bool,
    expected_token: &str,
    data: Vec<u8>,
) -> FrameFlow {
    let request: BridgeRequest = match serde_json::from_slice(&data) {
        Ok(r) => r,
        Err(e) => {
            warn!("WS invalid JSON from {}: {}", conn_id, e);
            return FrameFlow::Continue;
        }
    };

    // H30: every successfully parsed binary frame is proof of liveness.
    if let Some(conn) = connections.write().await.get_mut(&conn_id) {
        conn.last_pong = Instant::now();
    }

    // C6: unauthenticated connections may only send AUTH.
    if !*authenticated {
        let (response, keep_going) = match request {
            BridgeRequest::Auth { token } if token == expected_token => {
                *authenticated = true;
                (
                    BridgeResponse::Ok {
                        request_id: "auth".to_string(),
                        data: serde_json::json!({ "status": "auth_ok" }),
                    },
                    true,
                )
            }
            BridgeRequest::Auth { .. } => {
                (
                    BridgeResponse::Error {
                        request_id: "auth".to_string(),
                        code: -32001,
                        message: "authentication failed".to_string(),
                    },
                    false,
                )
            }
            _ => {
                (
                    BridgeResponse::Error {
                        request_id: Uuid::new_v4().to_string(),
                        code: -32000,
                        message: "not authenticated".to_string(),
                    },
                    true,
                )
            }
        };
        if let Some(conn) = connections.write().await.get_mut(&conn_id) {
            // try_send: a full channel means a stalled client (heartbeat evicts).
            let _ = conn.sender.try_send(response);
        }
        return if keep_going { FrameFlow::Continue } else { FrameFlow::Break };
    }

    // A CommandResult resolves an in-flight bridge→extension command and
    // expects no response back (PHASE9 §6).
    if let BridgeRequest::CommandResult { request_id, result } = &request {
        if let Some(tx) = pending_commands
            .lock()
            .await
            .get_mut(&conn_id)
            .and_then(|m| m.remove(request_id))
        {
            let _ = tx.send(result.clone());
        } else {
            warn!("CommandResult with no pending command: {}", request_id);
        }
        return FrameFlow::Continue;
    }

    // Update session_id on first PolicyCheck/Simulate* if not set
    if connections.read().await.get(&conn_id).map(|c| c.session_id.is_none()).unwrap_or(false) {
        if let Some(sid) = extract_session_id(&request) {
            if let Some(conn) = connections.write().await.get_mut(&conn_id) {
                conn.session_id = Some(sid);
            }
        }
    }

    // Handle via bridge server. H28: error responses carry the client's
    // request id when present, otherwise a fresh UUID.
    let client_id = serde_json::from_slice::<serde_json::Value>(&data)
        .ok()
        .and_then(|v| v.get("id").and_then(|id| id.as_str()).map(String::from));
    let response = bridge_server
        .handle_request(request, client_id.clone())
        .await
        .unwrap_or_else(|e| {
            BridgeResponse::Error {
                request_id: client_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                code: -1,
                message: e.to_string(),
            }
        });

    // Update last_pong on PING/PONG
    if let BridgeResponse::Ok { data: response_data, .. } = &response {
        if response_data.get("status").and_then(|v| v.as_str()) == Some("pong") {
            if let Some(conn) = connections.write().await.get_mut(&conn_id) {
                conn.last_pong = Instant::now();
            }
        }
    }

    if connections.read().await.get(&conn_id).is_some() {
        if let Some(conn) = connections.write().await.get_mut(&conn_id) {
            // try_send: a full channel means a stalled client (heartbeat evicts).
            let _ = conn.sender.try_send(response);
        }
    }

    FrameFlow::Continue
}

/// Axum handler for WebSocket upgrade.
/// C6: browser origins must be `chrome-extension://`; a missing Origin header
/// (non-browser client) is allowed because the bearer token still gates every
/// request.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: axum::http::HeaderMap,
    manager: axum::Extension<Arc<ConnectionManager>>,
) -> Response {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if !origin_allowed(origin) {
        // Static status + body, so the builder cannot fail.
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(axum::body::Body::from("origin not allowed"))
            .expect("static 403 response");
    }
    let manager = manager.0;
    ws.on_upgrade(move |socket| {
        let mgr = manager.clone();
        async move { mgr.register(socket).await }
    })
}

/// C6: only `chrome-extension://` origins may open the WebSocket. `None`
/// (non-browser clients) is allowed for MCP mode.
/// When MOMO_EXTENSION_ID env var is set, validates exact extension ID.
fn origin_allowed(origin: Option<&str>) -> bool {
    match origin {
        None => true,  // Non-browser clients (MCP mode)
        Some(o) => {
            let lower = o.to_ascii_lowercase();
            if !lower.starts_with("chrome-extension://") {
                return false;
            }
            
            // If MOMO_EXTENSION_ID is set, validate exact ID
            if let Ok(expected_id) = std::env::var("MOMO_EXTENSION_ID") {
                let expected = format!("chrome-extension://{}", expected_id.to_lowercase());
                return lower == expected;
            }
            
            // Development mode: accept any chrome-extension:// origin
            // Production deployments MUST set MOMO_EXTENSION_ID
            true
        }
    }
}

/// Build the WebSocket router.
pub fn ws_router(manager: Arc<ConnectionManager>) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .layer(axum::Extension(manager))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    type Client = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    /// Start a real bridge (BridgeServer + ConnectionManager + axum WS router)
    /// on an ephemeral localhost port and return the manager + port.
    async fn start_server() -> (Arc<ConnectionManager>, u16) {
        // C6: tests authenticate with a fixed token; pin it before the first
        // BridgeServer is constructed so no real token file is touched.
        static SET_TOKEN: std::sync::Once = std::sync::Once::new();
        SET_TOKEN.call_once(|| std::env::set_var("MOMO_AUTH_TOKEN", "test-token"));
        let bridge = Arc::new(crate::BridgeServer::new().expect("BridgeServer::new"));
        // Batch 4 M2: the bridge-side execute_action PolicyCheck runs on every
        // tools/call, and the default PolicyConfig is fail-closed (empty
        // allowlist). Give the test engine a permissive allowlist so
        // policy-gated MCP round-trip tests reach the fake extension; "local"
        // is the normalized host of the gate's default origin "mcp://local".
        let mut policy_config = crate::policy::PolicyConfig::default();
        policy_config.allowlist = vec!["local".to_string()];
        bridge
            .policy_engine()
            .save_config(&policy_config)
            .expect("save permissive test policy");
        let mgr = Arc::new(ConnectionManager::new(bridge));
        let app = ws_router(mgr.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("axum server");
        });
        (mgr, port)
    }

    /// Connect a real WebSocket client and wait until the server has registered
    /// the connection (the upgrade → `register` hand-off is asynchronous).
    async fn connect_client(mgr: &ConnectionManager, port: u16) -> Client {
        connect_client_expect_count(mgr, port, 1).await
    }

    /// Like `connect_client`, but waits until the server has registered a
    /// specific total number of connections (used when several clients connect).
    async fn connect_client_expect_count(mgr: &ConnectionManager, port: u16, expected: usize) -> Client {
        let (mut stream, _resp) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
            .await
            .expect("client handshake");
        // C6: authenticate before any other frame.
        let auth = serde_json::json!({ "type": "AUTH", "payload": { "token": "test-token" } });
        stream
            .send(WsMessage::Binary(serde_json::to_vec(&auth).unwrap().into()))
            .await
            .expect("AUTH send");
        let frame = read_until(&mut stream, std::time::Duration::from_secs(5), |v| {
            v["payload"]["data"]["status"] == "auth_ok"
        })
        .await
        .expect("auth_ok response");
        assert_eq!(frame["payload"]["request_id"], "auth");
        for _ in 0..200 {
            if mgr.connection_count().await == expected {
                return stream;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("connection never registered (expected count {expected})");
    }

    /// C6: without AUTH, any request is rejected with -32000 and the
    /// connection is closed by the 15 s authentication deadline.
    #[tokio::test]
    async fn unauthenticated_request_rejected() {
        let (_mgr, port) = start_server().await;
        let (mut client, _resp) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
            .await
            .expect("client handshake");

        // Note: PING is a unit variant — no "payload" field on the wire.
        let ping = serde_json::json!({ "id": "req-unauth-1", "type": "PING" });
        client
            .send(WsMessage::Binary(serde_json::to_vec(&ping).unwrap().into()))
            .await
            .unwrap();

        let frame = read_until(&mut client, std::time::Duration::from_secs(5), |v| {
            v["payload"]["code"] == -32000
        })
        .await
        .expect("not-authenticated error frame");
        assert_eq!(frame["type"], "Error");
        assert_eq!(frame["payload"]["message"], "not authenticated");

        // The connection must close once the 15 s authentication deadline fires.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            if std::time::Instant::now() >= deadline {
                panic!("connection did not close after authentication deadline");
            }
            match client.next().await {
                Some(Ok(WsMessage::Binary(_))) | Some(Ok(WsMessage::Text(_))) => continue,
                _ => break, // Close frame, EOF, or error: closed
            }
        }
    }

    /// C6: a wrong AUTH token is rejected with -32001 and the connection closes.
    #[tokio::test]
    async fn wrong_token_rejected() {
        let (_mgr, port) = start_server().await;
        let (mut client, _resp) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
            .await
            .expect("client handshake");

        let auth = serde_json::json!({ "type": "AUTH", "payload": { "token": "wrong-token" } });
        client
            .send(WsMessage::Binary(serde_json::to_vec(&auth).unwrap().into()))
            .await
            .unwrap();

        let frame = read_until(&mut client, std::time::Duration::from_secs(5), |v| {
            v["payload"]["code"] == -32001
        })
        .await
        .expect("authentication-failed error frame");
        assert_eq!(frame["type"], "Error");
        assert_eq!(frame["payload"]["request_id"], "auth");
        assert_eq!(frame["payload"]["message"], "authentication failed");

        // The connection must close promptly (read loop breaks after the error).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if std::time::Instant::now() >= deadline {
                panic!("connection did not close after bad token");
            }
            match client.next().await {
                Some(Ok(WsMessage::Binary(_))) | Some(Ok(WsMessage::Text(_))) => continue,
                _ => break, // Close frame, EOF, or error: closed
            }
        }
    }

    /// C6: a browser `Origin` other than `chrome-extension://` is rejected at
    /// the handshake (403, no upgrade).
    #[tokio::test]
    async fn origin_http_rejected() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::http::header;
        let (_mgr, port) = start_server().await;

        // Build the full client handshake request (Sec-WebSocket-Key included),
        // then inject a disallowed browser Origin.
        let mut request = format!("ws://127.0.0.1:{port}/ws")
            .into_client_request()
            .expect("client request");
        request.headers_mut().insert(
            header::ORIGIN,
            header::HeaderValue::from_static("http://evil.example"),
        );
        match tokio_tungstenite::connect_async_with_config(request, None, false).await {
            Err(e) => {
                let msg = e.to_string();
                assert!(
                    msg.contains("403") || msg.to_lowercase().contains("forbidden"),
                    "expected handshake rejection, got: {e}"
                );
            }
            Ok((_, response)) => panic!("handshake unexpectedly succeeded: {:?}", response.status()),
        }
    }

    /// C6: the pure origin predicate used by the handshake.
    #[test]
    fn origin_allowed_unit() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("chrome-extension://abcdefghijklmnop/index.html")));
        assert!(origin_allowed(Some("Chrome-Extension://abcdefghijklmnop")));
        assert!(!origin_allowed(Some("http://evil.example")));
        assert!(!origin_allowed(Some("https://evil.example")));
        assert!(!origin_allowed(Some("null")));
        assert!(!origin_allowed(Some("file:///tmp/page.html")));
    }

    /// Read frames until `pred` matches, skipping heartbeat PINGs (which the
    /// server emits immediately on connect and every 15 s). Returns the first
    /// matching frame's JSON, or `None` if `deadline` elapses first.
    async fn read_until(
        stream: &mut Client,
        deadline: std::time::Duration,
        pred: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<serde_json::Value> {
        let end = std::time::Instant::now() + deadline;
        loop {
            let now = std::time::Instant::now();
            if now >= end {
                return None;
            }
            let msg = match tokio::time::timeout(end - now, stream.next()).await {
                Ok(Some(Ok(msg))) => msg,
                _ => return None, // timeout, stream end, or frame error
            };
            match msg {
                WsMessage::Binary(bytes) => {
                    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) else { continue };
                    if v["payload"]["data"]["status"].as_str() == Some("ping") {
                        continue;
                    }
                    if pred(&v) {
                        return Some(v);
                    }
                }
                _ => {} // ignore text/pong/close frames
            }
        }
    }

    /// (a) Connected round-trip: `send_command("get_status")` must deliver a
    /// `Command` frame over the real WebSocket and resolve with the matching
    /// `CommandResult` reply — the full §6 path, not just compilation.
    #[tokio::test]
    async fn command_roundtrip_connected() {
        let (mgr, port) = start_server().await;
        let mut client = connect_client(&mgr, port).await;

        let mgr2 = mgr.clone();
        let start = std::time::Instant::now();
        let cmd = tokio::spawn(async move {
            let res = mgr2.send_command("get_status", serde_json::json!({})).await;
            (res, start.elapsed())
        });

        // The extension receives the `Command` frame and echoes back a
        // `CommandResult` (binary, exactly as the fixed extension sends it).
        let frame = read_until(&mut client, std::time::Duration::from_secs(5), |v| v["type"] == "Command")
            .await
            .expect("Command frame");
        assert_eq!(frame["payload"]["command"], "get_status");
        let request_id = frame["payload"]["request_id"].as_str().unwrap().to_string();

        let reply = serde_json::json!({
            "type": "COMMAND_RESULT",
            "payload": {
                "request_id": request_id,
                "result": { "command": "get_status", "status": "ok", "active_task": "idle" }
            }
        });
        client
            .send(WsMessage::Binary(serde_json::to_vec(&reply).unwrap().into()))
            .await
            .unwrap();

        let (res, elapsed) = cmd.await.unwrap();
        assert!(elapsed < std::time::Duration::from_secs(5), "round-trip too slow: {elapsed:?}");
        let result = res.expect("send_command should resolve Ok");
        assert_eq!(result["status"], "ok");
        assert_eq!(result["command"], "get_status");
    }

    /// (b) Disconnected fail-fast: with no extension connected, `send_command`
    /// must return `CommandError::Disconnected` immediately, not wait out the
    /// 30 s `COMMAND_TIMEOUT`.
    #[tokio::test]
    async fn command_disconnected_fails_fast() {
        let (mgr, _port) = start_server().await;
        assert_eq!(mgr.connection_count().await, 0);

        let start = std::time::Instant::now();
        let res = mgr.send_command("get_status", serde_json::json!({})).await;
        let elapsed = start.elapsed();

        assert!(matches!(res, Err(CommandError::Disconnected)), "expected Disconnected, got {res:?}");
        assert!(elapsed < std::time::Duration::from_secs(1), "fail-fast violated: took {elapsed:?}");
    }

    /// Per-connection pending-command isolation: with two connected clients, a
    /// command in flight to one of them (the target) must still resolve via
    /// that client's reply after the OTHER client disconnects — the disconnect
    /// cleanup must only wipe its own connection's pending slots.
    #[tokio::test]
    async fn disconnect_of_one_client_does_not_kill_other_commands() {
        let (mgr, port) = start_server().await;
        let mut client_a = connect_client(&mgr, port).await;
        let mut client_b = connect_client_expect_count(&mgr, port, 2).await;
        assert_eq!(mgr.connection_count().await, 2);

        let mgr2 = mgr.clone();
        let cmd = tokio::spawn(async move {
            mgr2.send_command("get_status", serde_json::json!({})).await
        });

        // `send_command` targets the first connection in the map (HashMap
        // iteration order is unspecified), so detect which client received the
        // Command frame.
        let frame_b = read_until(&mut client_b, std::time::Duration::from_secs(2), |v| v["type"] == "Command")
            .await;
        let (target, bystander, frame): (&mut Client, &mut Client, serde_json::Value) = match frame_b {
            Some(frame) => (&mut client_b, &mut client_a, frame),
            None => {
                let frame = read_until(&mut client_a, std::time::Duration::from_secs(2), |v| v["type"] == "Command")
                    .await
                    .expect("Command frame reached neither client");
                (&mut client_a, &mut client_b, frame)
            }
        };
        let request_id = frame["payload"]["request_id"].as_str().unwrap().to_string();

        // The bystander disconnects while the command is in flight. Wait until
        // the server has fully processed the close (client EOF implies the
        // read-loop cleanup, including the pending-commands cleanup, ran).
        bystander.send(WsMessage::Close(None)).await.unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            assert!(
                std::time::Instant::now() < deadline,
                "server did not close the bystander connection"
            );
            match bystander.next().await {
                Some(Ok(_)) => continue,
                _ => break, // EOF/error: server closed its side
            }
        }
        assert_eq!(mgr.connection_count().await, 1, "bystander connection should be cleaned up");

        // The target's reply must still resolve the command: the bystander's
        // disconnect must not have wiped the target's pending slot.
        let reply = serde_json::json!({
            "type": "COMMAND_RESULT",
            "payload": {
                "request_id": request_id,
                "result": { "command": "get_status", "status": "ok", "active_task": "idle" }
            }
        });
        target
            .send(WsMessage::Binary(serde_json::to_vec(&reply).unwrap().into()))
            .await
            .unwrap();

        let res = tokio::time::timeout(std::time::Duration::from_secs(5), cmd)
            .await
            .expect("command did not resolve (bystander disconnect wiped the pending slot?)");
        let result = res.unwrap().expect("send_command should resolve Ok");
        assert_eq!(result["status"], "ok");
    }

    /// Regression guard for the text/binary frame mismatch: the read loop only
    /// matches `Message::Binary`, so a TEXT frame (what the extension sent
    /// before the binary-send fix) is dropped, while the same request sent as a
    /// BINARY frame is handled. Uses `OBSERVE` (a struct variant) so the
    /// request has a real payload and no unit-variant ambiguity.
    #[tokio::test]
    async fn text_frame_dropped_binary_frame_handled() {
        let (_mgr, port) = start_server().await;
        let mut client = connect_client(&_mgr, port).await;

        let observe = serde_json::json!({ "session_id": "s", "origin": "http://example.com", "include_markdown": false, "page_revision": 0 });

        // Text frame → dropped (no response carrying this request id arrives).
        let text_req = serde_json::json!({ "id": "req-text-1", "type": "OBSERVE", "payload": observe });
        client
            .send(WsMessage::Text(serde_json::to_string(&text_req).unwrap().into()))
            .await
            .unwrap();
        let resp = read_until(&mut client, std::time::Duration::from_millis(500), |v| v["payload"]["request_id"] == "req-text-1").await;
        assert!(resp.is_none(), "text frame should be dropped, but an OBSERVE response arrived");

        // Binary frame → handled (response carrying this request id arrives).
        let bin_req = serde_json::json!({ "id": "req-bin-1", "type": "OBSERVE", "payload": observe });
        client
            .send(WsMessage::Binary(serde_json::to_vec(&bin_req).unwrap().into()))
            .await
            .unwrap();
        let frame = read_until(&mut client, std::time::Duration::from_secs(5), |v| v["payload"]["request_id"] == "req-bin-1")
            .await
            .expect("binary OBSERVE response");
        assert_eq!(frame["type"], "Ok");
    }

    /// Full MCP-layer round-trip (PHASE9 §6 + §4.3): an MCP `tools/call` flows
    /// through the stdio framing into `send_command`, the connected extension
    /// answers with a `CommandResult`, and the MCP result carries `isError:false`
    /// with the echoed tool result — the success path M2 depends on.
    #[tokio::test]
    async fn mcp_tools_call_connected_roundtrip() {
        let (mgr, port) = start_server().await;
        let mut client = connect_client(&mgr, port).await;

        let mgr2 = mgr.clone();
        let start = std::time::Instant::now();
        let call = tokio::spawn(async move {
            crate::mcp_stdio::handle_message(
                &mgr2,
                r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"read_page_content","arguments":{"tab_id":17}}}"#,
            )
            .await
        });

        // The "extension" receives the Command and echoes a CommandResult.
        let frame = read_until(&mut client, std::time::Duration::from_secs(5), |v| v["type"] == "Command")
            .await
            .expect("Command frame");
        assert_eq!(frame["payload"]["command"], "read_page_content");
        assert_eq!(frame["payload"]["params"]["tab_id"], 17, "tab_id must thread into Command params");
        let request_id = frame["payload"]["request_id"].as_str().unwrap().to_string();

        let reply = serde_json::json!({
            "type": "COMMAND_RESULT",
            "payload": {
                "request_id": request_id,
                "result": { "success": true, "title": "Example", "url": "https://example.com", "markdown_content": "# Heading\n\nBody" }
            }
        });
        client
            .send(WsMessage::Binary(serde_json::to_vec(&reply).unwrap().into()))
            .await
            .unwrap();

        let response = call.await.unwrap().expect("MCP response line");
        assert!(start.elapsed() < std::time::Duration::from_secs(5), "round-trip too slow: {:?}", start.elapsed());
        let v: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["id"], 7);
        assert_eq!(v["result"]["isError"], false);
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let embedded: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(embedded["title"], "Example");
        assert_eq!(embedded["url"], "https://example.com");
    }

    /// M4: a `tools/call execute_action` whose `CommandResult` carries
    /// `error: "stale_reference"` must map to an MCP `isError: true` result with
    /// the structured error embedded — the LLM's signal to re-fetch (§5.3).
    #[tokio::test]
    async fn mcp_tools_call_stale_reference_returns_is_error() {
        let (mgr, port) = start_server().await;
        let mut client = connect_client(&mgr, port).await;

        let mgr2 = mgr.clone();
        let call = tokio::spawn(async move {
            crate::mcp_stdio::handle_message(
                &mgr2,
                r#"{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"execute_action","arguments":{"action":"click","ref":"el_45"}}}"#,
            )
            .await
        });

        // The "extension" receives the execute_action Command and replies with a
        // stale_reference CommandResult.
        let frame = read_until(&mut client, std::time::Duration::from_secs(5), |v| v["type"] == "Command")
            .await
            .expect("Command frame");
        assert_eq!(frame["payload"]["command"], "execute_action");
        assert_eq!(frame["payload"]["params"]["ref"], "el_45");
        let request_id = frame["payload"]["request_id"].as_str().unwrap().to_string();

        let reply = serde_json::json!({
            "type": "COMMAND_RESULT",
            "payload": {
                "request_id": request_id,
                "result": {
                    "success": false,
                    "error": "stale_reference",
                    "data": { "error": "stale_reference", "ref": "el_45", "hint": "re-fetch get_interactive_elements" },
                    "summary": "execute_action click: stale reference el_45",
                    "navigationOccurred": false
                }
            }
        });
        client
            .send(WsMessage::Binary(serde_json::to_vec(&reply).unwrap().into()))
            .await
            .unwrap();

        let response = call.await.unwrap().expect("MCP response line");
        let v: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["id"], 11);
        assert_eq!(v["result"]["isError"], true);
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let embedded: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(embedded["error"], "stale_reference");
        assert_eq!(embedded["data"]["ref"], "el_45");
        assert_eq!(embedded["data"]["hint"], "re-fetch get_interactive_elements");
    }

    /// Timeout path: a connected extension that never answers a Command must
    /// resolve as `command_timeout` (isError:true) at the MCP layer — not hang,
    /// and not surface as a JSON-RPC error. 30 s by design (COMMAND_TIMEOUT), so
    /// it is `#[ignore]`d and run explicitly.
    #[tokio::test]
    #[ignore]
    async fn mcp_tools_call_timeout_returns_command_timeout() {
        let (mgr, port) = start_server().await;
        let mut client = connect_client(&mgr, port).await;

        let mgr2 = mgr.clone();
        let start = std::time::Instant::now();
        let call = tokio::spawn(async move {
            crate::mcp_stdio::handle_message(
                &mgr2,
                r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}"#,
            )
            .await
        });

        // Read the Command frame but deliberately never reply.
        let _frame = read_until(&mut client, std::time::Duration::from_secs(5), |v| v["type"] == "Command")
            .await
            .expect("Command frame");

        let response = call.await.unwrap().expect("MCP response line");
        let elapsed = start.elapsed();
        let v: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["isError"], true);
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let embedded: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(embedded["error"], "command_timeout");
        assert_eq!(embedded["command"], "list_tabs");
        assert!(elapsed >= std::time::Duration::from_secs(29), "resolved before the 30 s window: {elapsed:?}");
        assert!(elapsed < std::time::Duration::from_secs(35), "did not resolve promptly at timeout: {elapsed:?}");
    }
}