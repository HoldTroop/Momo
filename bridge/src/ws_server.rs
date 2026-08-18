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
use tokio::sync::{mpsc, RwLock};
use tokio::time::interval;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::{BridgeRequest, BridgeResponse, BridgeServer};

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
}

impl ConnectionManager {
    pub fn new(bridge_server: Arc<BridgeServer>) -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            bridge_server,
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