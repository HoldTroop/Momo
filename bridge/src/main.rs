use std::io::{self, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use dirs;
use md5::{Digest, Md5};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tracing::{debug, error, info, warn};

mod llm;
mod policy;
mod types;

use llm::{ChatMessage, LlmGateway, Tool};
use policy::{PolicyConfig, PolicyEngine, PolicyRequest};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "SCREAMING_SNAKE_CASE")]
enum BridgeRequest {
    // LLM Operations
    LlmComplete { model: String, messages: Vec<ChatMessage>, tools: Option<Vec<Tool>>, stream: bool },
    LlmStream { model: String, messages: Vec<ChatMessage>, tools: Option<Vec<Tool>> },

    // Input authorization (policy gate). The extension executes the authorized
    // action via chrome.debugger; the bridge never touches CDP directly.
    SimulateClick { session_id: String, origin: String, target: String, x: f64, y: f64 },
    SimulateType { session_id: String, origin: String, target: String, selector: Option<String>, text: String, field_is_sensitive: Option<bool> },
    SimulateScroll { session_id: String, origin: String, target: String, x: f64, y: f64, delta_x: f64, delta_y: f64 },
    SimulateMouseMove { session_id: String, origin: String, target: String, from_x: f64, from_y: f64, to_x: f64, to_y: f64 },

    // Policy Engine
    PolicyCheck { session_id: String, action: String, origin: String, target: String, arguments: serde_json::Value },
    PolicyGetConfig,
    PolicySetConfig { config: PolicyConfig },
    PolicyGetAuditLog { session_id: Option<String>, limit: usize },

    // Bridge Management
    Ping,
    GetStatus,
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
enum BridgeResponse {
    Ok { request_id: String, data: serde_json::Value },
    Error { request_id: String, code: i32, message: String },
    Event { event: String, data: serde_json::Value },
    StreamChunk { request_id: String, chunk: serde_json::Value },
    StreamEnd { request_id: String },
}

struct BridgeServer {
    llm_gateway: Arc<LlmGateway>,
    policy_engine: Arc<PolicyEngine>,
    request_id: Arc<RwLock<u64>>,
}

impl BridgeServer {
    fn new() -> Result<Self> {
        let db_path = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("autonomous-agent")
            .join("policy.db");

        std::fs::create_dir_all(db_path.parent().unwrap())?;

        let policy_engine = Arc::new(PolicyEngine::new(db_path)?);
        // Load any previously persisted policy config (allowlist, etc.) so a
        // restart doesn't silently reset it to the fail-closed default.
        policy_engine.load_config()?;

        Ok(Self {
            llm_gateway: Arc::new(LlmGateway::new()?),
            policy_engine,
            request_id: Arc::new(RwLock::new(0)),
        })
    }

    fn next_request_id(&self) -> String {
        let mut id = self.request_id.write();
        *id += 1;
        format!("req-{}", *id)
    }

    /// Evaluate the policy engine for an action and write the audit entry.
    /// Returns the serialized `PolicyDecision` for the caller.
    fn authorize(&self, request: PolicyRequest) -> Result<serde_json::Value> {
        let decision = self.policy_engine.evaluate(&request)?;

        let audit_entry = policy::AuditEntry {
            id: 0, // assigned by the DB
            timestamp: chrono::Utc::now(),
            session_id: request.session_id.clone(),
            action: request.action.clone(),
            origin: request.origin.clone(),
            target: request.target.clone(),
            arguments: request.arguments.clone(),
            risk_class: decision.risk_class.clone(),
            outcome: if decision.allowed {
                if decision.requires_confirmation {
                    policy::AuditOutcome::Confirmed
                } else {
                    policy::AuditOutcome::Success
                }
            } else {
                policy::AuditOutcome::Denied
            },
            action_hash: format!("{:x}", Md5::digest(serde_json::to_string(&request)?.as_bytes())),
            page_revision: 0,
            user_confirmed: false,
            error: decision.reason.clone(),
        };

        let _ = self.policy_engine.log_audit(&audit_entry);
        Ok(serde_json::to_value(decision)?)
    }

    async fn handle_request(&self, request: BridgeRequest) -> Result<BridgeResponse> {
        let request_id = self.next_request_id();

        match request {
            BridgeRequest::Ping => {
                Ok(BridgeResponse::Ok {
                    request_id,
                    data: serde_json::json!({ "status": "pong", "timestamp": chrono::Utc::now().timestamp_millis() })
                })
            }

            BridgeRequest::GetStatus => {
                Ok(BridgeResponse::Ok {
                    request_id,
                    data: serde_json::json!({
                        "llm_models": self.llm_gateway.available_models(),
                        "policy_config": self.policy_engine.get_config(),
                    })
                })
            }

            BridgeRequest::LlmComplete { model, messages, tools, stream: _stream } => {
                // Native Messaging is strictly request/response, so streaming is
                // not deliverable over this transport; return the full completion.
                let result = self.llm_gateway.complete(&model, messages, tools).await?;
                Ok(BridgeResponse::Ok { request_id, data: result })
            }

            BridgeRequest::LlmStream { model, messages, tools } => {
                let result = self.llm_gateway.complete(&model, messages, tools).await?;
                Ok(BridgeResponse::Ok { request_id, data: result })
            }

            BridgeRequest::SimulateClick { session_id, origin, target, x, y } => {
                let data = self.authorize(PolicyRequest {
                    session_id,
                    action: "human_click".to_string(),
                    origin,
                    target,
                    arguments: serde_json::json!({ "x": x, "y": y }),
                })?;
                Ok(BridgeResponse::Ok { request_id, data })
            }

            BridgeRequest::SimulateType { session_id, origin, target, selector, text, field_is_sensitive } => {
                // Redact the typed text from the policy arguments and audit log;
                // only the length is recorded so secrets never reach disk. The
                // extension resolves the focused element and reports its
                // sensitivity; absence fails closed in is_sensitive_field.
                let data = self.authorize(PolicyRequest {
                    session_id,
                    action: "human_type".to_string(),
                    origin,
                    target,
                    arguments: serde_json::json!({
                        "selector": selector,
                        "text_length": text.len(),
                        "field_is_sensitive": field_is_sensitive,
                    }),
                })?;
                Ok(BridgeResponse::Ok { request_id, data })
            }

            BridgeRequest::SimulateScroll { session_id, origin, target, x, y, delta_x, delta_y } => {
                let data = self.authorize(PolicyRequest {
                    session_id,
                    action: "scroll".to_string(),
                    origin,
                    target,
                    arguments: serde_json::json!({ "x": x, "y": y, "delta_x": delta_x, "delta_y": delta_y }),
                })?;
                Ok(BridgeResponse::Ok { request_id, data })
            }

            BridgeRequest::SimulateMouseMove { session_id, origin, target, from_x, from_y, to_x, to_y } => {
                let data = self.authorize(PolicyRequest {
                    session_id,
                    action: "mouse_move".to_string(),
                    origin,
                    target,
                    arguments: serde_json::json!({ "from_x": from_x, "from_y": from_y, "to_x": to_x, "to_y": to_y }),
                })?;
                Ok(BridgeResponse::Ok { request_id, data })
            }

            BridgeRequest::PolicyCheck { session_id, action, origin, target, arguments } => {
                let data = self.authorize(PolicyRequest { session_id, action, origin, target, arguments })?;
                Ok(BridgeResponse::Ok { request_id, data })
            }

            BridgeRequest::PolicyGetConfig => {
                let config = self.policy_engine.get_config();
                Ok(BridgeResponse::Ok {
                    request_id,
                    data: serde_json::to_value(config)?,
                })
            }

            BridgeRequest::PolicySetConfig { config } => {
                self.policy_engine.save_config(&config)?;
                Ok(BridgeResponse::Ok {
                    request_id,
                    data: serde_json::json!({ "saved": true }),
                })
            }

            BridgeRequest::PolicyGetAuditLog { session_id, limit } => {
                let entries = self.policy_engine.get_audit_log(session_id.as_deref(), limit)?;
                Ok(BridgeResponse::Ok {
                    request_id,
                    data: serde_json::to_value(entries)?,
                })
            }

            BridgeRequest::Shutdown => {
                info!("Shutdown requested");
                std::process::exit(0);
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_writer(std::io::stderr)
        .init();

    info!("Starting Autonomous AI Agent Bridge Server");

    let server = Arc::new(BridgeServer::new()?);

    // Read from stdin (Native Messaging protocol)
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut stdout = io::stdout();

    // Native Messaging: first 4 bytes = message length (little-endian)
    let mut length_buf = [0u8; 4];

    loop {
        // Read message length
        if reader.read_exact(&mut length_buf).is_err() {
            debug!("Stdin closed, exiting");
            break;
        }

        let length = u32::from_le_bytes(length_buf) as usize;
        if length > 10_000_000 { // 10MB max
            warn!("Message too large: {} bytes", length);
            break;
        }

        // Read message body
        let mut msg_buf = vec![0u8; length];
        if reader.read_exact(&mut msg_buf).is_err() {
            debug!("Failed to read message body");
            break;
        }

        let request: BridgeRequest = match serde_json::from_slice(&msg_buf) {
            Ok(req) => req,
            Err(e) => {
                error!("Failed to parse request: {}", e);
                continue;
            }
        };

        let response = server.handle_request(request).await.unwrap_or_else(|e| {
            BridgeResponse::Error {
                request_id: "unknown".to_string(),
                code: -1,
                message: e.to_string()
            }
        });

        // Write response
        let response_bytes = match serde_json::to_vec(&response) {
            Ok(bytes) => bytes,
            Err(e) => {
                error!("Failed to serialize response: {}", e);
                continue;
            }
        };

        let len_bytes = (response_bytes.len() as u32).to_le_bytes();
        if stdout.write_all(&len_bytes).is_err() || stdout.write_all(&response_bytes).is_err() {
            error!("Failed to write response");
            break;
        }
        stdout.flush().ok();
    }

    info!("Bridge server shutting down");
    Ok(())
}
