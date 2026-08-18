# PHASE 9 — MCP (Model Context Protocol) Integration + Hybrid Perception Layer

**Status:** DRAFT — awaiting architectural approval
**Author:** Systems Architect
**Scope:** Rust bridge dual-mode, MCP stdio transport, hybrid perception tools, stale-reference recovery, trust boundary
**Non-Goal:** No implementation code is written in this phase. This document is the execution plan.

---

## 0. Executive Summary

Momo today is a **closed ecosystem**: the Chrome extension (a "dumb bridge" over WebSocket) is only ever driven by the Rust bridge's *internal* orchestrator + policy engine + LLM gateway (Mode A). Phase 9 opens it up by giving the Rust binary a second operating mode (Mode B) that speaks the **Model Context Protocol (MCP) over stdio**, letting any MCP client — Claude Code, Cursor, a custom agent — control the same browser extension through the same WebSocket.

The design has four load-bearing pillars:

1. **One extension, unchanged in spirit.** The extension stays a dumb bridge. No second build, no embedded brain, no fork. It gains *minimal, additive* surface: a new pruned-AXTree perception function, strict ref-ID resolution with `stale_reference` errors, and a bridge→extension command handler. Everything else is reused verbatim.

2. **Dual-mode Rust binary.** `--mcp` flips the server from "orchestrate internally" to "expose MCP tools that translate into the existing `BridgeRequest` wire protocol."

3. **Hybrid perception.** `read_page_content` (Markdown for comprehension) and `get_interactive_elements` (pruned interactive AXTree for action) are *separate tools* because they answer *different questions*. Neither is the full AXTree; neither relies on raw CSS selectors for action.

4. **Fail-closed trust.** MCP mode does **not** bypass the existing `PolicyEngine`. Origin allowlist, permitted-actions, confirmation policy, and the audit log remain the enforcement boundary. MCP is a *translation layer*, not a new trust domain.

---

## 1. Current-State Architecture (Ground Truth)

The analysis below is derived from the actual code, not assumptions. File references are relative to the repo root.

### 1.1 The extension (`src/`, TypeScript, MV3)

| Layer | Files | Role |
|---|---|---|
| Service worker | `src/sw/orchestrator.ts`, `src/sw/message-router.ts`, `src/sw/cdp-adapter.ts`, `src/sw/ws-client.ts` | Orchestration, message routing, CDP execution, WebSocket client |
| Content scripts | `src/content/perception.ts`, `src/content/ax-extractor.ts`, `src/content/human-input.ts`, `src/content/dom-observer.ts` | DOM/AXTree perception, trusted-input fallback, DOM observation |
| Libraries | `src/lib/tool-registry.ts`, `src/lib/selector.ts`, `src/lib/persistence.ts`, `src/lib/redaction.ts`, `src/lib/task-queue.ts` | Tool definitions + executors, selector heuristics, IndexedDB, secret redaction, queuing |

**Key facts that shape this plan:**

- `src/content/perception.ts` already:
  - Runs Readability + Turndown to produce `markdown_content` (`extractPerception`, lines 33–86).
  - Walks `document.body` with a `TreeWalker`, calls `isActionable(el)`, injects a stable attribute **`data-momo-ref-id="momo-N"`**, and builds a `ref_id_map: Record<selector, refId>`.
  - Exposes `findByRefId(refId)`, `resolveSelector(selector)`, and `resolveTarget(refId, selector)` on `window`.
- `src/content/ax-extractor.ts` (`AxTreeExtractor`) fetches `Accessibility.getFullAXTree` via CDP **and** has a JS fallback that computes `getImplicitRole`, `getStates`, and per-element `rect`.
- `src/lib/selector.ts` `isActionable(el)` already defines the interactive-role set (button, link, textbox, checkbox, combobox, radio, tab, switch, option, …) plus `tabindex` and `onclick`/`onkeydown` heuristics.
- `src/lib/tool-registry.ts` already implements `navigate`, `click`, `type` (and more) as executors that:
  - call `authorizeViaBridge` (policy gate) **before** acting,
  - resolve the target to coordinates via a content-script probe,
  - dispatch **trusted** input through `cdpAdapter.dispatchMouseEvent` / `insertText` (chrome.debugger / CDP, `isTrusted === true`),
  - call `reportActionResult` **after** acting (separate from authorization — MOMO-056).
- `src/sw/message-router.ts` already exposes an `EXECUTE_TOOL` handler and enforces two allowlists:
  - `CDP_COMMAND_ALLOWLIST` (only `Accessibility.getFullAXTree` + a few `DOM.*` reads),
  - `BRIDGE_REQUEST_ALLOWLIST` (which `BridgeRequest` types the extension may proxy).

### 1.2 The bridge (`bridge/`, Rust, tokio + axum)

| File | Role |
|---|---|
| `bridge/src/main.rs` | `BridgeServer`, `BridgeRequest`/`BridgeResponse` enums, WebSocket server + `--legacy-stdio` native-messaging mode |
| `bridge/src/ws_server.rs` | `ConnectionManager` (WebSocket accept, read/write loops, heartbeat) |
| `bridge/src/policy.rs` | `PolicyEngine` (allowlist, permitted-actions, confirmation, audit log, token budget) |
| `bridge/src/llm.rs` | `LlmGateway` (Anthropic / Ollama) |
| `bridge/src/types.rs` | Shared serde types (`ToolCall`, `ToolResult`, `CompressedDom`, …) |

**The wire protocol today (`BridgeRequest`, tagged enum `{ "type": "...", "payload": {...} }`):**

```
BridgeRequest::SimulateClick    { session_id, origin, target, x, y, page_revision }
BridgeRequest::SimulateType     { session_id, origin, target, selector, text, field_is_sensitive, page_revision }
BridgeRequest::SimulateScroll   { ... x, y, delta_x, delta_y, page_revision }
BridgeRequest::SimulateMouseMove{ ... from/to coords, page_revision }
BridgeRequest::PolicyCheck      { session_id, action, origin, target, arguments, page_revision }
BridgeRequest::ActionResult     { session_id, action_hash, outcome, error }
BridgeRequest::Observe          { session_id, origin, include_markdown, page_revision }
BridgeRequest::Extract          { session_id, origin, selector, schema, include_markdown, page_revision }
BridgeRequest::Ping / GetStatus / Shutdown / PolicyGetConfig / PolicySetConfig / PolicyGetAuditLog

BridgeResponse::Ok    { request_id, data }
BridgeResponse::Error { request_id, code, message }
BridgeResponse::Event { event, data }
BridgeResponse::StreamChunk / StreamEnd
```

**The critical asymmetry:** the WebSocket is **extension-initiated request → bridge response**. `ConnectionManager::register` (lines 42–186) reads `BridgeRequest`, dispatches to `BridgeServer::handle_request`, and writes the `BridgeResponse` back. There is **no** bridge→extension *request/response* channel today — only the fire-and-forget `BridgeResponse::Event` push. This asymmetry is the single most important thing Phase 9 must add.

### 1.3 The policy/trust model (already fail-closed)

`PolicyEngine::evaluate` (policy.rs, lines 299–380) enforces, in order:

1. **Origin allowlist** — `check_origin`: empty allowlist **denies everything**; `*.example.com` matches subdomains only.
2. **Permitted actions** — `check_action_permitted`: empty = allow all (see §6.3 for the MCP-mode hardening).
3. **Token budget** — `check_token_budget`.
4. **Risk classification + confirmation** — `classify_risk` → `requires_confirmation` (Sensitive by default).

The extension re-verifies at execution time and adds its own local gates (destructive-click keyword detection, sensitive-field detection via `isSensitiveInput`), then reports the real outcome back via `ActionResult`.

---

## 2. Target Architecture

### 2.1 Mode A — Default Orchestrator (unchanged behavior)

```
┌─────────────┐   BridgeRequest (WS)   ┌──────────────────────────┐
│  Extension  │ ◄────────────────────► │  Rust bridge (Mode A)    │
│  (dumb      │                         │  • LlmGateway            │
│   bridge)   │                         │  • PolicyEngine          │
└─────────────┘                         │  • internal orchestrator │
                                        └──────────────────────────┘
```

No changes to Mode A's *external* behavior. The dual-mode dispatcher in `main()` selects it by default when no mode flag is present.

### 2.2 Mode B — MCP Server

```
┌─────────────┐  MCP/JSON-RPC over stdio  ┌──────────────────────────┐
│ MCP client  │ ◄───────────────────────► │  Rust binary (--mcp)     │
│ (Claude Code│                           │  • MCP stdio transport   │
│  Cursor, …) │                           │  • MCP tool definitions  │
└─────────────┘                           │  • PolicyEngine (shared) │
                                          │  • WS server (same conn) │
                                          └───────────┬──────────────┘
                                                      │ BridgeRequest/Command (WS)
                                                      ▼
                                              ┌─────────────┐
                                              │  Extension  │  (unchanged dumb bridge)
                                              └─────────────┘
```

Two sub-processes coexist inside the single binary:
- **MCP stdio loop** — speaks newline-delimited JSON-RPC 2.0 to the MCP client.
- **WebSocket server loop** — the *same* `ConnectionManager` + `BridgeServer` used in Mode A, so the extension connects exactly as it does today (via `~/.momo/bridge_port` discovery).

The MCP layer translates `tools/call` into either:
- a direct `BridgeServer::handle_request` call (for policy/config/status read ops), or
- a **bridge→extension command** over the WebSocket (for perception + action execution).

### 2.3 Why not a separate MCP-only binary?

A dedicated `momo-mcp-server` crate is tempting, but it would duplicate `PolicyEngine`, the WebSocket `ConnectionManager`, and the `BridgeRequest`/`BridgeResponse` serde types. The requirement "one extension, one bridge" is best honored by **one Rust binary with a mode flag**, because:

- The **policy engine and audit log must be shared** — MCP-driven actions must land in the same `policy.db` and the same audit trail as Mode A actions, otherwise you get two divergent trust records.
- The **WebSocket server must be shared** — the extension can only hold one WebSocket connection, so Mode A and Mode B must never both own a conflicting listener.
- NPM distribution is simpler: ship one binary, expose one command surface.

---

## 3. Dual-Mode Rust Server Design

### 3.1 Startup dispatch

`main()` gains a minimal CLI parse (no heavy arg framework needed; `std::env::args` is sufficient for now, replace with `clap` later if flags multiply):

```
momo-bridge                    → Mode A (current default)
momo-bridge --legacy-stdio     → Mode A native-messaging (existing, preserved)
momo-bridge --mcp              → Mode B: MCP over stdio
momo-bridge --mcp --port FILE  → Mode B with explicit bridge_port file override (testing)
```

Dispatch logic:

1. Parse flags.
2. `BridgeServer::new()` — **always** constructed (owns `PolicyEngine`, which always loads persisted config).
3. If `--mcp`: enter **Mode B** (§3.3).
4. Else if `--legacy-stdio`: existing native-messaging loop (preserved as-is).
5. Else: existing WebSocket server loop (Mode A, preserved as-is).

> **Invariant:** `BridgeServer` and `PolicyEngine` construction is identical in every mode. The mode only changes *what drives* the server — internal orchestrator, MCP client, or native host.

### 3.2 Shared WebSocket ownership in Mode B

Mode B must still accept the extension's WebSocket connection, because the MCP client has **no** direct path to the extension. Therefore Mode B runs the same `axum` `ws_router` + `ConnectionManager` in a background task, and the MCP stdio loop runs on the main task. Both share `Arc<BridgeServer>` and `Arc<ConnectionManager>`.

Port discovery is unchanged: write the ephemeral port to `~/.momo/bridge_port` (the extension's `discoverBridgePort` already reads it). One caveat — **concurrent Mode A + Mode B on the same machine would race on `bridge_port`.** Mitigation (documented, not silently ignored):

- Treat Mode A and Mode B as *mutually exclusive* deployments (document it in README).
- Optionally write a distinct `~/.momo/mcp_bridge_port` in Mode B so a running Mode A is not clobbered; the extension reads the standard file, so this only helps when the user points the extension at the MCP bridge manually. This is a follow-up, not a Phase-9 blocker.

### 3.3 Mode B control flow

```
[spawn] WS server task  ── listens 127.0.0.1:0, writes bridge_port, serves extension
[main]  MCP stdio loop  ── reads NDJSON JSON-RPC from stdin, writes NDJSON to stdout
```

For each inbound JSON-RPC message:

| Method | Action |
|---|---|
| `initialize` | Return server info + capabilities (tools, no resources/prompts in v1) |
| `notifications/initialized` | No-op ack |
| `ping` | Return `{ result: {} }` |
| `tools/list` | Return static tool schemas (§5) |
| `tools/call` | Route to the tool dispatcher (§5.2) |
| unknown | JSON-RPC `-32601 Method not found` |

---

## 4. MCP Protocol Framing & Transport

### 4.1 Framing decision: newline-delimited JSON (NDJSON)

The MCP stdio transport (per the 2024-11-05 spec and later) is **newline-delimited JSON**: one JSON-RPC 2.0 message per line, `\n`-terminated, UTF-8. This is **not** Chrome's native-messaging 4-byte length prefix (which `run_legacy_stdio` implements). Therefore Phase 9 adds a **new** stdio loop, `mcp_stdio.rs`, distinct from `run_legacy_stdio`.

Rationale:
- Interoperates with the reference MCP SDKs (TypeScript `@modelcontextprotocol/sdk`, Python `mcp`, Rust `rmcp`/`mcp-server`), which all implement NDJSON stdio.
- Trivially debuggable (`printf` a line into the process).

**Anti-goal:** do **not** reuse the native-messaging length-prefix framing for MCP — it is the wrong protocol and would silently fail with every MCP client.

### 4.2 JSON-RPC envelope

```
{ "jsonrpc": "2.0", "id": <string|number|null>, "method": "...", "params": {...} }   // request
{ "jsonrpc": "2.0", "id": <same>, "result": {...} }                                    // response
{ "jsonrpc": "2.0", "id": <same>, "error": { "code": -32000, "message": "..." } }     // error
{ "jsonrpc": "2.0", "method": "notifications/...", "params": {...} }                  // notification (no id)
```

Response `id` must echo the request `id` exactly (string or number). Notifications (no `id`) must not produce a response.

### 4.3 `tools/call` result format (MCP shape)

```jsonc
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [ { "type": "text", "text": "<markdown or JSON string>" } ],
    "isError": false            // true when the tool returned a semantic error
  }
}
```

Semantic tool errors (e.g. `stale_reference`) are returned as `isError: true` with the structured JSON embedded in the text — **not** as JSON-RPC `-32000` errors, which are reserved for protocol-level failures (bad method, malformed params, transport error).

### 4.4 `initialize` handshake + cancellation (MCP 2024-11-05 conformance)

The hand-rolled JSON-RPC must reproduce the exact `initialize` contract that Claude Code / `@modelcontextprotocol/sdk` expect, or the client will refuse to negotiate:

**`initialize` request (client → server):**

```jsonc
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": { /* client capabilities */ },
    "clientInfo": { "name": "claude-code", "version": "…" }
}}
```

**`initialize` response (server → client) — REQUIRED fields:**

```jsonc
{ "jsonrpc": "2.0", "id": 1, "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
        "tools": {}            // server exposes tools; no resources/prompts in v1
    },
    "serverInfo": { "name": "momo-mcp-server", "version": "0.4.0" }
}}
```

Rules to implement (and test against the spec, not assumed):

1. **Protocol version echo.** The server must respond with a `protocolVersion` it supports. Since we target 2024-11-05, return `"2024-11-05"`. If the client requests a *newer* (unknown) version, the server may still return `"2024-11-05"` and the client decides compatibility; do **not** hard-fail on an unfamiliar version string.
2. **`notifications/initialized`** (client → server, no `id`) must be accepted and answered with **no response** (notifications must never produce a JSON-RPC reply).
3. **`notifications/cancelled`** (client → server, no `id`, `params: { requestId, reason? }`): accept it. In v1 the server records the cancellation and marks the corresponding in-flight Command as cancelled (see §6.4), but the underlying CDP action is not forcibly interrupted mid-flight — it is dropped from the pending registry so its eventual `CommandResult` is ignored. This matches the spec's "best-effort" cancellation semantics.
4. **`ping`** (both directions): the server must answer a client `ping` with `{ result: {} }`.
5. **`tools/list`** returns `{ tools: [ ... ] }` where each tool carries `name`, `description`, and `inputSchema` (JSON Schema, `type: "object"`, `additionalProperties: false`).

**Transport framing conformance** (already stated in §4.1): newline-delimited JSON-RPC 2.0. No length-prefix framing. Log to stderr only — stdout is reserved exclusively for JSON-RPC frames, otherwise the MCP client's parser corrupts.

---

## 5. Hybrid Perception Tool Surface

Four MCP tools. The split is deliberate and reflects the analysis: **reading ≠ acting**, and **the full AXTree is too noisy**. Multi-tab orchestration is a first-class requirement: every page-scoped tool accepts an optional `tab_id` (defaulting to the active tab), and a dedicated `list_tabs` tool enumerates the controllable tab set.

### 5.1 `read_page_content`

- **Purpose:** token-efficient reading / summarizing / Q&A over the current page.
- **Implementation:** reuse `extractPerception(includeMarkdown=true)` in `src/content/perception.ts`. No new parsing.
- **Returns:** `{ title, url, markdown_content }`.

```jsonc
// input schema
{
  "type": "object",
  "properties": {
    "tab_id": { "type": "integer", "description": "Target tab; omit for the active tab" }
  },
  "additionalProperties": false
}

// result (text content)
{
  "title": "Example",
  "url": "https://example.com",
  "markdown_content": "# Heading\n\nBody …"
}
```

### 5.2 `get_interactive_elements`

- **Purpose:** return a **pruned AXTree** — only *visible + interactive* elements — with role, label, state, and a stable injected ID `el_XX`.
- **Explicitly NOT:** the full `Accessibility.getFullAXTree` (which includes structural/non-interactive nodes — "too noisy" per direction), and NOT Markdown (which loses interactability).
- **Input:** optional `tab_id` (integer) — target tab, defaults to the active tab.

**Output contract (the element descriptor):**

```jsonc
{
  "url": "https://example.com/checkout",
  "page_revision": 42,
  "elements": [
    {
      "ref": "el_1",                    // stable injected ID
      "role": "button",                 // implicit/ARIA role
      "label": "Place order",           // accessible name / textContent / value
      "tag": "button",
      "state": { "disabled": false, "checked": null, "required": false, "focused": false },
      "bounds": { "x": 120, "y": 340, "width": 140, "height": 40 }
    }
    // … only interactive + visible nodes, in DOM order
  ]
}
```

**Implementation path (compose existing pieces, no new engine):**

1. **Content-script injection** (new function `getInteractiveElements()` in `src/content/perception.ts`), modeled on the existing `extractPerception` TreeWalker:
   - `TreeWalker` over `document.body`, `NodeFilter.SHOW_ELEMENT`.
   - Keep only `isActionable(el) && el.checkVisibility()` (reuse `src/lib/selector.ts`).
   - Inject **`data-momo-ref="el_XX"`** (sequential counter), storing the mapping for resolution.
   - Derive `role` via the implicit-role table + ARIA (reuse the logic already in `ax-extractor.ts` fallback; lift it into a shared helper).
   - Derive `label` from `aria-label` → `textContent` (trimmed, capped ~100 chars) → `value`/`placeholder`, with sensitive-field values already suppressed by the existing redaction guards.
   - Derive `state` from `disabled`/`required`/`readonly`/`checked`/`aria-invalid`/`document.activeElement` (reuse `getStates` logic).
   - Derive `bounds` from `getBoundingClientRect()`.
2. **Return** the pruned list plus the current `pageRevision` (already tracked on `AgentState`).

> **Why content-script injection instead of `getFullAXTree` + `DOM.resolveNode`:** the codebase *already* injects IDs in the content script (`extractPerception`), and the content script has direct DOM access for coordinate resolution. Going through CDP AXTree → `backendDOMNodeId` → `DOM.resolveNode` → inject would add a fragile multi-hop round-trip for no gain, because the pruned list is produced by the *same* `isActionable` filter either way. The AXTree path remains useful only as a *fallback* for cross-origin/Shadow-DOM cases (§5.5).

### 5.3 `execute_action`

- **Purpose:** execute `click`, `type`, `scroll`, or `navigate` — targeting **stable IDs only**.
- **Hard rule:** `ref` (`el_XX`) is the **only** targeting key. Raw CSS selectors are **not** accepted. This is the single most important behavioral contract in Phase 9.

```jsonc
// input schema (click)
{
  "type": "object",
  "properties": {
    "action": { "enum": ["click", "type", "scroll", "navigate"] },
    "ref":    { "type": "string", "description": "Stable el_XX ID from get_interactive_elements" },
    "text":   { "type": "string", "description": "For action=type only" },
    "url":    { "type": "string", "format": "uri", "description": "For action=navigate only" },
    "tab_id": { "type": "integer", "description": "Target tab; omit for the active tab" }
  },
  "required": ["action"],
  "additionalProperties": false,
  // per-action required fields enforced in the dispatcher (click/scroll→ref; type→ref+text; navigate→url)
}
```

**Execution path (reuse, don't rewrite):**

1. MCP dispatcher maps the tool call to a bridge→extension command (§6).
2. The extension routes it into the existing `ToolRegistry` executors (`click`, `type`, …) which already: run the policy gate, resolve coordinates, dispatch trusted CDP input, and report the outcome.
3. The **only change** is that target resolution now uses **strict ref resolution** (§7) — no selector fallback.

### 5.4 `list_tabs`

- **Purpose:** enumerate the browser's tabs so the LLM can target a specific tab via `tab_id` on the page-scoped tools. Multi-tab orchestration is a core use case (e.g. "fill the form on tab 3, then read the results on tab 1").
- **Implementation:** `chrome.tabs.query({})` in the service worker — no content-script injection, no CDP.
- **Returns:**

```jsonc
{
  "tabs": [
    { "tab_id": 17, "window_id": 1, "active": true,  "title": "Checkout", "url": "https://shop.example/checkout" },
    { "tab_id": 23, "window_id": 1, "active": false, "title": "Docs",     "url": "https://docs.example" }
  ]
}
```

- **Note on `url` exposure:** full tab URLs may contain query parameters with secrets. The `list_tabs` result passes through the existing redaction layer (`redactText`/`redactValue`) before leaving the extension, consistent with every other outbound payload.

### 5.5 Perception fallback for obfuscated / canvas / Shadow-DOM pages

Not required in Phase 9, but flagged so the architecture doesn't preclude it: when `get_interactive_elements` returns empty or insufficient nodes on a canvas-rendered / cross-origin-Shadow-DOM page, a future `capture_viewport` (screenshot + VLM bounding boxes) tool slots in as a *fifth* modality. The tool surface above is deliberately extensible — adding a tool is a `tools/list` + one dispatcher arm, nothing architectural.

---

## 6. The Missing Link: Bridge → Extension Command Channel

This is the **only structural addition** to the wire protocol, and it is required because MCP clients must *request* perception and *request* actions, but the current WebSocket is one-directional (extension asks, bridge answers).

### 6.1 New message types

Add two variants so the bridge can issue a correlated request and the extension can answer:

```rust
// bridge → extension (new push, correlated by request_id)
BridgeResponse::Command { request_id: String, command: String, params: serde_json::Value }

// extension → bridge (new request type, correlated back)
BridgeRequest::CommandResult { request_id: String, result: serde_json::Value }
```

- The **bridge** generates the `request_id` (its existing `next_request_id()`), sends `Command`, and stores a pending resolver keyed by `request_id` with a timeout (e.g. 30 s, mirroring the extension's existing 30 s `WsClient` timeout).
- The **extension's** `WsClient.handleMessage` recognizes `Command` (analogous to how it already recognizes `Event`) and forwards it to a new `CommandDispatcher` in the service worker.
- The dispatcher executes, then sends `CommandResult { request_id, result }` back over the WebSocket.
- The bridge resolves the pending future and returns the MCP `tools/call` result.

### 6.2 Command vocabulary (v1)

| `command` | `params` | Extension handler | Mapped to |
|---|---|---|---|
| `read_page_content` | `{ tab_id? }` | `extractPerception` via `chrome.scripting.executeScript({ tabId })` | `read_page_content` tool |
| `get_interactive_elements` | `{ tab_id? }` | `getInteractiveElements()` content-script injection | `get_interactive_elements` tool |
| `execute_action` | `{ action, ref?, text?, url?, tab_id? }` | `AgentOrchestrator.executeToolCall` with strict-ref resolution | `execute_action` tool |
| `list_tabs` | `{}` | `chrome.tabs.query({})` in the SW | `list_tabs` tool |

> The `execute_action` command deliberately re-enters `AgentOrchestrator.executeToolCall` (the same ingress used by the internal run loop and the existing `EXECUTE_TOOL` message) so that policy gating, CDP execution, confirmation, redaction, and audit reporting are **identical** in Mode A and Mode B. There is exactly one code path for "perform a click."

> **`tab_id` plumbing:** an explicit `tab_id` flows from the MCP tool arg → `Command.params.tab_id` → the extension's command dispatcher → `chrome.scripting.executeScript({ target: { tabId } })` / `chrome.tabs.get(tabId)` → the `ToolContext` used by `executeToolCall`. When `tab_id` is omitted, the extension resolves the active tab (`chrome.tabs.query({ active: true, currentWindow: true })`), which is the current Mode-A behavior. This is the only place the existing orchestrator/tool-registry needs a *threading* change (not a logic change) to become multi-tab aware.

### 6.3 Bridge→extension allowlist (defense in depth)

Mirroring the existing `BRIDGE_REQUEST_ALLOWLIST` and `CDP_COMMAND_ALLOWLIST`, the extension's `CommandDispatcher` must **reject** any `command` not on an explicit allowlist (`read_page_content`, `get_interactive_elements`, `execute_action`, `list_tabs`, and nothing else in v1). A malicious or buggy MCP client cannot, via the command channel, reach arbitrary `chrome.*` APIs — it can only reach these four whitelisted verbs, and `execute_action` is further bounded by the policy engine (§8).

### 6.4 Command timeout, disconnect, and concurrency semantics

This is an explicit contract, not an implementation detail. The MCP client (LLM) and the extension must agree on what happens when the correlated Command round-trip does not complete normally.

**Timeout behavior (bridge side).** A `Command` that receives no `CommandResult` within the timeout (default 30 s, matching the extension's existing `WsClient` timeout) resolves as a **tool-level error**, not a JSON-RPC error:

```jsonc
{ "error": "command_timeout", "command": "execute_action", "request_id": "req-42" }
```

**Disconnect behavior.** If no extension is connected to the WebSocket when a Command is issued, `send_command` fails immediately (does not wait for the timeout):

```jsonc
{ "error": "bridge_disconnected", "command": "get_interactive_elements" }
```

**Rationale (why `isError: true`, never a JSON-RPC `-32000`):** a timeout or disconnect is a *recoverable tool-level outcome* — the LLM should either retry, tell the user the extension/browser is unavailable, or re-fetch. JSON-RPC errors are reserved for protocol failures (malformed frame, unknown method, invalid envelope). Keeping "the browser didn't answer" in the tool-result channel means the LLM's recovery loop (which already handles `stale_reference`) handles it uniformly: *any `isError: true` result with a structured `error` code tells the model to adapt, not to crash.*

**Concurrency (parallel pending Commands).** The transport supports **concurrent in-flight Commands** — each is correlated by its own `request_id` in the bridge's pending registry, so multiple `tools/call` invocations do not share a single slot. The *extension-side* scheduling is where serialization is enforced:

- **Read-only Commands** (`read_page_content`, `get_interactive_elements`, `list_tabs`) run **concurrently** — they are pure and do not mutate shared orchestrator state.
- **`execute_action` is serialized per session.** The current `AgentOrchestrator` is single-active-session (`isRunning` flag, single `state`, single `pendingHumanIntervention`), so concurrent writes would race on `pageRevision`, `currentStep`, and the confirmation gate. The dispatcher therefore queues `execute_action` Commands behind a per-session mutex (a `tokio`-side / SW-side async lock), draining them one at a time. In v1 this means **globally serialized writes**; per-session parallelism across *different* tabs/sessions is a follow-up once the orchestrator becomes multi-session.

> **`notifications/cancelled` interaction:** when the MCP client cancels a `tools/call`, the bridge removes the matching `request_id` from the pending registry so the eventual late `CommandResult` is ignored (no double-resolution, no leaked resolver). The in-flight CDP action is *not* forcibly aborted mid-flight — cancellation is best-effort, per spec (§4.4).

---

## 7. Stale-Reference Recovery Flow

This is the correctness heart of the hybrid perception model. Between `get_interactive_elements` and `execute_action`, an SPA may re-render, a lazy list may scroll, an animation may swap a node, or a DOM diff may replace the subtree — so `el_45` may no longer exist, or may exist but point at a *different* element.

### 7.1 Strict resolution at execution time

The extension's click/type executor resolves the target **by `ref` only**, with **no selector fallback**, using a new strict helper (replacing the current `resolveTarget`'s selector fallback *for the MCP path*):

```
resolveByRefStrict(ref):
  el = document.querySelector(`[data-momo-ref="${ref}"]`)
  if el is null            → return { status: "stale_reference" }
  if !el.isConnected        → return { status: "stale_reference" }   // detached node
  if !el.checkVisibility()  → return { status: "stale_reference" }   // hidden/zero-size
  if !isActionable(el)      → return { status: "stale_reference" }   // re-render changed semantics
  rect = el.getBoundingClientRect()
  if rect.width == 0 or rect.height == 0 → return { status: "stale_reference" }
  return { status: "ok", x: rect.x + w/2, y: rect.y + h/2, ... }
```

> **Why no selector fallback is mandatory:** falling back to a CSS selector after a stale ref is exactly the failure mode the direction forbids — the selector may match a *different* element than the one the LLM intended (e.g., the first `.product-card` after a list re-sort). A stale ref must **fail loudly and identifiably**, never silently click "something that looks close."

### 7.2 Structured error contract

When resolution fails, `execute_action` returns (with `isError: true`):

```jsonc
{ "error": "stale_reference", "ref": "el_45", "hint": "re-fetch get_interactive_elements" }
```

The MCP client's LLM, seeing `stale_reference`, is expected to call `get_interactive_elements` again and re-target — **not** to retry the same `ref` blindly. The `hint` field makes the recovery action explicit in-band.

### 7.3 Sequence diagram

```
LLM                          MCP server                     Extension
 │  get_interactive_elements     │                              │
 │ ────────────────────────────► │  Command{get_interactive}   │
 │                               │ ──────────────────────────► │
 │                               │ ◄──── CommandResult{elements: [el_45: "Submit"]}
 │ ◄──────── { elements: [...] } │                              │
 │                               │                              │
 │  (SPA re-renders; el_45 is replaced)                         │
 │                               │                              │
 │  execute_action click el_45   │                              │
 │ ────────────────────────────► │  Command{execute_action ref=el_45}
 │                               │ ──────────────────────────► │
 │                               │ ◄──── CommandResult{ error: "stale_reference", ref: "el_45" }
 │ ◄── { isError: true, stale_ref }                             │
 │  get_interactive_elements (fresh) → el_52 is now "Submit"    │
 │  execute_action click el_52   → success                      │
```

---

## 8. MCP Server Trust Boundary (Decision + Justification)

This is the section the direction required to be explicit. It is not left implicit anywhere in the implementation.

### 8.1 Threat model

An MCP server over stdio is spawned by *some local process* (Claude Code, an editor, a CI job, or a malicious package). If that server can drive a user's logged-in browser sessions (form-fill = credential access, click = fund transfers, navigation = session hijack), then the question is: **what stops an arbitrary local process from weaponizing it?**

The answer is **not** "the MCP server is local so it's safe." The answer is the **existing policy engine**, which must remain the enforcement boundary.

### 8.2 Decision: trust any local spawner, but **reuse the fail-closed PolicyEngine as the real boundary**

Three layered decisions:

**D1 — Process trust: do NOT add a handshake token as the primary boundary.**
- Rationale: over stdio, any "startup token" must travel as argv or env. Any local process that can spawn the binary can already read argv/env, and on many systems can enumerate `/proc/*/environ`. A token is therefore **not a security boundary against a local attacker** — it only stops accidental cross-talk (e.g. a misconfigured client hitting the wrong port).
- Consequence: the MCP server **does not** trust the spawner for identity; it trusts *the policy engine* for authorization.

**D2 — Policy boundary: MCP mode inherits and *hardens* the existing PolicyEngine.**
- Every `execute_action` flows through `authorize()` → `PolicyEngine::evaluate()`, which is **fail-closed**: an empty origin allowlist denies navigation and all origin-scoped actions.
- **MCP-specific hardening** (the one deliberate delta from Mode A):
  - `permitted_actions` empty currently means "allow all" in `check_action_permitted`. For MCP mode, we flip the default to **deny by default**: MCP mode requires an explicit `permitted_actions` list (or inherits the persisted one) before any `execute_action` is accepted. This makes a fresh, unconfigured MCP deployment inert until the user opts in.
  - `confirmation_policy` defaults to **Sensitive** (unchanged), so irreversible/`auth`-class actions (form submit, credential fields) still surface a user-visible confirmation in the side panel.

**D3 — Scope/allowlist + user-visible confirmation: yes to both.**
- **Scope/allowlist:** the existing origin allowlist is the scope mechanism. In MCP mode the README will instruct users to seed it (e.g. `--allow example.com` or `PolicySetConfig`), and until they do, nothing but read-only perception works.
- **User-visible confirmation:** retained. Sensitive actions require confirmation in the browser side panel (a UI the MCP client *cannot* click through programmatically, because it lives in Chrome's side-panel UI, not in the MCP stdio channel). In MCP mode, a `requires_confirmation` action returns a structured `confirmation_required` result to the LLM, which must then tell the user "approve in the side panel"; the human approves in-browser, and the action proceeds. This preserves the "hardware kill-switch" property from the Manus analysis: closing the tab or denying in the panel severs the action.

### 8.3 Tradeoffs (explicit)

| Approach | Pro | Con | Verdict |
|---|---|---|---|
| Trust any spawner, no policy | Simplest | Local malware = full browser takeover | ❌ Rejected |
| Startup token only | Trivial to implement | **Not a real boundary** (argv/env readable); lulls into false security | ⚠️ Optional defense-in-depth only, never the primary boundary |
| **Reuse PolicyEngine + confirmation (chosen)** | Real, fail-closed boundary; single audit trail; leverages proven code | Requires user to configure allowlist before use; confirmation adds friction | ✅ Chosen |
| Per-origin OAuth / device attestation | Strongest | Heavy, OS/account coupling, out of scope for a local stdio tool | 🔜 Future |

**Bottom line:** MCP mode is a *translation layer* over the same WebSocket + policy engine the extension already trusts. It introduces **zero new trust**; it only widens *who can speak the existing, already-gated protocol*. The guarantee is: **no MCP client can make the extension do anything the policy engine would not already allow a Mode-A orchestrator to do.**

### 8.4 Documented operational invariants (must be in README/`--help`)

1. Fresh MCP install = deny-by-default (empty allowlist + deny-by-default permitted-actions) → read-only until configured.
2. Sensitive actions always require in-browser confirmation (cannot be bypassed over stdio).
3. Every MCP action is written to the same `policy.db` audit log as Mode A.
4. Mode A and Mode B are mutually exclusive deployments (shared `bridge_port`).

---

## 9. NPM Distribution Readiness

Goal: `npx @momo/mcp-server` eventually Just Works.

### 9.1 Package layout

```
@momo/mcp-server
├── package.json          # bin → "momo-mcp-server"
├── bin/
│   └── momo-mcp-server.js  # thin Node shim (see 9.2)
├── platform/
│   ├── momo-bridge-linux-x64
│   ├── momo-bridge-darwin-arm64
│   └── momo-bridge-win32-x64.exe
└── README.md             # MCP client config snippets (Claude Code, Cursor)
```

### 9.2 The Node shim

The Rust binary is compiled per-platform. The npm package ships prebuilt binaries and a thin `bin/momo-mcp-server.js` shim that:

1. Detects `process.platform` / `process.arch`.
2. Resolves the matching `platform/momo-bridge-<platform>-<arch>` binary.
3. Spawns it with `--mcp`, wiring `stdio: 'inherit'` (or pipe) so the MCP client's stdio is passed straight through.

This is the standard pattern (same as `esbuild`, `@anthropic-ai/claude-code`, `turso`). The shim keeps the MCP client's stdio wiring platform-neutral and centralizes flag normalization (e.g. `--mcp` is always injected; the user never types it).

### 9.3 MCP client config (documented in README)

Claude Code (`claude mcp add` / `.mcp.json`):

```json
{
  "mcpServers": {
    "momo": { "command": "npx", "args": ["@momo/mcp-server"] }
  }
}
```

Because the shim injects `--mcp`, the client config stays minimal and stable across releases.

### 9.4 Distribution caveats (called out, not hidden)

- The npm package ships the **bridge binary**, not the extension. The extension is still installed from the Chrome Web Store / unpacked. The MCP server cannot function until the extension is running and connected to the same `bridge_port`.
- Platform matrix must be built in CI (GitHub Actions matrix over linux/darwin/windows × x64/arm64). Cross-compilation for darwin-arm64 from linux is non-trivial; plan for native runners.
- Prebuilt binaries are unsigned; on macOS this triggers Gatekeeper prompts. Document `xattr -d com.apple.quarantine` or codesigning as a follow-up.

---

## 10. File-by-File Implementation Breakdown

### 10.1 Rust (`bridge/`)

| File | Change |
|---|---|
| `bridge/src/main.rs` | Add `--mcp` flag parse; dispatch to `mcp_stdio::run(server, connection_manager)`. Keep Mode A and `--legacy-stdio` untouched. Add `BridgeResponse::Command` and `BridgeRequest::CommandResult` variants. |
| `bridge/src/mcp_stdio.rs` | **New.** NDJSON stdio loop: read line → parse JSON-RPC → dispatch → write line. `initialize`/`ping`/`tools/list`/`tools/call` handlers. |
| `bridge/src/mcp_tools.rs` | **New.** Tool schema definitions (`read_page_content`, `get_interactive_elements`, `execute_action`, `list_tabs`) + dispatcher that translates `tools/call` into either `handle_request` or a `Command` round-trip. |
| `bridge/src/ws_server.rs` | Add a `command_channel` / pending-command registry keyed by `request_id`; a `send_command(command, params) -> oneshot::Receiver<Value>` method; resolve on `BridgeRequest::CommandResult`; timeout + disconnect handling per §6.4. |
| `bridge/src/policy.rs` | Add MCP-mode deny-by-default for `permitted_actions` (a constructor flag or config field `mcp_mode`). No change to `evaluate` logic itself. |
| `bridge/src/types.rs` | Add `Command`/`CommandResult` payload structs if kept separate from the enum. |
| `bridge/Cargo.toml` | No new heavy deps required (serde_json already present; JSON-RPC is hand-rolled). Optional: `tokio::io::BufReader` lines. |

### 10.2 Extension (`src/`, additive only)

| File | Change |
|---|---|
| `src/content/perception.ts` | Add `getInteractiveElements()` (pruned AXTree: inject `data-momo-ref="el_XX"`, emit role/label/state/bounds). Add `resolveByRefStrict(ref)`. Expose both on `window.__perception*`. |
| `src/content/ax-extractor.ts` | (optional) lift `getImplicitRole`/`getStates` into a shared helper module so `perception.ts` and the AX fallback share one implementation. |
| `src/lib/selector.ts` | Reuse `isActionable` as-is (already correct). No change unless the role table needs expansion. |
| `src/lib/tool-registry.ts` | Add strict-ref resolution to the MCP `execute_action` path (or a new `executeByRef` executor that shares the CDP dispatch with `click`/`type`). Map `stale_reference` → structured error result. |
| `src/sw/message-router.ts` | Add `COMMAND` handling: a `CommandDispatcher` with its own command allowlist (`read_page_content`, `get_interactive_elements`, `execute_action`, `list_tabs`); route `execute_action` into `AgentOrchestrator.executeToolCall`. Send `CommandResult` over WS. Serialize `execute_action` per §6.4. |
| `src/sw/ws-client.ts` | Recognize `BridgeResponse::Command` and forward to the dispatcher callback (parallel to existing `Event` handling). |
| `src/sw/orchestrator.ts` | Expose a public method the dispatcher can call to run a tool with a specific `ref` (reuse `executeToolCall`; add the `stale_reference` result mapping). Thread an optional `tabId` through `executeToolCall` → `ToolContext` so `list_tabs`+`tab_id` can target non-active tabs. |

> **No manifest change is required** for Phase 9 — the new surface reuses existing `scripting`, `tabs`, `debugger`, and WebSocket (loopback) capabilities. `data-momo-ref` injection happens in content scripts already listed in the manifest.

> **Temporary technical debt (recorded, not hidden):** Phase 9 introduces `data-momo-ref="el_XX"` alongside the pre-existing `data-momo-ref-id="momo-N"` from Mode A. The two ID schemes coexist intentionally so Mode A is untouched, but they are redundant and must be **unified into a single attribute in a later phase** (migrate `findByRefId`/`extractPerception`/`resolveTarget` off `data-momo-ref-id`, or alias the MCP path to it). Until then, both attributes may be present on the same element; the MCP strict resolver reads **only** `data-momo-ref`, and Mode A reads **only** `data-momo-ref-id`.

---

## 11. Testing Strategy

| Layer | Test |
|---|---|
| MCP framing | Unit-test the NDJSON line codec: message ↔ line round-trip, multi-byte UTF-8, malformed JSON → `-32700 Parse error`, unknown method → `-32601`. |
| Tool schemas | Snapshot-test `tools/list` output against the three schemas; assert `required` fields and `additionalProperties:false`. |
| Stale-ref resolution | Content-script unit tests: existing ref → `ok` + coords; removed ref → `stale_reference`; hidden ref → `stale_reference`; detached ref → `stale_reference`; ref on non-actionable node → `stale_reference`. |
| Policy boundary | Integration test: fresh MCP config → `execute_action` denied (fail-closed); after allowlist seed → allowed; sensitive action → `requires_confirmation`. |
| Command channel | Integration test: bridge sends `Command{get_interactive_elements}`, extension responds `CommandResult`; timeout on non-response resolves to error. |
| Round-trip | Manual E2E: `momo-bridge --mcp` + extension, drive `tools/call` sequence through a scripted MCP client; assert a real click lands via CDP with `isTrusted:true`. |

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `bridge_port` race (Mode A vs Mode B) | Document mutual exclusivity; distinct `mcp_bridge_port` as follow-up. |
| Deny-by-default surprises users | README + first-run stderr guidance ("seed allowlist or only read-only tools work"). |
| Stale-ref churn on highly dynamic SPAs | The `stale_reference` hint drives LLM re-fetch; consider `page_revision` check to short-circuit known-stale refs early. |
| NDJSON framing divergence across MCP SDKs | Target the 2024-11-05 spec; verify against `@modelcontextprotocol/sdk` stdio transport in CI. |
| Unsigned darwin binaries blocked by Gatekeeper | Document codesign/quarantine-xattr; native CI runners. |
| Command-channel abuse from a compromised content script | Command allowlist + `CommandResult` only sent by the SW (not content scripts), mirroring existing CDP/WS allowlists. |

---

## 13. Milestones

1. **M1 — Wire protocol extension:** add `Command`/`CommandResult` variants + `send_command` on the bridge; extension recognizes and echoes. (No MCP yet; prove the bidirectional channel.)
2. **M2 — MCP stdio skeleton:** `--mcp` flag, NDJSON loop, `initialize`/`ping`/`tools/list` with the four tool schemas (stubbed), conforming to MCP 2024-11-05 (§4.4).
3. **M3 — Hybrid perception tools + tab targeting:** `getInteractiveElements()` + `resolveByRefStrict()` in the content script; wire `read_page_content` and `get_interactive_elements` end-to-end; **`list_tabs` tool and optional `tab_id` threading on every page-scoped tool** (not deferred — multi-tab is core).
4. **M4 — `execute_action` + stale-ref recovery:** strict-ref resolution, `stale_reference` error, re-entrant `executeToolCall` with `tab_id` support.
5. **M5 — Trust hardening + npm:** MCP-mode deny-by-default, README trust docs, Node shim, CI platform builds, `npx @momo/mcp-server` smoke test.

---

## 14. Resolved Decisions (post-approval amendments)

1. **ID attribute name — RESOLVED.** Proceed with a separate `data-momo-ref="el_XX"` attribute alongside the existing `data-momo-ref-id="momo-N"`. This is recorded as **temporary technical debt** (§10.2) to be unified in a later phase; Mode A and the MCP path read distinct attributes and do not interfere.
2. **`execute_action` scope — CONFIRMED.** v1 action set is `{ click, type, scroll, navigate }`.
3. **MCP SDK dependency — RESOLVED.** Hand-roll JSON-RPC (no new crate). The `initialize` handshake, `notifications/initialized`, `notifications/cancelled`, and `ping` must conform to MCP 2024-11-05 (§4.4) so Claude Code / `@modelcontextprotocol/sdk` compatibility is preserved.
4. **Command timeout + concurrency — SPECIFIED.** Timeout and disconnect surface as `isError: true` tool results (`command_timeout` / `bridge_disconnected`), never JSON-RPC errors; concurrent read Commands are allowed, `execute_action` is serialized per session (§6.4).
5. **Tab targeting — IN SCOPE for M3.** `list_tabs` tool plus optional `tab_id` on `read_page_content` / `get_interactive_elements` / `execute_action` (§5.4, §6.2).

---

*End of Phase 9 plan. Approved 2026-08-18 with four amendments (tab targeting, timeout/concurrency spec, ID-attribute debt, MCP 2024-11-05 conformance). Implementation begins at M1.*
