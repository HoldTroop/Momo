use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use dashmap::DashMap;
use dirs;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

mod cdp;
mod llm;
mod policy;
mod simulation;
mod types;

use cdp::CdpManager;
use llm::LlmGateway;
use policy::{PolicyEngine, PolicyRequest, PolicyConfig};
use simulation::InputExecutor;
use types::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
enum BridgeRequest {
    // CDP Operations (for extension-initiated debugger sessions)
    CdpAttach { target_id: String },
    CdpDetach { session_id: String },
    CdpCommand { session_id: String, domain: String, command: String, params: serde_json::Value },
    CdpGetTargets,

    // LLM Operations
    LlmComplete { model: String, messages: Vec<ChatMessage>, tools: Option<Vec<Tool>>, stream: bool },
    LlmStream { model: String, messages: Vec<ChatMessage>, tools: Option<Vec<Tool>> },

    // Input Execution (via CDP Input API - trusted events)
    SimulateClick { x: f64, y: f64, profile: SimulationProfile },
    SimulateType { text: String, profile: SimulationProfile },
    SimulateScroll { x: f64, y: f64, delta_x: f64, delta_y: f64, profile: SimulationProfile },
    SimulateMouseMove { from_x: f64, from_y: f64, to_x: f64, to_y: f64, profile: SimulationProfile },

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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ToolCall {
    id: String,
    function: ToolFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ToolFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Tool {
    r#type: String,
    function: ToolFunctionDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ToolFunctionDef {
    name: String,
    description: String,
    parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SimulationProfile {
    speed: f64,
    jitter: f64,
    error_rate: f64,
}

impl Default for SimulationProfile {
    fn default() -> Self {
        Self { speed: 1.0, jitter: 0.0, error_rate: 0.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CdpTarget {
    id: String,
    title: String,
    url: String,
    r#type: String,
}

struct BridgeServer {
    cdp_manager: Arc<CdpManager>,
    llm_gateway: Arc<LlmGateway>,
    input_executor: Arc<InputExecutor>,
    policy_engine: Arc<PolicyEngine>,
    active_streams: Arc<DashMap<String, mpsc::Sender<serde_json::Value>>>,
    request_id: Arc<RwLock<u64>>,
}

impl BridgeServer {
    fn new() -> Result<Self> {
        let db_path = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("autonomous-agent")
            .join("policy.db");

        std::fs::create_dir_all(db_path.parent().unwrap())?;

        Ok(Self {
            cdp_manager: Arc::new(CdpManager::new()?),
            llm_gateway: Arc::new(LlmGateway::new()?),
            input_executor: Arc::new(InputExecutor::new()?),
            policy_engine: Arc::new(PolicyEngine::new(db_path)?),
            active_streams: Arc::new(DashMap::new()),
            request_id: Arc::new(RwLock::new(0)),
        })
    }

    fn next_request_id(&self) -> String {
        let mut id = self.request_id.write();
        *id += 1;
        format!("req-{}", *id)
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
                        "cdp_sessions": self.cdp_manager.active_sessions().len(),
                        "llm_models": self.llm_gateway.available_models(),
                        "input_executor_active": self.input_executor.is_active(),
                    })
                })
            }

            BridgeRequest::CdpAttach { target_id } => {
                let session_id = self.cdp_manager.attach_target(&target_id).await?;
                Ok(BridgeResponse::Ok {
                    request_id,
                    data: serde_json::json!({ "session_id": session_id })
                })
            }

            BridgeRequest::CdpDetach { session_id } => {
                self.cdp_manager.detach_target(&session_id).await?;
                Ok(BridgeResponse::Ok { request_id, data: serde_json::json!({ "detached": true }) })
            }

            BridgeRequest::CdpCommand { session_id, domain, command, params } => {
                let result = self.cdp_manager.send_command(&session_id, &domain, &command, params).await?;
                Ok(BridgeResponse::Ok { request_id, data: result })
            }

            BridgeRequest::CdpGetTargets => {
                let targets = self.cdp_manager.get_targets().await?;
                Ok(BridgeResponse::Ok { request_id, data: serde_json::to_value(targets)? })
            }

            BridgeRequest::LlmComplete { model, messages, tools, stream } => {
                if stream {
                    let (tx, mut rx) = mpsc::channel(32);
                    let stream_id = self.next_request_id();
                    self.active_streams.insert(stream_id.clone(), tx);

                    let gateway = self.llm_gateway.clone();
                    let streams = self.active_streams.clone();
                    let model_clone = model.clone();
                    let messages_clone = messages.clone();
                    let tools_clone = tools.clone();

                    tokio::spawn(async move {
                        if let Err(e) = gateway.stream_complete(&model_clone, messages_clone, tools_clone, tx).await {
                            error!("LLM stream error: {}", e);
                        }
                        streams.remove(&stream_id);
                    });

                    Ok(BridgeResponse::Ok {
                        request_id,
                        data: serde_json::json!({ "stream_id": stream_id })
                    })
                } else {
                    let result = self.llm_gateway.complete(&model, messages, tools).await?;
                    Ok(BridgeResponse::Ok { request_id, data: result })
                }
            }

            BridgeRequest::LlmStream { model, messages, tools } => {
                let (tx, mut rx) = mpsc::channel(32);
                let stream_id = self.next_request_id();
                self.active_streams.insert(stream_id.clone(), tx);

                let gateway = self.llm_gateway.clone();
                let streams = self.active_streams.clone();
                let model_clone = model.clone();
                let messages_clone = messages.clone();
                let tools_clone = tools.clone();

                tokio::spawn(async move {
                    if let Err(e) = gateway.stream_complete(&model_clone, messages_clone, tools_clone, tx).await {
                        error!("LLM stream error: {}", e);
                    }
                    streams.remove(&stream_id);
                });

                Ok(BridgeResponse::Ok {
                    request_id,
                    data: serde_json::json!({ "stream_id": stream_id })
                })
            }

            BridgeRequest::SimulateClick { x, y, profile } => {
                self.input_executor.click(x, y, profile).await?;
                Ok(BridgeResponse::Ok { request_id, data: serde_json::json!({ "executed": true }) })
            }

            BridgeRequest::SimulateType { text, profile } => {
                self.input_executor.type_text(text, profile).await?;
                Ok(BridgeResponse::Ok { request_id, data: serde_json::json!({ "executed": true }) })
            }

            BridgeRequest::SimulateScroll { x, y, delta_x, delta_y, profile } => {
                self.input_executor.scroll(x, y, delta_x, delta_y, profile).await?;
                Ok(BridgeResponse::Ok { request_id, data: serde_json::json!({ "executed": true }) })
            }

            BridgeRequest::SimulateMouseMove { from_x, from_y, to_x, to_y, profile } => {
                self.input_executor.mouse_move(from_x, from_y, to_x, to_y, profile).await?;
                Ok(BridgeResponse::Ok { request_id, data: serde_json::json!({ "executed": true }) })
            }

            BridgeRequest::PolicyCheck { session_id, action, origin, target, arguments } => {
                let request = PolicyRequest {
                    session_id,
                    action,
                    origin,
                    target,
                    arguments,
                };
                let decision = self.policy_engine.evaluate(&request)?;

                // Log audit entry
                let audit_entry = policy::AuditEntry {
                    id: 0, // Will be assigned by DB
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
                    action_hash: format!("{:x}", md5::compute(serde_json::to_string(&request)?)),
                    page_revision: 0, // Would be provided by extension
                    user_confirmed: false,
                    error: decision.reason.clone(),
                };

                let _ = self.policy_engine.log_audit(&audit_entry);

                Ok(BridgeResponse::Ok {
                    request_id,
                    data: serde_json::to_value(decision)?,
                })
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

    async fn process_stream(&self, stream_id: String) {
        if let Some(mut tx) = self.active_streams.get_mut(&stream_id) {
            // Stream events are sent directly via the channel
            // This is handled by the spawned task in LlmComplete/LlmStream
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

    // Start CDP manager background task
    let cdp_manager = server.cdp_manager.clone();
    tokio::spawn(async move {
        if let Err(e) = cdp_manager.run().await {
            error!("CDP manager error: {}", e);
        }
    });

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