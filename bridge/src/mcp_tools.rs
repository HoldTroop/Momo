//! MCP tool surface: static tool schemas plus the `tools/call` dispatcher.
//!
//! Every Phase 9 tool is a bridge→extension Command round-trip (PHASE9 §6.2):
//! the bridge issues a correlated `BridgeResponse::Command`, the extension
//! executes and replies with `BridgeRequest::CommandResult`. This module owns
//! the translation from an MCP `tools/call` into that round-trip and back into
//! the MCP result shape (§4.3). Tool *implementations* live in the extension
//! (M3/M4); here we define only the contract and the error mapping.

use serde_json::{json, Value};

use crate::ws_server::{CommandError, ConnectionManager};

/// MCP protocol version we implement. Per §4.4 we always return the version we
/// support and never hard-fail on an unfamiliar client version.
const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "momo-mcp-server";

/// The four Phase 9 tools (v1). `execute_action` re-enters the orchestrator's
/// single click/type/scroll/navigate path; the other three are read-only.
pub const TOOL_NAMES: [&str; 4] = [
    "read_page_content",
    "get_interactive_elements",
    "execute_action",
    "list_tabs",
];

/// The `initialize` result (MCP 2024-11-05, §4.4). Only `tools` is advertised;
/// resources/prompts are out of scope in v1.
pub fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": SERVER_NAME,
            // Tracks the crate version (agent-bridge) so it bumps automatically.
            "version": env!("CARGO_PKG_VERSION"),
        }
    })
}

/// The `tools/list` result: the four static schemas (§5).
pub fn tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "read_page_content",
                "description": "Read the current page as token-efficient Markdown. Returns title, url, and markdown_content for summarization and Q&A. Read-only; no action is taken.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tab_id": {
                            "type": "integer",
                            "description": "Target tab id; omit for the active tab."
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "get_interactive_elements",
                "description": "Return a pruned accessibility tree of visible + interactive elements (role, label, state, bounds, stable ref el_XX). Use this to decide what to click; do NOT target raw CSS selectors.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tab_id": {
                            "type": "integer",
                            "description": "Target tab id; omit for the active tab."
                        }
                    },
                    "additionalProperties": false
                }
            },
            {
                "name": "execute_action",
                "description": "Execute one action against a stable element ref (el_XX) from get_interactive_elements: click, type, scroll, or navigate. ref is the only targeting key; raw CSS selectors are rejected.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["click", "type", "scroll", "navigate"],
                            "description": "The action to perform."
                        },
                        "ref": {
                            "type": "string",
                            "description": "Stable el_XX id from get_interactive_elements (required for click/scroll; with text for type)."
                        },
                        "text": {
                            "type": "string",
                            "description": "Text to type (action=type only)."
                        },
                        "url": {
                            "type": "string",
                            "format": "uri",
                            "description": "URL to navigate to (action=navigate only)."
                        },
                        "tab_id": {
                            "type": "integer",
                            "description": "Target tab id; omit for the active tab."
                        }
                    },
                    "required": ["action"],
                    "additionalProperties": false
                }
            },
            {
                "name": "list_tabs",
                "description": "Enumerate the browser's tabs (tab_id, window_id, active, title, url) so page-scoped tools can target a specific tab.",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            }
        ]
    })
}

pub fn is_known_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// Handle a `tools/call` request: validate the tool name and delegate to the
/// command-channel round-trip. Returns either the MCP result object (§4.3) or a
/// JSON-RPC `-32602 Invalid params` for a malformed/unknown tool.
pub async fn handle_tools_call(
    cm: &ConnectionManager,
    params: Option<&Value>,
) -> Result<Value, (i64, String)> {
    let obj = params
        .and_then(|p| p.as_object())
        .ok_or((-32602, "Invalid params: expected an object".to_string()))?;

    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or((-32602, "Invalid params: missing tool name".to_string()))?;

    let arguments = obj.get("arguments").cloned().unwrap_or_else(|| json!({}));

    if !is_known_tool(name) {
        return Err((-32602, format!("Unknown tool: {name}")));
    }

    Ok(dispatch_tool_call(cm, name, arguments).await)
}

/// Translate a tool call into a bridge→extension Command round-trip and map the
/// outcome to the MCP result shape. All four v1 tools are Commands (§6.2).
async fn dispatch_tool_call(cm: &ConnectionManager, name: &str, arguments: Value) -> Value {
    match cm.send_command(name, arguments).await {
        Ok(result) => map_command_result(&result),
        Err(CommandError::Disconnected) => {
            tool_error(&json!({ "error": "bridge_disconnected", "command": name }))
        }
        Err(CommandError::Timeout) => {
            tool_error(&json!({ "error": "command_timeout", "command": name }))
        }
    }
}

/// Map a *transport-successful* `CommandResult` to the MCP result shape. Any
/// tool-layer *semantic failure* — an explicit `success: false` ToolResult (a
/// `stale_reference`, a missing ref, a CDP session being unavailable, …) or a
/// bare `{ error: … }` object from an early guard / thrown dispatch error —
/// must surface as `isError: true` so the LLM sees the execution failure and
/// reacts instead of hallucinating success (§5.3, §6.4). Every other payload is
/// a success.
fn map_command_result(result: &Value) -> Value {
    let success = result.get("success").and_then(Value::as_bool);
    let has_error = result.get("error").is_some();
    // Fail when the tool explicitly reported `success: false`, or when it
    // returned a bare error object with no `success` field (early guard like
    // "No active session", or a thrown dispatch error).
    let failed = success == Some(false) || (success.is_none() && has_error);
    if failed {
        tool_error(result)
    } else {
        tool_ok(result)
    }
}

/// Success: wrap the extension's result as a single text block (§4.3).
fn tool_ok(result: &Value) -> Value {
    let text = serde_json::to_string(result).unwrap_or_else(|_| result.to_string());
    json!({ "content": [ { "type": "text", "text": text } ], "isError": false })
}

/// Tool-level error: `isError: true` with the structured error JSON embedded in
/// the text. Timeouts/disconnects are recoverable tool outcomes, not protocol
/// failures (§4.3, §6.4).
fn tool_error(data: &Value) -> Value {
    let text = serde_json::to_string(data).unwrap_or_else(|_| data.to_string());
    json!({ "content": [ { "type": "text", "text": text } ], "isError": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_list_has_four_schemas() {
        let v = tools_list();
        let tools = v["tools"].as_array().expect("tools is an array");
        assert_eq!(tools.len(), 4);

        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            vec![
                "read_page_content",
                "get_interactive_elements",
                "execute_action",
                "list_tabs"
            ]
        );

        for t in tools {
            assert!(t.get("description").is_some(), "{} missing description", t["name"]);
            let schema = &t["inputSchema"];
            assert_eq!(schema["type"], "object", "{} schema type", t["name"]);
            assert_eq!(
                schema["additionalProperties"], false,
                "{} must be additionalProperties:false",
                t["name"]
            );
        }

        // execute_action requires "action" and nothing else.
        let execute = tools
            .iter()
            .find(|t| t["name"] == "execute_action")
            .expect("execute_action present");
        assert_eq!(execute["inputSchema"]["required"], json!(["action"]));
        let action_enum = &execute["inputSchema"]["properties"]["action"]["enum"];
        assert_eq!(action_enum, &json!(["click", "type", "scroll", "navigate"]));
    }

    #[test]
    fn stale_reference_maps_to_is_error_true() {
        // The shape the extension's execute_action tool returns when strict ref
        // resolution fails (ToolResult with error: "stale_reference").
        let stale = json!({
            "success": false,
            "error": "stale_reference",
            "data": { "error": "stale_reference", "ref": "el_45", "hint": "re-fetch get_interactive_elements" },
            "summary": "execute_action click: stale reference el_45",
            "navigationOccurred": false
        });
        let out = map_command_result(&stale);
        assert_eq!(out["isError"], true);
        let text = out["content"][0]["text"].as_str().unwrap();
        let embedded: Value = serde_json::from_str(text).unwrap();
        assert_eq!(embedded["error"], "stale_reference");
        assert_eq!(embedded["data"]["ref"], "el_45");
        assert_eq!(embedded["data"]["hint"], "re-fetch get_interactive_elements");
    }

    #[test]
    fn success_payload_maps_to_is_error_false() {
        let ok = json!({
            "success": true,
            "data": { "ref": "el_1", "x": 10, "y": 20 },
            "summary": "Clicked ref el_1",
            "navigationOccurred": false
        });
        let out = map_command_result(&ok);
        assert_eq!(out["isError"], false);
    }

    #[test]
    fn any_semantic_failure_maps_to_is_error_true() {
        // M4 broadening: NOT just stale_reference — any `success: false`
        // ToolResult (missing ref, CDP session unavailable, …) must surface as
        // `isError: true` so the LLM sees the execution failure instead of
        // hallucinating success.
        let missing_ref = json!({ "success": false, "error": "Missing ref for click", "summary": "execute_action click: missing ref" });
        let out = map_command_result(&missing_ref);
        assert_eq!(out["isError"], true);
        let text = out["content"][0]["text"].as_str().unwrap();
        let embedded: Value = serde_json::from_str(text).unwrap();
        assert_eq!(embedded["error"], "Missing ref for click");
    }

    #[test]
    fn bare_error_object_maps_to_is_error_true() {
        // Early guards (e.g. "No active session") and thrown dispatch errors
        // come back as a plain `{ error: … }` object with no `success` field;
        // treat those as failures too.
        let bare = json!({ "error": "No active session" });
        let out = map_command_result(&bare);
        assert_eq!(out["isError"], true);
    }
}
