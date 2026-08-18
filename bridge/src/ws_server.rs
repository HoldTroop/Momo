use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
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
    sender: mpsc::UnboundedSender<BridgeResponse>,
    session_id: Option<String>,
    last_pong: Instant,
}

/// Manages all active WebSocket connections.
pub struct ConnectionManager {
    connections: Arc<RwLock<HashMap<Uuid, WsConnection>>>,
    bridge_server: Arc<BridgeServer>,
    /// In-flight bridge→extension commands, keyed by the `request_id` the bridge
    /// generated when issuing the `Command`. The read loop resolves the matching
    /// entry when the extension replies with `CommandResult`.
    pending_commands: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>>,
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
        let (tx, mut rx) = mpsc::unbounded_channel::<BridgeResponse>();

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

        // Write loop: drain the response channel and send frames
        let write_loop = tokio::spawn(async move {
            while let Some(response) = rx.recv().await {
                let bytes = match serde_json::to_vec(&response) {
                    Ok(b) => b,
                    Err(e) => {
                        error!("Failed to serialize WS response: {}", e);
                        continue;
                    }
                };
                if ws_sender.send(Message::Binary(bytes.into())).await.is_err() {
                    debug!("WS write error (connection likely closed): {}", conn_id);
                    break;
                }
            }
            debug!("WS write loop ended: {}", conn_id);
        });

        // Read loop: parse frames, dispatch to bridge, send responses
        let read_loop = tokio::spawn(async move {
            while let Some(msg) = ws_receiver.next().await {
                match msg {
                    Ok(Message::Binary(data)) => {
                        let request: BridgeRequest = match serde_json::from_slice(&data) {
                            Ok(r) => r,
                            Err(e) => {
                                warn!("WS invalid JSON from {}: {}", conn_id, e);
                                continue;
                            }
                        };

                        // A CommandResult resolves an in-flight bridge→extension
                        // command and expects no response back (PHASE9 §6).
                        if let BridgeRequest::CommandResult { request_id, result } = &request {
                            if let Some(tx) = pending_commands.lock().await.remove(request_id) {
                                let _ = tx.send(result.clone());
                            } else {
                                warn!("CommandResult with no pending command: {}", request_id);
                            }
                            continue;
                        }

                        // Update session_id on first PolicyCheck/Simulate* if not set
                        if connections.read().await.get(&conn_id).map(|c| c.session_id.is_none()).unwrap_or(false) {
                            if let Some(sid) = extract_session_id(&request) {
                                if let Some(conn) = connections.write().await.get_mut(&conn_id) {
                                    conn.session_id = Some(sid);
                                }
                            }
                        }

                        // Handle via bridge server
                        let client_id = serde_json::from_slice::<serde_json::Value>(&data)
                            .ok()
                            .and_then(|v| v.get("id").and_then(|id| id.as_str()).map(String::from));
                        let response = bridge_server.handle_request(request, client_id).await.unwrap_or_else(|e| {
                            BridgeResponse::Error {
                                request_id: "unknown".to_string(),
                                code: -1,
                                message: e.to_string(),
                            }
                        });

                        // Update last_pong on PING/PONG
                        if let BridgeResponse::Ok { data, .. } = &response {
                            if data.get("status").and_then(|v| v.as_str()) == Some("pong") {
                                if let Some(conn) = connections.write().await.get_mut(&conn_id) {
                                    conn.last_pong = Instant::now();
                                }
                            }
                        }

                        if connections.read().await.get(&conn_id).is_some() {
                            if let Some(conn) = connections.write().await.get_mut(&conn_id) {
                                let _ = conn.sender.send(response);
                            }
                        }
                    }
                    Ok(Message::Pong(_)) => {
                        if let Some(conn) = connections.write().await.get_mut(&conn_id) {
                            conn.last_pong = Instant::now();
                        }
                    }
                    Ok(Message::Close(_)) => {
                        info!("WS close frame from {}", conn_id);
                        break;
                    }
                    Err(e) => {
                        warn!("WS read error {}: {}", conn_id, e);
                        break;
                    }
                    _ => {}
                }
            }

            // Cleanup on disconnect
            connections.write().await.remove(&conn_id);
            // Fail all in-flight commands: dropping the oneshot Sender makes the
            // awaiting `send_command` resolve as Disconnected rather than hang
            // until the timeout (single-connection model, PHASE9 §6.4).
            pending_commands.lock().await.clear();
            info!("WS connection closed: {} (remaining: {})", conn_id, connections.read().await.len());
        });

        // Heartbeat task: send PING every 15s, expect PONG within 5s
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
                        if conn.sender.send(ping).is_err() {
                            true // channel closed
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
                    break;
                }
            }
        });

        // Wait for both loops to finish (they run until disconnect)
        tokio::select! {
            _ = write_loop => {}
            _ = read_loop => {}
        }
    }

    /// Broadcast an event to all connected clients.
    pub async fn broadcast(&self, event: BridgeResponse) {
        let conns = self.connections.read().await;
        for conn in conns.values() {
            let _ = conn.sender.send(event.clone());
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
    /// slot in the pending registry.
    pub async fn send_command(
        &self,
        command: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, CommandError> {
        // Fail fast when nothing is connected (avoids a pointless 30 s wait).
        if self.connections.read().await.is_empty() {
            return Err(CommandError::Disconnected);
        }

        let request_id = self.bridge_server.next_request_id();
        let (tx, rx) = oneshot::channel::<serde_json::Value>();
        self.pending_commands.lock().await.insert(request_id.clone(), tx);

        let message = BridgeResponse::Command {
            request_id: request_id.clone(),
            command: command.to_string(),
            params,
        };

        // Broadcast to every connected extension; the first matching
        // CommandResult wins (in practice there is a single extension).
        let mut sent = false;
        {
            let conns = self.connections.read().await;
            for conn in conns.values() {
                if conn.sender.send(message.clone()).is_ok() {
                    sent = true;
                }
            }
        }
        if !sent {
            self.pending_commands.lock().await.remove(&request_id);
            return Err(CommandError::Disconnected);
        }

        match timeout(command_timeout(), rx).await {
            Ok(Ok(result)) => Ok(result),
            // Sender dropped (connection closed and cleaned up) → treat as a
            // disconnect, not a silent hang.
            Ok(Err(_)) => Err(CommandError::Disconnected),
            Err(_) => {
                self.pending_commands.lock().await.remove(&request_id);
                Err(CommandError::Timeout)
            }
        }
    }

    /// Get the number of active connections.
    pub async fn connection_count(&self) -> usize {
        self.connections.read().await.len()
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

/// Axum handler for WebSocket upgrade.
pub async fn ws_handler(ws: WebSocketUpgrade, manager: axum::Extension<Arc<ConnectionManager>>) -> Response {
    let manager = manager.0;
    ws.on_upgrade(move |socket| {
        let mgr = manager.clone();
        async move { mgr.register(socket).await }
    })
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
        let bridge = Arc::new(crate::BridgeServer::new().expect("BridgeServer::new"));
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
        let (stream, _resp) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
            .await
            .expect("client handshake");
        for _ in 0..200 {
            if mgr.connection_count().await == 1 {
                return stream;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("connection never registered");
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
                "result": { "title": "Example", "url": "https://example.com", "markdown_content": "# Heading\n\nBody" }
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