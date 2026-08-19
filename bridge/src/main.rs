use std::io::{self, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use axum::{routing::get, Router};
use dirs;
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

mod llm;
mod mcp_stdio;
mod mcp_tools;
mod policy;
mod types;
mod ws_server;

use llm::{LlmGateway};
use policy::{PolicyConfig, PolicyEngine, PolicyRequest};
use ws_server::{ConnectionManager, ws_router};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "SCREAMING_SNAKE_CASE")]
enum BridgeRequest {
    // Input authorization (policy gate). The extension executes the authorized
    // action via chrome.debugger; the bridge never touches CDP directly.
    SimulateClick { session_id: String, origin: String, target: String, x: f64, y: f64, page_revision: u64 },
    SimulateType { session_id: String, origin: String, target: String, selector: Option<String>, text: String, field_is_sensitive: Option<bool>, page_revision: u64 },
    SimulateScroll { session_id: String, origin: String, target: String, x: f64, y: f64, delta_x: f64, delta_y: f64, page_revision: u64 },
    SimulateMouseMove { session_id: String, origin: String, target: String, from_x: f64, from_y: f64, to_x: f64, to_y: f64, page_revision: u64 },

    // Policy Engine
    PolicyCheck { session_id: String, action: String, origin: String, target: String, arguments: serde_json::Value, page_revision: u64 },
    // The extension reports the real execution outcome after the action runs so
    // the audit entry written at decision time can be corrected (MOMO-056).
    ActionResult { session_id: String, action_hash: String, outcome: String, error: Option<String> },
    PolicyGetConfig,
    PolicySetConfig { config: PolicyConfig },
    PolicyGetAuditLog { session_id: Option<String>, limit: usize },

    // Perception — read-only, no policy gate (local to extension)
    Observe { session_id: String, origin: String, include_markdown: bool, page_revision: u64 },
    Extract { session_id: String, origin: String, selector: String, schema: serde_json::Value, include_markdown: bool, page_revision: u64 },

    // Bridge Management
    Auth { token: String },
    Ping,
    GetStatus,
    Shutdown,

    // Command channel reply (extension → bridge). Sent in response to a
    // `BridgeResponse::Command` issued by the bridge; the connection manager
    // correlates it by `request_id` and never forwards it to `handle_request`
    // (PHASE9_MCP_PLAN.md §6).
    CommandResult { request_id: String, result: serde_json::Value },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
enum BridgeResponse {
    Ok { request_id: String, data: serde_json::Value },
    Error { request_id: String, code: i32, message: String },
    Event { event: String, data: serde_json::Value },
    // Bridge → extension command (PHASE9_MCP_PLAN.md §6). The bridge issues a
    // correlated request for perception/action; the extension answers with a
    // `BridgeRequest::CommandResult` carrying the same `request_id`.
    Command { request_id: String, command: String, params: serde_json::Value },
    StreamChunk { request_id: String, chunk: serde_json::Value },
    StreamEnd { request_id: String },
}

struct BridgeServer {
    llm_gateway: Arc<LlmGateway>,
    policy_engine: Arc<PolicyEngine>,
    auth_token: String,
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

        let auth_token = std::env::var("MOMO_AUTH_TOKEN")
            .ok()
            .unwrap_or_else(load_or_create_token);

        Ok(Self {
            llm_gateway: Arc::new(LlmGateway::new()?),
            policy_engine,
            auth_token,
        })
    }

    fn next_request_id(&self) -> String {
        Uuid::new_v4().to_string()
    }

    /// The bearer token the extension must present in an `Auth` frame before
    /// any other request is dispatched (C6).
    pub fn auth_token(&self) -> String {
        self.auth_token.clone()
    }

    /// Evaluate the policy engine for an action and write the audit entry.
    ///
    /// The entry records the *decision*, not the execution result: `Denied` when
    /// the policy gate refuses, `Escalated` when a human confirmation is pending,
    /// and `Pending` when the action is authorized but not yet executed. The
    /// extension later reports the real outcome via `ActionResult`, which calls
    /// `update_audit_outcome` to correct the entry (MOMO-056). Returns both the
    /// decision and the `action_hash` so the caller can correlate the follow-up.
    ///
    /// `pub(crate)` so mcp_tools can run a bridge-side PolicyCheck for
    /// `execute_action`; the rusqlite-touching parts (evaluate + log_audit)
    /// run on a `spawn_blocking` thread so blocking DB I/O never stalls a
    /// tokio worker.
    pub(crate) async fn authorize(&self, request: PolicyRequest) -> Result<serde_json::Value> {
        // Hash and audit-entry shaping are CPU-only and stay async-side; the
        // DB-touching evaluate/log_audit pair runs inside spawn_blocking.
        let action_hash = format!("{:x}", Md5::digest(serde_json::to_string(&request)?.as_bytes()));
        let entry_hash = action_hash.clone();
        let policy_engine = self.policy_engine.clone();

        let decision = tokio::task::spawn_blocking(move || {
            let decision = policy_engine.evaluate(&request)?;

            let outcome = if !decision.allowed {
                policy::AuditOutcome::Denied
            } else if decision.requires_confirmation {
                policy::AuditOutcome::Escalated
            } else {
                policy::AuditOutcome::Pending
            };

            let audit_entry = policy::AuditEntry {
                id: 0, // assigned by the DB
                timestamp: chrono::Utc::now(),
                session_id: request.session_id.clone(),
                action: request.action.clone(),
                origin: request.origin.clone(),
                target: request.target.clone(),
                arguments: request.arguments.clone(),
                risk_class: decision.risk_class.clone(),
                outcome,
                action_hash: entry_hash,
                page_revision: request.page_revision,
                user_confirmed: false,
                error: decision.reason.clone(),
            };

            policy_engine
                .log_audit(&audit_entry)
                .map_err(|e| anyhow::anyhow!("Failed to write audit log: {}", e))?;
            Ok::<_, anyhow::Error>(decision)
        })
        .await
        .map_err(|e| anyhow::anyhow!("Policy evaluation task failed: {}", e))??;

        Ok(serde_json::json!({
            "decision": decision,
            "action_hash": action_hash,
        }))
    }

    /// Accessor so mcp_tools (and tests) can reach the policy engine, e.g. to
    /// flip mcp_mode or run a bridge-side PolicyCheck.
    pub(crate) fn policy_engine(&self) -> Arc<PolicyEngine> {
        self.policy_engine.clone()
    }

    async fn handle_request(&self, request: BridgeRequest, client_id: Option<String>) -> Result<BridgeResponse> {
        let request_id = client_id.unwrap_or_else(|| self.next_request_id());

        match request {
            // AUTH is consumed by the connection manager while a connection is
            // unauthenticated; reaching this arm means the connection is already
            // authenticated, so re-auth is an idempotent success.
            BridgeRequest::Auth { .. } => {
                Ok(BridgeResponse::Ok {
                    request_id,
                    data: serde_json::json!({ "status": "auth_ok" }),
                })
            }

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

            BridgeRequest::SimulateClick { session_id, origin, target, x, y, page_revision } => {
                let data = self.authorize(PolicyRequest {
                    session_id,
                    action: "human_click".to_string(),
                    origin,
                    target,
                    arguments: serde_json::json!({ "x": x, "y": y }),
                    page_revision,
                }).await?;
                Ok(BridgeResponse::Ok { request_id, data })
            }

            BridgeRequest::SimulateType { session_id, origin, target, selector, text, field_is_sensitive, page_revision } => {
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
                    page_revision,
                }).await?;
                Ok(BridgeResponse::Ok { request_id, data })
            }

            BridgeRequest::SimulateScroll { session_id, origin, target, x, y, delta_x, delta_y, page_revision } => {
                let data = self.authorize(PolicyRequest {
                    session_id,
                    action: "scroll".to_string(),
                    origin,
                    target,
                    arguments: serde_json::json!({ "x": x, "y": y, "delta_x": delta_x, "delta_y": delta_y }),
                    page_revision,
                }).await?;
                Ok(BridgeResponse::Ok { request_id, data })
            }

            BridgeRequest::SimulateMouseMove { session_id, origin, target, from_x, from_y, to_x, to_y, page_revision } => {
                let data = self.authorize(PolicyRequest {
                    session_id,
                    action: "mouse_move".to_string(),
                    origin,
                    target,
                    arguments: serde_json::json!({ "from_x": from_x, "from_y": from_y, "to_x": to_x, "to_y": to_y }),
                    page_revision,
                }).await?;
                Ok(BridgeResponse::Ok { request_id, data })
            }

            BridgeRequest::PolicyCheck { session_id, action, origin, target, arguments, page_revision } => {
                let data = self.authorize(PolicyRequest { session_id, action, origin, target, arguments, page_revision }).await?;
                Ok(BridgeResponse::Ok { request_id, data })
            }

            BridgeRequest::ActionResult { session_id, action_hash, outcome, error } => {
                let parsed = match outcome.as_str() {
                    "success" => policy::AuditOutcome::Success,
                    // Unknown / non-success outcomes are recorded as failed so a
                    // malformed report can't inflate the audit log's success count.
                    _ => policy::AuditOutcome::Failed,
                };
                let policy_engine = self.policy_engine.clone();
                let updated = tokio::task::spawn_blocking(move || {
                    policy_engine.update_audit_outcome(&session_id, &action_hash, parsed, error)
                })
                .await
                .map_err(|e| anyhow::anyhow!("Audit outcome update task failed: {}", e))??;
                Ok(BridgeResponse::Ok {
                    request_id,
                    data: serde_json::json!({ "updated": updated }),
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
                let policy_engine = self.policy_engine.clone();
                tokio::task::spawn_blocking(move || policy_engine.save_config(&config))
                    .await
                    .map_err(|e| anyhow::anyhow!("Config save task failed: {}", e))??;
                Ok(BridgeResponse::Ok {
                    request_id,
                    data: serde_json::json!({ "saved": true }),
                })
            }

            BridgeRequest::PolicyGetAuditLog { session_id, limit } => {
                let limit = limit.min(1000);
                let policy_engine = self.policy_engine.clone();
                let entries = tokio::task::spawn_blocking(move || {
                    policy_engine.get_audit_log(session_id.as_deref(), limit)
                })
                .await
                .map_err(|e| anyhow::anyhow!("Audit log query task failed: {}", e))??;
                Ok(BridgeResponse::Ok {
                    request_id,
                    data: serde_json::to_value(entries)?,
                })
            }

            BridgeRequest::Observe { session_id, origin, include_markdown, page_revision } => {
                // Read-only perception — no policy gate, no token cost.
                // The extension captures the DOM and markdown locally; this request
                // merely acknowledges receipt and returns a correlation ID.
                let data = serde_json::json!({
                    "acknowledged": true,
                    "session_id": session_id,
                    "origin": origin,
                    "include_markdown": include_markdown,
                    "page_revision": page_revision,
                });
                Ok(BridgeResponse::Ok { request_id, data })
            }

            BridgeRequest::Extract { session_id, origin, selector, schema: _, include_markdown, page_revision } => {
                // Read-only extraction — no policy gate.
                let data = serde_json::json!({
                    "acknowledged": true,
                    "session_id": session_id,
                    "origin": origin,
                    "selector": selector,
                    "include_markdown": include_markdown,
                    "page_revision": page_revision,
                });
                Ok(BridgeResponse::Ok { request_id, data })
            }

            BridgeRequest::Shutdown => {
                info!("Shutdown requested");
                std::process::exit(0);
            }

            // Intercepted by the connection manager before reaching here; a
            // CommandResult that slips through is a programming error, not a
            // routable request.
            BridgeRequest::CommandResult { .. } => {
                warn!("CommandResult reached handle_request (should be intercepted by ws_server)");
                Ok(BridgeResponse::Error {
                    request_id,
                    code: -1,
                    message: "CommandResult must be handled by the connection manager".to_string(),
                })
            }
        }
    }
}

/// Load the bridge auth token from `~/.momo/auth_token`, creating it (0600 on
/// Unix) on first run. The token itself is never logged; only the file path is.
fn load_or_create_token() -> String {
    let path = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".momo")
        .join("auth_token");

    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }

    let token = Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if let Ok(mut file) = std::fs::File::create(&path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        use std::io::Write;
        let _ = file.write_all(token.as_bytes());
    }
    info!("Generated bridge auth token; extension side panel needs it (file: {:?})", path);
    token
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_writer(std::io::stderr)
        .init();

    info!("Starting Autonomous AI Agent Bridge Server");

    let args: Vec<String> = std::env::args().collect();
    let mcp_mode = args.iter().any(|a| a == "--mcp");
    let legacy_stdio = args.iter().any(|a| a == "--legacy-stdio");
    let port_file_override = parse_port_file(&args);

    // BridgeServer (and its PolicyEngine) is constructed identically in every
    // mode; the mode only changes what drives it (PHASE9 §3.1).
    let server = Arc::new(BridgeServer::new()?);
    if mcp_mode {
        server.policy_engine().set_mcp_mode(true);
        info!("MCP mode: execute_action deny-by-default until permitted_actions is configured");
    }
    let connection_manager = Arc::new(ConnectionManager::new(server.clone()));

    if mcp_mode {
        info!("Running in Mode B (MCP over stdio)");
        run_mcp_mode(connection_manager, port_file_override).await?;
    } else if legacy_stdio {
        info!("Running in legacy native-messaging mode (stdio)");
        run_legacy_stdio(server).await?;
    } else {
        info!("Running in Mode A (WebSocket server)");
        run_ws_mode(connection_manager, port_file_override).await?;
    }

    info!("Bridge server shutting down");
    Ok(())
}

/// Parse `--port FILE` (used by `--mcp --port FILE` for testing). Returns the
/// path that follows `--port`, if present.
fn parse_port_file(args: &[String]) -> Option<PathBuf> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--port" {
            return it.next().map(PathBuf::from);
        }
    }
    None
}

/// Bind the WebSocket listener on a fixed port in 9090-9100 (the range the
/// extension scans) and serve the router on a background task. Shared by Mode A
/// (foreground serve) and Mode B (background serve; MCP stdio foreground).
async fn start_ws_listener(
    connection_manager: Arc<ConnectionManager>,
    port_file_override: Option<PathBuf>,
) -> Result<(u16, tokio::task::JoinHandle<()>)> {
    let app = Router::new()
        .merge(ws_router(connection_manager.clone()))
        .route("/health", get(|| async { "ok" }));

    // Bind a fixed port in 9090-9100. The MV3 extension cannot read files or
    // env vars, so it discovers the bridge by scanning this range; an ephemeral
    // OS port would never be found (BUG 1).
    const FIRST_PORT: u16 = 9090;
    const LAST_PORT: u16 = 9100;

    let mut listener = None;
    for port in FIRST_PORT..=LAST_PORT {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(bound) => {
                listener = Some(bound);
                break;
            }
            Err(_) => continue,
        }
    }

    let listener = listener.ok_or_else(|| {
        anyhow::anyhow!(
            "Could not bind WebSocket listener: all ports {}-{} are in use. \
             Free one of these ports and restart the bridge.",
            FIRST_PORT,
            LAST_PORT
        )
    })?;
    let port = listener.local_addr()?.port();

    // Test-only hook: write the (fixed) port to an explicit file so the mock
    // extension harness (`tools/mock-extension.mjs`, run as `--mcp --port FILE`)
    // can learn it. The default `~/.momo/bridge_port` is gone — the extension
    // scans 9000-9100 and has no filesystem access.
    if let Some(port_file) = port_file_override {
        if let Some(parent) = port_file.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&port_file, port.to_string()).ok();
        info!("Bridge port written to {:?}", port_file);
    }

    info!("Bridge WS listening on ws://127.0.0.1:{port}/ws");
    info!("Health endpoint: http://127.0.0.1:{port}/health");

    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            error!("WS server error: {e}");
        }
    });

    Ok((port, handle))
}

/// Mode A: WebSocket server on the foreground task.
async fn run_ws_mode(
    connection_manager: Arc<ConnectionManager>,
    port_file_override: Option<PathBuf>,
) -> Result<()> {
    let (_port, handle) = start_ws_listener(connection_manager, port_file_override).await?;
    handle.await?;
    Ok(())
}

/// Mode B: WebSocket server on a background task; MCP stdio loop on the
/// foreground task. Both share the same `ConnectionManager` (PHASE9 §3.2).
async fn run_mcp_mode(
    connection_manager: Arc<ConnectionManager>,
    port_file_override: Option<PathBuf>,
) -> Result<()> {
    let (port, _ws_handle) =
        start_ws_listener(connection_manager.clone(), port_file_override).await?;
    info!("Mode B: WS server on port {port}; MCP stdio on stdin/stdout");
    mcp_stdio::run(connection_manager).await?;
    Ok(())
}

async fn run_legacy_stdio(server: Arc<BridgeServer>) -> Result<()> {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = io::stdout();
    let mut out = stdout.lock();

    // Write one native-messaging frame: 4-byte LE length prefix + JSON body.
    // Returns Ok(()) once the frame is flushed, Err(..) if serialization or
    // the write failed.
    let mut send = |response: &BridgeResponse| -> io::Result<()> {
        let bytes = serde_json::to_vec(response).map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("failed to serialize response: {}", e),
            )
        })?;
        let len_bytes = (bytes.len() as u32).to_le_bytes();
        out.write_all(&len_bytes)?;
        out.write_all(&bytes)?;
        out.flush()
    };

    let mut length_buf = [0u8; 4];

    loop {
        if reader.read_exact(&mut length_buf).is_err() {
            debug!("Stdin closed, exiting");
            break;
        }

        let length = u32::from_le_bytes(length_buf) as usize;
        if length > 10_000_000 {
            warn!("Message too large: {} bytes; replying with error and draining", length);
            let err_resp = BridgeResponse::Error {
                request_id: Uuid::new_v4().to_string(),
                code: -32600,
                message: "Message too large".to_string(),
            };
            if send(&err_resp).is_err() {
                error!("Failed to write oversize error response");
                break;
            }
            // Drain the declared byte count so the stream stays aligned; the
            // discard buffer is capped at the same 10 MB limit so a bogus
            // length header cannot force a huge allocation.
            let mut remaining = length;
            let mut sink = vec![0u8; remaining.min(10_000_000)];
            let mut drained = true;
            while remaining > 0 {
                let want = remaining.min(sink.len());
                if reader.read_exact(&mut sink[..want]).is_err() {
                    error!("Failed to drain oversized message; stream broken");
                    drained = false;
                    break;
                }
                remaining -= want;
            }
            if !drained {
                break;
            }
            continue;
        }

        let mut msg_buf = vec![0u8; length];
        if reader.read_exact(&mut msg_buf).is_err() {
            debug!("Failed to read message body");
            break;
        }

        let request: BridgeRequest = match serde_json::from_slice(&msg_buf) {
            Ok(req) => req,
            Err(e) => {
                error!("Failed to parse request: {}", e);
                // Reply so the client doesn't hang waiting for a response
                // (the request_id is unrecoverable from malformed JSON).
                let err_resp = BridgeResponse::Error {
                    request_id: Uuid::new_v4().to_string(),
                    code: -32700,
                    message: format!("Failed to parse request: {}", e),
                };
                if send(&err_resp).is_err() {
                    error!("Failed to write parse error response");
                    break;
                }
                continue;
            }
        };

        let response = server.handle_request(request, None).await.unwrap_or_else(|e| {
            BridgeResponse::Error {
                request_id: Uuid::new_v4().to_string(),
                code: -1,
                message: e.to_string(),
            }
        });

        if let Err(e) = send(&response) {
            // Serialization failure must still produce a reply so the client
            // doesn't hang; a write failure means the stream is broken.
            error!("Response send failed: {}", e);
            let err_resp = BridgeResponse::Error {
                request_id: Uuid::new_v4().to_string(),
                code: -1,
                message: e.to_string(),
            };
            if send(&err_resp).is_err() {
                error!("Failed to write serialization error response");
                break;
            }
            continue;
        }
    }

    Ok(())
}
