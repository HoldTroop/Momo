//! Mode B: MCP over stdio (newline-delimited JSON-RPC 2.0).
//!
//! Distinct from `run_legacy_stdio` (Chrome native-messaging 4-byte length
//! prefix) — MCP uses NDJSON (PHASE9 §4.1). stdout carries ONLY JSON-RPC
//! frames; all diagnostics go to stderr so the MCP client's parser is never
//! corrupted (§4.4).

use std::io::{self, BufRead, Read, Write};
use std::sync::Arc;

use anyhow::Result;
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::{debug, error, info, warn};

use crate::mcp_tools;
use crate::ws_server::ConnectionManager;

/// One JSON-RPC 2.0 message. `id` absent (or null) marks a notification, which
/// must never produce a response; a missing `method` is an Invalid Request.
#[derive(Deserialize)]
struct JsonRpcMessage {
    #[serde(default)]
    jsonrpc: Option<String>,
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Option<Value>,
}

/// Maximum accepted NDJSON line size (1 MiB). A longer line without a newline
/// is a protocol error: it is dropped and the rest of the line is drained so a
/// hostile client cannot grow the read buffer without bound.
const MAX_LINE_BYTES: usize = 1_048_576;

/// Run the MCP stdio loop until stdin closes. This is the Mode B foreground
/// task; the WebSocket server runs on a separate background task (spawned by
/// `main`), and both share the same `ConnectionManager` (§3.2).
pub async fn run(connection_manager: Arc<ConnectionManager>) -> Result<()> {
    info!("MCP stdio loop started (NDJSON JSON-RPC 2.0)");
    let stdin = io::stdin();
    let mut reader = io::BufReader::new(stdin.lock());
    let stdout = io::stdout();
    let mut out = stdout.lock();

    loop {
        // `take` makes the reader report EOF after MAX_LINE_BYTES + 1 bytes,
        // so `read_until` cannot grow `line` past the cap even if the newline
        // never arrives.
        let mut line: Vec<u8> = Vec::new();
        let n = {
            let mut limited = (&mut reader).take(MAX_LINE_BYTES as u64 + 1);
            limited.read_until(b'\n', &mut line)?
        };
        if n == 0 {
            debug!("stdin closed, exiting MCP loop");
            break;
        }

        if line.len() > MAX_LINE_BYTES && !line.ends_with(b"\n") {
            // Hit the cap without a newline: protocol error. Drop the rest of
            // the line (bounded memory) and keep reading.
            warn!(
                "MCP line exceeds {} bytes without a newline; dropping it",
                MAX_LINE_BYTES
            );
            loop {
                let buf = reader.fill_buf()?;
                if buf.is_empty() {
                    break; // EOF
                }
                match buf.iter().position(|&b| b == b'\n') {
                    Some(pos) => {
                        reader.consume(pos + 1);
                        break;
                    }
                    None => {
                        let len = buf.len();
                        reader.consume(len);
                    }
                }
            }
            continue;
        }

        let line = String::from_utf8_lossy(&line);
        if let Some(response) = handle_message(&connection_manager, &line).await {
            out.write_all(response.as_bytes())?;
            out.write_all(b"\n")?;
            out.flush()?;
        }
    }

    Ok(())
}

/// Process a single NDJSON line (one JSON-RPC message) and return the optional
/// response line (no trailing newline). Returns `None` for empty input and for
/// notifications (which never produce a reply). Exposed for direct unit testing
/// of the framing without a real stdio pipe.
pub async fn handle_message(
    connection_manager: &ConnectionManager,
    line: &str,
) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let msg: JsonRpcMessage = match serde_json::from_str(trimmed) {
        Ok(m) => m,
        Err(e) => {
            error!("MCP parse error: {}", e);
            return Some(error_response(&Value::Null, -32700, "Parse error"));
        }
    };

    // A missing/empty method is an Invalid Request. Only reply if it carried an
    // id (a malformed notification is dropped, per JSON-RPC).
    let method = match msg.method.as_deref().filter(|m| !m.is_empty()) {
        Some(m) => m,
        None => {
            return msg
                .id
                .as_ref()
                .map(|id| error_response(id, -32600, "Invalid Request"));
        }
    };

    // If a jsonrpc version was supplied it must be "2.0".
    if let Some(v) = msg.jsonrpc.as_deref() {
        if v != "2.0" {
            return msg
                .id
                .as_ref()
                .map(|id| error_response(id, -32600, "Invalid Request"));
        }
    }

    match method {
        "initialize" => msg
            .id
            .as_ref()
            .map(|id| result_response(id, mcp_tools::initialize_result())),

        "ping" => msg.id.as_ref().map(|id| result_response(id, json!({}))),

        "tools/list" => msg
            .id
            .as_ref()
            .map(|id| result_response(id, mcp_tools::tools_list())),

        "tools/call" => {
            let id = msg.id.as_ref()?; // no id → notification, ignore
            let outcome =
                mcp_tools::handle_tools_call(connection_manager, msg.params.as_ref()).await;
            match outcome {
                Ok(result) => Some(result_response(id, result)),
                Err((code, message)) => Some(error_response(id, code, &message)),
            }
        }

        // Notifications (§4.4): accepted, never answered.
        "notifications/initialized" => {
            debug!("MCP client sent notifications/initialized");
            None
        }
        "notifications/cancelled" => {
            // Best-effort (§4.4 rule 3): the M2 stdio loop is synchronous, so an
            // in-flight tools/call cannot be observed here. Accepted and logged;
            // concurrent cancellation lands with concurrent tool execution.
            debug!("MCP client sent notifications/cancelled: {:?}", msg.params);
            None
        }

        _ => msg
            .id
            .as_ref()
            .map(|id| error_response(id, -32601, "Method not found")),
    }
}

fn result_response(id: &Value, result: Value) -> String {
    serde_json::to_string(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
        .expect("serialize response")
}

fn error_response(id: &Value, code: i64, message: &str) -> String {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    }))
    .expect("serialize error response")
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_manager() -> Arc<ConnectionManager> {
        let bridge = Arc::new(crate::BridgeServer::new().expect("BridgeServer::new"));
        Arc::new(ConnectionManager::new(bridge))
    }

    fn parse(line: &str) -> Value {
        serde_json::from_str(line).expect("valid JSON response line")
    }

    #[tokio::test]
    async fn initialize_handshake() {
        let cm = test_manager().await;
        let resp = handle_message(
            &cm,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"claude-code","version":"1"}}}"#,
        )
        .await
        .expect("initialize produces a response");
        let v = parse(&resp);
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["protocolVersion"], "2024-11-05");
        assert!(v["result"]["capabilities"]["tools"].is_object());
        assert_eq!(v["result"]["serverInfo"]["name"], "momo-mcp-server");
        assert!(v["result"]["serverInfo"]["version"].is_string());
    }

    #[tokio::test]
    async fn ping_returns_empty_result() {
        let cm = test_manager().await;
        let resp = handle_message(&cm, r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#)
            .await
            .expect("ping response");
        let v = parse(&resp);
        assert_eq!(v["id"], 2);
        assert_eq!(v["result"], json!({}));
    }

    #[tokio::test]
    async fn notification_produces_no_response() {
        let cm = test_manager().await;
        assert!(
            handle_message(&cm, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
                .await
                .is_none()
        );
        assert!(
            handle_message(
                &cm,
                r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9,"reason":"user"}}"#
            )
            .await
            .is_none()
        );
    }

    #[tokio::test]
    async fn malformed_json_returns_parse_error() {
        let cm = test_manager().await;
        let resp = handle_message(&cm, "{not valid json").await.expect("parse error response");
        let v = parse(&resp);
        assert_eq!(v["id"], Value::Null);
        assert_eq!(v["error"]["code"], -32700);
    }

    #[tokio::test]
    async fn unknown_method_returns_method_not_found_and_echoes_string_id() {
        let cm = test_manager().await;
        let resp = handle_message(&cm, r#"{"jsonrpc":"2.0","id":"abc","method":"bogus/method","params":{}}"#)
            .await
            .expect("method-not-found response");
        let v = parse(&resp);
        assert_eq!(v["id"], "abc", "string id must be echoed exactly");
        assert_eq!(v["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn tools_call_without_extension_returns_bridge_disconnected() {
        let cm = test_manager().await; // no extension connected
        assert_eq!(cm.connection_count().await, 0);
        let resp = handle_message(
            &cm,
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}"#,
        )
        .await
        .expect("tools/call response");
        let v = parse(&resp);
        assert_eq!(v["id"], 7);
        assert_eq!(v["result"]["isError"], true);
        assert_eq!(v["result"]["content"][0]["type"], "text");
        let embedded: Value = serde_json::from_str(v["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(embedded["error"], "bridge_disconnected");
        assert_eq!(embedded["command"], "list_tabs");
    }

    #[tokio::test]
    async fn tools_call_unknown_tool_returns_invalid_params() {
        let cm = test_manager().await;
        let resp = handle_message(
            &cm,
            r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"do_evil","arguments":{}}}"#,
        )
        .await
        .expect("invalid-params response");
        let v = parse(&resp);
        assert_eq!(v["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn multibyte_utf8_roundtrip_single_line() {
        let cm = test_manager().await;
        let line = r#"{"jsonrpc":"2.0","id":"m-1","method":"initialize","params":{"clientInfo":{"name":"モモ","version":"1.0"}}}"#;
        let resp = handle_message(&cm, line).await.expect("initialize response");
        assert!(
            !resp.contains('\n'),
            "NDJSON response must be a single line"
        );
        let v = parse(&resp);
        assert_eq!(v["id"], "m-1");
        assert_eq!(v["result"]["protocolVersion"], "2024-11-05");
    }
}
