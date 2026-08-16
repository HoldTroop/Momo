// CDP Session Manager — For Extension-Initiated Debugger Sessions
// Per Architecture Blueprint Section 3.3: CDP accessed via chrome.debugger API, not raw remote-debugging port
// "If CDP is needed, access it through chrome.debugger in the extension with an explicit user-visible debugger permission rather than launching the user's normal profile with a remotely reachable debugging port."

use anyhow::{Context, Result};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, error, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpTarget {
    pub id: String,
    pub title: String,
    pub url: String,
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_socket_debugger_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CdpMessage {
    id: Option<u64>,
    method: Option<String>,
    params: Option<Value>,
    result: Option<Value>,
    error: Option<CdpError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CdpError {
    code: i32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

#[derive(Debug)]
struct CdpSession {
    target_id: String,
    ws_sender: Mutex<Option<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>>,
    pending: Arc<DashMap<u64, tokio::sync::oneshot::Sender<Value>>>,
    next_id: Arc<Mutex<u64>>,
    event_handlers: Arc<DashMap<String, Vec<tokio::sync::mpsc::Sender<Value>>>>,
}

impl CdpSession {
    fn new(target_id: String) -> Self {
        Self {
            target_id,
            ws_sender: Mutex::new(None),
            pending: Arc::new(DashMap::new()),
            next_id: Arc::new(Mutex::new(1)),
            event_handlers: Arc::new(DashMap::new()),
        }
    }

    async fn connect(&self, ws_url: &str) -> Result<()> {
        let (ws_stream, _) = connect_async(ws_url).await?;
        let mut sender = self.ws_sender.lock().await;
        *sender = Some(ws_stream);
        Ok(())
    }

    async fn send_command(&self, domain: &str, command: &str, params: Value) -> Result<Value> {
        let id = {
            let mut next_id = self.next_id.lock().await;
            let id = *next_id;
            *next_id += 1;
            id
        };

        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.insert(id, tx);

        let msg = CdpMessage {
            id: Some(id),
            method: Some(format!("{}.{}", domain, command)),
            params: Some(params),
            result: None,
            error: None,
        };

        let msg_json = serde_json::to_string(&msg)?;
        let mut sender = self.ws_sender.lock().await;
        if let Some(ws) = sender.as_mut() {
            ws.send(tokio_tungstenite::tungstenite::protocol::Message::Text(msg_json.into())).await?;
        } else {
            return Err(anyhow::anyhow!("WebSocket not connected"));
        }

        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(e)) => Err(anyhow::anyhow!("Channel error: {}", e)),
            Err(_) => {
                self.pending.remove(&id);
                Err(anyhow::anyhow!("Command timeout"))
            }
        }
    }

    async fn handle_message(&self, msg: CdpMessage) {
        if let Some(id) = msg.id {
            if let Some((_, tx)) = self.pending.remove(&id) {
                if let Some(error) = msg.error {
                    let _ = tx.send(serde_json::json!({ "error": error }));
                } else {
                    let _ = tx.send(msg.result.unwrap_or(serde_json::json!(null)));
                }
            }
        } else if let Some(method) = msg.method {
            if let Some(handlers) = self.event_handlers.get(&method) {
                for handler in handlers.iter() {
                    let _ = handler.send(msg.params.clone().unwrap_or(serde_json::json!(null))).await;
                }
            }
        }
    }

    fn on_event(&self, method: String) -> tokio::sync::mpsc::Receiver<Value> {
        let (tx, rx) = tokio::sync::mpsc::channel(32);
        self.event_handlers.entry(method).or_default().push(tx);
        rx
    }
}

pub struct CdpManager {
    sessions: Arc<DashMap<String, Arc<CdpSession>>>,
    targets: Arc<Mutex<Vec<CdpTarget>>>,
}

impl CdpManager {
    pub fn new() -> Result<Self> {
        Ok(Self {
            sessions: Arc::new(DashMap::new()),
            targets: Arc::new(Mutex::new(Vec::new())),
        })
    }

    /// Initialize with targets provided by the extension via chrome.debugger
    pub async fn initialize_targets(&self, targets: Vec<CdpTarget>) -> Result<()> {
        let mut targets_lock = self.targets.lock().await;
        *targets_lock = targets;
        Ok(())
    }

    /// Attach to a target - called by extension via Native Messaging
    /// The extension uses chrome.debugger.attach() and provides the WebSocket URL
    pub async fn attach_target(&self, target_id: &str, ws_url: &str) -> Result<String> {
        let session = Arc::new(CdpSession::new(target_id.to_string()));
        session.connect(ws_url).await?;

        let session_id = uuid::Uuid::new_v4().to_string();
        self.sessions.insert(session_id.clone(), session);

        Ok(session_id)
    }

    pub async fn detach_target(&self, session_id: &str) -> Result<()> {
        self.sessions.remove(session_id);
        Ok(())
    }

    pub async fn send_command(&self, session_id: &str, domain: &str, command: &str, params: Value) -> Result<Value> {
        let session = self.sessions.get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Session not found: {}", session_id))?;
        session.send_command(domain, command, params).await
    }

    pub async fn get_targets(&self) -> Result<Vec<CdpTarget>> {
        let targets = self.targets.lock().await;
        Ok(targets.clone())
    }

    pub fn active_sessions(&self) -> Vec<String> {
        self.sessions.iter().map(|e| e.key().clone()).collect()
    }

    /// Run background task - kept for compatibility but no longer connects to browser CDP
    pub async fn run(&self) -> Result<()> {
        info!("CDP Manager running (extension-managed sessions)");
        // Keep alive for session management
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    }
}

use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use futures::{SinkExt, StreamExt};
use url::Url;