# Phase 8: Architectural Pivot — WebSocket Transport + Perception Upgrade

> **Goal**: Replace native-messaging (stdio) with a persistent WebSocket between the extension and the Rust bridge; upgrade the content-script perception layer to Readability.js + Turndown.js producing Markdown with preserved `ref_id` anchors. The extension remains a **pure bridge** — no internal LLM — driven by external agents (Claude Code, Hermes) over the WebSocket.

---

## 1. High-Level Architecture

```
┌──────────────────┐     WebSocket (ws://127.0.0.1:XXXX)      ┌──────────────────┐
│  Chrome MV3 Ext  │  ◄─────────────────────────────────────►  │  Rust Bridge     │
│  (Service Worker)│   Frame protocol + auto-reconnect        │  (tokio + axum)  │
│  + Content Script│   Heartbeats (ping/pong 15s)             │  PolicyEngine +  │
│  (ISOLATED world)│   Backpressure + ordered delivery        │  Audit Log       │
└──────────────────┘                                           └──────────────────┘
         │                                                            │
         │ CDP (chrome.debugger)                                      │ SQLite (policy.db)
         ▼                                                            ▼
┌──────────────────┐                                           ┌──────────────────┐
│  Target Page     │                                           │  Allowlist +     │
│  (any origin)    │                                           │  Token Budget    │
└──────────────────┘                                           └──────────────────┘
```

**Key Invariants**
- External agents connect to the **Rust bridge** (not the extension directly). The bridge relays commands ↔ results over the WebSocket.
- The extension **never** stores API keys, models, or prompt templates.
- All write actions (`click`, `type`, `navigate`, `human_click`, `human_type`) still pass through `PolicyEngine::authorize()`; read actions (`scroll`, `extract`, `observe`, `wait`) are local to the extension.
- Perception payloads (`observation.submit`, `extract` results) include `markdown_content` (Readability+Turndown) with stable `ref_id` anchors.

---

## 2. Rust Backend — WebSocket Server

### 2.1 New Dependencies (`bridge/Cargo.toml`)
```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
axum = { version = "0.7", features = ["ws", "tokio"] }
tokio-tungstenite = "0.21"
futures-util = "0.3"
tower = "0.4"
tower-http = { version = "0.5", features = ["cors"] }
serde_json = "1.0"
uuid = { version = "1", features = ["v4", "serde"] }
```

### 2.2 Framing Protocol (replaces 4-byte LE length prefix)
| Direction | Format |
|-----------|--------|
| **Client → Server** | JSON text frame: `{ "id": "req-<uuid>", "type": "BridgeRequest", "payload": { … } }` |
| **Server → Client** | JSON text frame: `{ "id": "req-<uuid>", "type": "BridgeResponse", "payload": { … } }` |
| **Server → Client (async)** | JSON text frame: `{ "type": "BridgeEvent", "event": "...", "data": { … } }` |
| **Heartbeat** | Ping/Pong frames (tokio-tungstenite native) + application-level `{"type":"PING"}` every 15s |

**Request/Response Correlation**: `id` field (UUID v4) matches request to response. No length prefix.

### 2.3 Connection Manager (`bridge/src/ws_server.rs`)
```rust
pub struct WsConnection {
    pub id: Uuid,
    pub sender: mpsc::UnboundedSender<BridgeResponse>,
    pub session_id: Option<String>,      // bound after first PolicyCheck/Simulate*
    pub last_pong: Instant,
}
```
- `HashMap<Uuid, WsConnection>` guarded by `tokio::sync::RwLock`.
- Spawn one task per connection: `read_loop` (deserialize → `BridgeServer::handle_request`) + `write_loop` (drain `sender`).
- Global `broadcast(event)` for `BridgeEvent` (e.g., `policy_changed`, `audit_log_append`).

### 2.4 Axum Entry Point (`bridge/src/main.rs` refactor)
```rust
async fn main() -> Result<()> {
    // ... tracing init ...
    let server = Arc::new(BridgeServer::new()?);

    // WebSocket endpoint
    let ws_router = Router::new()
        .route("/ws", get(ws_handler))
        .layer(CorsLayer::permissive()); // localhost only; extension is same-origin

    // Health / metrics (optional)
    let health_router = Router::new().route("/health", get(|| async { "ok" }));

    let app = Router::new().merge(ws_router).merge(health_router);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?; // ephemeral port
    let port = listener.local_addr()?.port();
    std::env::set_var("MOMO_BRIDGE_WS_PORT", port.to_string()); // extension reads this

    info!("Bridge WS listening on ws://127.0.0.1:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
```
- **Port discovery**: Extension reads `MOMO_BRIDGE_WS_PORT` from env (set by bridge on startup) or from a well-known file (`~/.momo/bridge_port`).
- **Native-messaging shim**: Keep the `stdio` loop behind a `--legacy-stdio` flag for transition; remove after validation.

### 2.5 BridgeRequest / BridgeResponse — Schema Updates
```rust
// ADD to BridgeRequest payload variants:
Observe { session_id: String, origin: String, include_markdown: bool, page_revision: u64 },
Extract { session_id: String, origin: String, selector: String, schema: Value, include_markdown: bool, page_revision: u64 },

// ADD to BridgeResponse Ok data:
markdown_content: String,           // Readability+Turndown output
ref_id_map: HashMap<String, String>, // selector → ref_id (for click/type targeting)

// REMOVE: LlmComplete, LlmStream (no internal LLM)
```

### 2.6 PolicyEngine Changes
- `authorize()` unchanged — still the single policy gate.
- `update_audit_outcome()` unchanged — extension reports `ACTION_RESULT` over WS.
- Add `get_markdown_content(session_id, origin)` if the bridge caches the last observation (optional; content script can push it).

---

## 3. Extension — WebSocket Client

### 3.1 New Module: `src/sw/ws-client.ts`
```ts
export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private pending = new Map<string, (resp: BridgeResponse) => void>(); // id → resolve
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private messageId = 0;

  constructor(private onEvent: (evt: BridgeEvent) => void) {}

  async connect(): Promise<void> { /* exponential backoff 1s→30s, max 5 retries */ }
  private scheduleReconnect() { /* ... */ }
  private startHeartbeat() { /* ping every 15s, expect pong in 5s */ }
  private handleMessage(event: MessageEvent) { /* parse, resolve pending[id] or onEvent */ }
  send<T>(type: BridgeRequestType, payload: object): Promise<T> { /* UUID id, await pending */ }
  close() { /* clear timers, ws.close() */ }
}
```

### 3.2 Port Discovery
```ts
async function discoverBridgePort(): Promise<number> {
  // 1. Try env var (set by bridge at startup)
  if (typeof process !== 'undefined' && process.env.MOMO_BRIDGE_WS_PORT) return +process.env.MOMO_BRIDGE_WS_PORT;
  // 2. Try well-known file
  try {
    const txt = await readFile(path.join(os.homedir(), '.momo', 'bridge_port'), 'utf8');
    return +txt.trim();
  } catch {}
  // 3. Fallback: scan 9000-9100 for /health
}
```

### 3.3 Replace `proxyToBridge` (`src/sw/message-router.ts`)
```ts
// OLD: chrome.runtime.sendNativeMessage('agent.bridge', payload)
// NEW:
const ws = getWsClient(); // singleton on SW startup
return ws.send(request.type, request.payload);
```
- All `BRIDGE_REQUEST` allowlist entries now route through `WsClient.send()`.
- `SHUTDOWN` → `ws.close()` + bridge process exit (bridge handles WS close).

### 3.4 Offscreen Document

> **Status: completed.** The offscreen document was deleted; the kill switch is now the side panel's Stop button / `STOP_TASK`.

- **Delete** the offscreen document entirely — it existed only for native-messaging + LLM.
- `PortManager` no longer accepts `'offscreen'` port type.
- Kill switch (`OFFSCREEN_KILLED`) becomes a simple `ws.close()` + `orchestrator.abortTask()`.

---

## 4. Perception Upgrade — Readability.js + Turndown.js

### 4.1 Content Script Injection (`src/content/perception.ts` — new file)
```ts
// Injected once per frame (ISOLATED world) via chrome.scripting.executeScript
// Dependencies bundled by Vite: readability, turndown, @mozilla/readability (or fork)

interface PerceptionResult {
  markdown_content: string;       // Turndown(Readability(document)).markdown
  ref_id_map: Record<string, string>; // selector → data-momo-ref-id
  title: string;
  url: string;
  timestamp: number;
}

function extractPerception(includeMarkdown: boolean): PerceptionResult {
  // 1. Clone document to avoid mutating the page
  const clone = document.cloneNode(true) as Document;

  // 2. Readability
  const reader = new Readability(clone);
  const article = reader.parse();
  if (!article) return emptyResult();

  // 3. Annotate interactive elements with stable ref_ids
  const refIdMap: Record<string, string> = {};
  let counter = 0;
  const walker = document.createTreeWalker(article.content, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const el = walker.currentNode as HTMLElement;
    if (isActionable(el)) {
      const refId = `momo-${++counter}`;
      el.dataset.momoRefId = refId;
      const selector = generateSelector(el); // same logic as DomCompressor
      refIdMap[selector] = refId;
    }
  }

  // 4. Turndown → Markdown
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const markdown = turndown.turndown(article.content);

  return { markdown_content: markdown, ref_id_map: refIdMap, title: article.title, url: location.href, timestamp: Date.now() };
}
```

### 4.2 `isActionable()` mirrors `DomCompressor.isActionable()` — shared logic (DRY).
### 4.3 Selector Generation
- Reuse `DomCompressor.generateSelector()` (move to shared `src/lib/selector.ts`).

### 4.4 Tool Registry Integration
- `observe` tool: if `include_markdown: true` (default), call perception and return `{ markdown_content, ref_id_map, ...dom }`.
- `extract` tool: same, plus schema mapping.
- `click`/`type`/`human_click`/`human_type`: accept optional `ref_id` in arguments; resolve via `ref_id_map` → selector → coordinates.

### 4.5 Vite Bundling (`vite.config.ts`)
```ts
// Add to build.rollupOptions.input: 'src/content/perception.ts' as separate entry
// Or inline via `chrome.scripting.executeScript({ func: perceptionFn })` — simpler, no extra file.
```

---

## 5. Schema & Type Updates

### 5.1 Shared Types (`bridge/src/types.rs` + `src/sw/orchestrator.ts`)
```rust
// ADD to CompressedDom:
pub markdown_content: Option<String>,
pub ref_id_map: Option<HashMap<String, String>>,

// ToolCall arguments for click/type:
pub ref_id: Option<String>,

// Observation payload (extension → bridge):
pub struct ObservationSubmit {
    session_id: String,
    origin: String,
    dom: CompressedDom,
    markdown_content: String,
    ref_id_map: HashMap<String, String>,
    page_revision: u64,
}
```

### 5.2 `ToolContext` (extension) gets `refIdMap: Map<string, string>`
### 5.3 `ToolExecutor` for `click`/`type` reads `args.ref_id` → selector → coordinates.

---

## 6. Migration Steps (Ordered)

| Step | Description | Files Touched | Verification |
|------|-------------|---------------|--------------|
| **6.1** | Add WS deps to `bridge/Cargo.toml` | `bridge/Cargo.toml` | `cargo build` |
| **6.2** | Implement `ws_server.rs` (connection manager, frame codec) | `bridge/src/ws_server.rs` (new) | Unit test: connect → ping → pong |
| **6.3** | Refactor `main.rs` → Axum + WS endpoint, port discovery | `bridge/src/main.rs` | `cargo run` → `ws://127.0.0.1:PORT/health` |
| **6.4** | Update `BridgeRequest`/`BridgeResponse` enums for new variants | `bridge/src/main.rs`, `bridge/src/types.rs` | `cargo test` |
| **6.5** | Extension: `WsClient` with reconnect + heartbeat | `src/sw/ws-client.ts` (new) | Vitest: mock WS, verify backoff |
| **6.6** | Extension: port discovery (env var + file fallback) | `src/sw/bridge-port.ts` (new) | Manual: start bridge, extension connects |
| **6.7** | Replace `proxyToBridge` → `WsClient.send()` | `src/sw/message-router.ts` | All `BRIDGE_REQUEST` allowlist works |
| **6.8** | Remove offscreen document + handlers | `manifest.json`, `src/sw/message-router.ts`, `src/offscreen/` | Build passes, no offscreen errors |
| **6.9** | Perception module (Readability+Turndown) in content script | `src/content/perception.ts` (new), `vite.config.ts` | `extract`/`observe` return markdown + ref_id_map |
| **6.10** | Wire perception into `observe`/`extract` tools | `src/lib/tool-registry.ts` | `observe` includes `markdown_content` |
| **6.11** | Add `ref_id` support to `click`/`type`/`human_*` tools | `src/lib/tool-registry.ts` | Click by `ref_id` works |
| **6.12** | Shared selector logic (`src/lib/selector.ts`) | `src/lib/selector.ts` (new), `dom-compressor.ts`, `tool-registry.ts` | Identical selectors in both paths |
| **6.13** | Schema/types sync (CompressedDom, ToolCall, ObservationSubmit) | `bridge/src/types.rs`, `src/sw/orchestrator.ts` | `cargo test` + `npm test` |
| **6.14** | End-to-end: external agent → bridge WS → extension → CDP → page → result back | Manual + integration test | Full loop works |

---

## 7. Testing Strategy

| Layer | Tests |
|-------|-------|
| **Rust Unit** | `ws_server`: connect/disconnect, frame codec, reconnect, broadcast; `PolicyEngine`: unchanged + new `Observe`/`Extract` authorize paths |
| **TS Unit** | `WsClient`: reconnect backoff, heartbeat timeout, request/response correlation; `perception.ts`: `isActionable`, selector stability, markdown output |
| **Integration** | `cargo test -- --test-threads=1` (serialized DB); `npm test` (Vitest with mocked `chrome.*`); manual E2E with a test page |
| **Load** | 100 concurrent WS connections to bridge; 1000 `observe` calls/sec — verify no leaks |

---

## 8. Rollback / Feature Flags

- `bridge` binary: `--legacy-stdio` keeps native-messaging path alive during transition.
- Extension: `MOMO_USE_WS=true` env var (default once validated).
- If WS fails: extension falls back to native-messaging (if flag off) or surfaces connection error to external agent.

---

## 9. Open Questions (Resolve Before Implementation)

1. **Port discovery**: Env var vs file vs well-known port (e.g., 9222)? — *Env var + file is robust.*
2. **Bridge binds to `127.0.0.1` only** — confirm no LAN exposure needed. — *Yes, localhost only.*
3. **TLS for WS?** — Not for localhost; `ws://` is fine. `wss://` adds cert complexity for no threat model gain.
4. **Readability.js fork**: Use `@mozilla/readability` (npm) or bundle a pinned version? — *npm, pinned to `^0.4.4`.*
5. **Turndown config**: `headingStyle: 'atx'`, `codeBlockStyle: 'fenced'`, `bulletListMarker: '-'`. — *Accept defaults; configurable later.*
6. **`ref_id` persistence across navigations**: `ref_id_map` is per-observation; after navigation, new perception = new IDs. — *Correct; external agent must re-observe.*
7. **Content script world**: `ISOLATED` (current) vs `MAIN` for Readability? — *ISOLATED is fine; Readability operates on cloned DOM.*
8. **Bundle size**: Readability + Turndown ≈ 60 KB gzipped. Acceptable? — *Yes; content script already loads AX extractor.*

---

## 10. Deliverables Checklist

- [ ] `bridge/src/ws_server.rs` — WebSocket server with frame protocol
- [ ] `bridge/src/main.rs` — Axum entry, port discovery, graceful shutdown
- [ ] `src/sw/ws-client.ts` — Extension WS client with reconnect/heartbeat
- [ ] `src/sw/bridge-port.ts` — Port discovery logic
- [ ] `src/content/perception.ts` — Readability + Turndown extraction
- [ ] `src/lib/selector.ts` — Shared selector generation
- [ ] Updated `tool-registry.ts` — `observe`/`extract` return markdown, `click`/`type` accept `ref_id`
- [ ] Updated types — `CompressedDom`, `ToolCall`, `ObservationSubmit` in both Rust/TS
- [ ] Removed offscreen document + native-messaging shim (or flagged legacy)
- [ ] All tests pass (`cargo test`, `npm test`, `npm run build`, `npm run lint`)

---

## 11. Estimated Effort

| Component | Lines | Risk |
|-----------|-------|------|
| Rust WS server | ~300 | Medium (new async runtime integration) |
| Extension WS client | ~150 | Low (standard WebSocket API) |
| Perception module | ~200 | Medium (Readability quirks, selector stability) |
| Schema sync + wiring | ~100 | Low |
| Tests | ~200 | — |
| **Total** | **~950** | **~3–4 focused sessions** |

---

**Next Step**: Confirm plan, then begin **Step 6.1** (add deps, scaffold `ws_server.rs`).