# Momo Self-Analysis — Architecture & Capabilities

*Generated from workflow run wf_095a748a-93a with 64 completed agents*

## Architecture Summary

- **Extension Layer Architecture**: Service worker (orchestrator.ts, message-router.ts, ws-client.ts, cdp-adapter.ts) manages state machine, WebSocket connection, and CDP integration. Content scripts (perception.ts, ax-extractor.ts) run in ISOLATED world for DOM extraction and accessibility tree capture.
- **Rust Bridge Dual-Mode**: Mode A (WebSocket-only internal orchestration) and Mode B (MCP over stdio with NDJSON JSON-RPC 2.0). Both modes share ConnectionManager and PolicyEngine. Bridge binds to first available port in 9090-9100 range.
- **WebSocket Communication**: Binary frames only (UTF-8-encoded JSON). Extension scans ports 9090-9100 for discovery. Bearer token auth required within 15s of connection (C6). Heartbeat: PING every 15s, PONG expected within 20s, stalled channels evicted (H29).
- **Command Channel (Bridge→Extension)**: Bridge issues correlated Command frames, extension replies with CommandResult. 30s timeout (MOMO_COMMAND_TIMEOUT_MS). Per-connection pending registry isolates disconnect cleanup. Used by MCP mode for perception/action delegation.
- **CDP Integration**: Via chrome.debugger API (not raw remote-debugging). One CDP session per tab, reused across actions, detached on tab close/navigation/switch. Used for trusted input (Input.dispatchMouseEvent, Input.dispatchKeyEvent) and AX tree extraction (Accessibility.getFullAXTree).
- **Perception Layer**: Hybrid approach: Readability + Turndown for Markdown (comprehension), pruned AX tree for interactive elements (action). Content scripts inject stable refs (data-momo-ref='el_XX') for targeting. Ref resolution fails fast with stale_reference when element gone/hidden.
- **MCP Tools (Mode B)**: Four tools exposed over stdio: read_page_content (Markdown), get_interactive_elements (AX tree with refs), execute_action (click/type/scroll/navigate), list_tabs. Bridge validates arguments, runs PolicyCheck, dispatches Command to extension, maps CommandResult to MCP result (isError: true/false).
- **Policy Engine**: Fail-closed: empty allowlist denies all. Every action logged to SQLite audit log with hash. Extension reports real outcome via ACTION_RESULT follow-up. Bridge is authoritative trust boundary - extension never self-authorizes. MCP mode (--mcp) denies execute_action by default until permitted_actions configured.
- **Message Flow (Mode A)**: User → Side panel → Service worker START_TASK → Orchestrator plans → Tools execute via CDP → Content scripts extract perception → Policy gate authorization → Results in IndexedDB → Side panel streams updates via runtime.sendMessage.
- **Message Flow (Mode B)**: MCP client tools/call (stdio) → Bridge validates + PolicyCheck → Bridge sends Command (WebSocket) → Extension executes → Extension replies CommandResult → Bridge maps to MCP result → Client receives NDJSON response. stdout=JSON-RPC, stderr=diagnostics.
- **Reconnection & Buffering**: WsClient maintains outbox for requests sent while disconnected. On reconnect (after bridge restart or SW wake), outbox flushes automatically. Reconnect uses exponential backoff (1s base, 30s max). Immediate reconnect on SW wake (BUG 2 fix).
- **Stale Reference Recovery**: getInteractiveElements() assigns fresh el_XX refs (counter resets per call). resolveByRefStrict() fails if element missing/detached/hidden/zero-sized → surfaces as error: 'stale_reference', hint: 're-fetch get_interactive_elements'. LLM refetches and retries.
- **Redaction at Source**: Passwords, tokens, PII, credit card numbers redacted before entering LLM context, persistence (IndexedDB), audit log (SQLite), or side panel UI. Typed text length logged but content redacted. Field sensitivity detected via type='password', autocomplete attributes, name/id patterns.
- **Session Management**: IndexedDB stores full sessions (state, history, checkpoints). Checkpoints every N steps (CHECKPOINT_INTERVAL). Session marked 'error' if SW suspended mid-task (D1). Working copy (unredacted) vs public copy (redacted) for resume safety.
- **Human-in-the-Loop**: Confirmation gates for sensitive actions (payments, auth, destructive ops). Confirmation state held in-memory (pendingHumanIntervention). Timeout auto-denies. Abort/suspend clears pending confirmation to prevent hangs (H10, H11).

**File References:** /home/mir-abir/Momo/src/sw/orchestrator.ts, /home/mir-abir/Momo/src/sw/message-router.ts, /home/mir-abir/Momo/src/sw/ws-client.ts, /home/mir-abir/Momo/src/sw/cdp-adapter.ts, /home/mir-abir/Momo/src/content/perception.ts, /home/mir-abir/Momo/src/content/ax-extractor.ts, /home/mir-abir/Momo/src/lib/tool-registry.ts, /home/mir-abir/Momo/bridge/src/main.rs, /home/mir-abir/Momo/bridge/src/ws_server.rs, /home/mir-abir/Momo/bridge/src/mcp_stdio.rs, /home/mir-abir/Momo/bridge/src/mcp_tools.rs, /home/mir-abir/Momo/bridge/src/policy.rs, /home/mir-abir/Momo/README.md

**README vs Reality:** The README accurately describes the implemented architecture. All documented features are present: (1) Dual-mode bridge with WebSocket discovery on ports 9090-9100, (2) CDP integration via chrome.debugger for trusted input, (3) Hybrid perception layer (Markdown + AX tree), (4) Fail-closed policy engine with SQLite audit log, (5) Stable element refs (el_XX) with stale-reference recovery, (6) Four MCP tools over stdio NDJSON, (7) Bridge→Extension command channel with 30s timeout, (8) Bearer token auth (15s deadline), (9) Redaction at source before persistence/logs, (10) IndexedDB with WAL for crash-resistant state. The architecture diagram (README lines 123-162) matches actual code structure: Extension (SW/content/sidepanel/lib) ↔ WebSocket ↔ Rust Bridge (dual-mode: Mode A internal orchestration, Mode B MCP stdio).

## Policy Engine (Actual Behavior)

- **DISCREPANCY 1: Field name mismatch** - README.md documents config field as 'token_budget_per_task' (lines 253-260, 650), but policy.rs uses nested 'token_budget.max_tokens' (lines 40-44, 63-66). The flat field name in README would fail to deserialize.
- **DISCREPANCY 2: Evaluation order** - ADR-0001 (line 43) lists 'deduct_tokens' as step 6 (separate from step 4 'check_token_budget'), but implementation deducts tokens INSIDE the budget check at policy.rs:376, not as a subsequent step. Steps 4 and 6 are merged in reality.
- **DISCREPANCY 3: Unused fields** - PolicyConfig.token_budget.warning_threshold (policy.rs:42, default 0.8 at line 65) is persisted but never consulted in any logic. Similarly, risk_thresholds struct (lines 47-54) with 6 numeric thresholds is persisted but never used—risk classification uses keyword matching only (lines 405-429).
- **DISCREPANCY 4: Invalid enum values** - README.md:649 shows 'Low' and 'Moderate' as valid confirmation_policy values, but policy.rs:26-30 defines only Always/Sensitive/Never. The README examples would fail deserialization.
- **DISCREPANCY 5: Unused data_retention field** - PolicyConfig.data_retention (policy.rs:19, 33-37) is defined, persisted (lines 211, 229), and has a default (line 62), but is never checked or enforced anywhere in the codebase.
- **Evaluation order** (policy.rs:305-403): (1) check_origin (lines 310-338): for 'navigate' checks destination URL, else checks current origin; empty allowlist = deny all; wildcard '*.example.com' matches apex + subdomains only. (2) check_action_permitted (lines 340-349): if permitted_actions empty AND not MCP mode → allow; if MCP mode with empty list → deny-by-default; else check list membership. (3) classify_risk (line 352): keyword matching on lowercased action—'navigate'→Navigation, 'pay|purchase|checkout|transfer'→Payment, 'auth|login|logout|password'→Auth, 'dangerous'→Dangerous, 'observe|read|extract|status'→Read, else→Write (lines 405-429). (4) check_token_budget (lines 357-377): estimates via estimate_tokens (lines 431-445: navigate=100, click=10, type=5, extract=20, scroll=1, wait=5, observe=50, mouse_move=1, human_click=10, human_type=5, default=10); acquires write locks on token_usage and last_reset; resets if reset_interval_hours elapsed; denies if usage+needed > max_tokens; IMMEDIATELY deducts tokens at line 376. (5) requires_confirmation (line 380): Always→true, Never→false, Sensitive→true if risk is Payment/Auth/Dangerous OR if action is type/human_type AND is_sensitive_field returns true (lines 447-475).
- **Policy config struct fields** (policy.rs:14-78): PolicyConfig { allowlist: Vec<String>, permitted_actions: Vec<String>, confirmation_policy: ConfirmationPolicy (Always|Sensitive|Never), data_retention: DataRetentionPolicy (Session|Persistent), token_budget: TokenBudgetPolicy { max_tokens: u64, warning_threshold: f64, reset_interval_hours: u64 }, risk_thresholds: RiskThresholds { read, write, navigation, payment, auth, dangerous: all u64 } }. Defaults: allowlist=[], permitted_actions=[], confirmation_policy=Sensitive, data_retention=Session, max_tokens=100000, warning_threshold=0.8, reset_interval_hours=24, risk_thresholds=(1000,500,100,10,10,1).
- **Sensitive field detection** (policy.rs:458-475): is_sensitive_field checks if selector (when present) contains 'password', 'secret', 'cc-', 'credit', or 'cvv' (lowercased). For focused-element typing (no selector), reads field_is_sensitive flag from arguments, defaulting to TRUE (fail-closed) when absent—ADR-0001:49-50 documents this unwrap_or(true) behavior.
- **Audit log writing** (policy.rs:481-506, main.rs:129-175): BridgeServer::authorize computes SHA256(PolicyRequest) as action_hash, spawns blocking task, calls PolicyEngine::evaluate, maps decision to initial outcome (Denied if !allowed, Escalated if requires_confirmation, else Pending), writes AuditEntry to SQLite audit_log table with fields (timestamp, session_id, action, origin, target, arguments_json, risk_class_json, outcome_json, action_hash, page_revision, user_confirmed=false, error), returns decision+action_hash. Later update_audit_outcome (lines 513-535) corrects Pending/Escalated→Success/Failed when extension reports ActionResult.
- **Token deduction location**: Happens at policy.rs:376 inside the token_budget check critical section, NOT as a separate step after requires_confirmation. The write lock on token_usage is held across reset-check-deduct to prevent race conditions (ADR comment 'H55' at line 354).
- **MCP mode behavior** (policy.rs:293-303, main.rs:424): set_mcp_mode(true) flips an internal flag. When mcp_mode=true AND permitted_actions is empty, check_action_permitted returns false (deny-by-default for execute_action). When mcp_mode=false AND permitted_actions is empty, it returns true (permissive legacy mode). mcp_tools.rs:166-214 runs bridge-side PolicyCheck before dispatching execute_action.

**File References:** /home/mir-abir/Momo/bridge/src/policy.rs, /home/mir-abir/Momo/bridge/src/types.rs, /home/mir-abir/Momo/bridge/src/main.rs, /home/mir-abir/Momo/bridge/src/mcp_tools.rs, /home/mir-abir/Momo/docs/adr/0001-policy-gate.md, /home/mir-abir/Momo/README.md

**README vs Reality:** README.md shows 'token_budget_per_task' as a top-level config field and 'Low'/'Moderate' as confirmation_policy values, but policy.rs uses nested 'token_budget.max_tokens' and only accepts Always/Sensitive/Never enum variants. The documented JSON examples would fail to deserialize. Additionally, warning_threshold and risk_thresholds fields are persisted but never used in any enforcement logic.

**Gaps/TODOs:**
- warning_threshold field is persisted but has no associated logic—no warnings are emitted when token usage crosses 80%
- risk_thresholds struct with 6 numeric values is persisted but never consulted—risk classification is purely keyword-based, not threshold-based
- data_retention field (Session|Persistent) is defined and persisted but never enforced—no logic differentiates retention behavior
- ADR-0001 lists 'deduct_tokens' as step 6 but implementation merges it into step 4—documentation should be updated to reflect actual single-phase budget enforcement

## LLM Connectivity

- Two providers supported: Anthropic (Claude API) and Ollama (local models)
- Gateway configured via environment variables: OLLAMA_URL (default: http://localhost:11434) and ANTHROPIC_API_KEY (optional)
- Available models hardcoded: always includes llama3.2:3b and llama3.2:1b, conditionally adds claude-3-5-sonnet-20241022 and claude-3-5-haiku-20241022 if API key present
- HTTP client timeout set to 120 seconds
- Provider routing uses simple string matching: is_anthropic_model() checks if model name starts with 'claude'
- Failure handling: HTTP errors return anyhow error with truncated response body (500 chars max)
- No retry logic implemented for failures
- No explicit rate-limit handling - no exponential backoff, no request queue, errors propagate immediately
- Streaming has 1MB line size limit (MAX_LINE_BYTES) to prevent memory issues
- Streaming error handling: Ollama checks for 'error' field in JSON, Anthropic handles 'error' event type in SSE stream
- NO provider abstraction exists - monolithic implementation makes adding providers HARD
- All provider logic directly embedded in LlmGateway struct with separate methods per provider (complete_ollama, complete_anthropic, stream_ollama, stream_anthropic)
- Each provider has distinct request/response struct types (OllamaRequest/Response, AnthropicRequest/Response)
- Different streaming protocols: Ollama uses newline-delimited JSON, Anthropic uses Server-Sent Events with 'data:' prefix
- Message format conversion required for Anthropic via to_anthropic_messages() function - converts OpenAI-style ChatMessage to Anthropic's content blocks format
- Tool format conversion required for Anthropic - converts OpenAI-style Tool to AnthropicTool with different schema
- To add a new provider requires: new structs, new complete/stream methods, routing logic updates, format conversions, and streaming parser implementation
- Better architecture would need: Provider trait, separate provider implementations, factory pattern, and unified internal message format

**File References:** /home/mir-abir/Momo/bridge/src/llm.rs

**README vs Reality:** Not applicable - no README comparison requested

**Gaps/TODOs:**
- No retry logic or exponential backoff for transient failures
- No rate-limit detection or queuing mechanism
- No provider abstraction - difficult to extend with new providers
- Model list hardcoded instead of dynamic discovery
- No timeout configuration per provider
- No metrics or observability for provider health
- System prompt hardcoded in Anthropic requests instead of being configurable

## MCP Surface

- **Input validation defense-in-depth**: Ref format validation (`/^el_\d+$/`) enforced at THREE layers: (1) bridge-side in `mcp_tools.rs` validate_arguments (lines 218-248), (2) tool executor in `execute-action.ts` (lines 42-44, 63-64), and (3) perception layer query selector. README mentions validation but not this multi-layer enforcement.
- **Attribute lifecycle management**: `getInteractiveElements` STRIPS both `data-momo-ref` AND `data-momo-ref-id` before re-injection (perception.ts lines 222-223) to prevent stale refs from surviving re-renders. README §10.2 mentions two-attribute coexistence as 'temporary debt' but omits this active cleanup preventing cross-contamination.
- **Strict error mapping contract (M3)**: `map_command_result` (mcp_tools.rs lines 266-292) enforces: (1) any non-null `error` field → isError:true even if success:true present (inconsistent payloads fail), (2) missing `success` → 'malformed result', (3) non-boolean success (e.g. string 'false') → 'malformed result'. This is STRICTER than README §4.3 describes.
- **Two-phase audit logging**: Actions write audit entry at authorization time (Pending/Escalated), then `reportActionResult` (shared.ts lines 29-42) updates to Success/Failed after execution. This allows forensic reconstruction of 'authorized but never executed' vs 'executed and failed'. README mentions audit log but not this write-ahead pattern.
- **Sensitive field gate in type action**: Beyond policy engine, type action locally detects sensitive inputs via `isSensitiveInput(focused.field)` (execute-action.ts lines 196, 216-218) and forces confirmation even if policy allowed. README mentions field detection but not this secondary gate after policy approval.
- **Pre-authorization optimization**: `context.preAuthorized` flag (execute-action.ts lines 137-139, 199-202) skips bridge policy check when human already confirmed, preventing double token charge. README doesn't explain this human-in-the-loop bypass of the normal policy gate.
- **CDP session availability check**: Click and type actions check `context.getCdpSession()` availability (execute-action.ts lines 167-169, 220-223) and fail with 'CDP session unavailable' if missing. README describes CDP dispatch but not this dependency check.
- **Destructive action keyword detection**: `resolveRefStrict` (shared.ts lines 111-126) checks element text/labels against DESTRUCTIVE_KEYWORDS list (pay, buy, delete, logout, etc.) and form submit detection. Requires confirmation even if policy allowed. README mentions confirmation but not this semantic analysis.
- **Field metadata for policy**: Type action captures and sends (`type`, `autocomplete`, `name`, `id`) plus `text_length` and `field_is_sensitive` boolean to policy engine (execute-action.ts lines 203-206). Policy uses this for risk classification. README doesn't detail this metadata contract.
- **DOS protection in NDJSON framing**: `mcp_stdio.rs` (lines 36-86) enforces MAX_LINE_BYTES (1 MiB) with drain logic: overlength lines without newline are dropped and rest of line consumed to bounded memory. README describes NDJSON framing but not this attack surface mitigation.
- **Tab resolution fallback**: `resolveTargetTabId` (message-router.ts lines 118-130) validates tab_id is integer, then falls back to `chrome.tabs.query({ active: true, lastFocusedWindow: true })` for active tab. Throws 'No active tab' if query empty. README says 'omit for active tab' but not the fallback logic.
- **Redaction boundary at list_tabs**: Tab titles and URLs pass through `redactText()` (message-router.ts lines 206-207) before leaving extension. README §5.4 mentions redaction 'passes through existing layer' but doesn't specify it's applied in the command handler, not the tool definition.
- **Navigation occurrence tracking**: All tool results include `navigationOccurred: boolean` field (throughout execute-action.ts). Used by orchestrator to detect page transitions requiring perception refresh. README doesn't mention this output field.
- **Protocol version hardcoded**: `PROTOCOL_VERSION = '2024-11-05'` constant (mcp_tools.rs line 16). Returned in initialize, server doesn't negotiate. README §4.4 says 'target 2024-11-05' but not that it's a non-negotiable constant.
- **Command concurrency model**: Read commands (read_page_content, get_interactive_elements, list_tabs) run concurrently, execute_action is serialized per README §6.4. BUT implementation detail: bridge tracks concurrent pending Commands in registry keyed by request_id (ws_server.rs), extension serializes execute_action in CommandDispatcher. README describes policy but not the transport-layer correlation mechanism.
- **Scroll action window fallback**: When ref is undefined, scroll action scrolls window by 0.8 * innerHeight (execute-action.ts lines 102-103). When ref present, scrolls element's scrollTop. README doesn't mention this window-level scroll capability.
- **State computation for interactive elements**: `computeState` (perception.ts lines 202-211) derives state array from disabled, required, readonly, checked, aria-invalid, and focused (document.activeElement check). README §5.2 shows state in output but not the derivation logic.
- **Label computation priority**: `computeLabel` (perception.ts lines 183-200) uses aria-label → textContent (≤100 chars) → value (if not sensitive) → placeholder. Sensitive field values are suppressed via `isSensitiveInput` check. README shows label field but not this fallback chain or the sensitive-value suppression at perception time.
- **Tool result summary field**: Every tool returns `summary` string field (e.g. 'Clicked ref el_1', 'Scroll blocked: origin not allowed'). Used for logging and error messages. README shows success/error but not this human-readable summary in every response.
- **Action hash correlation**: `authorize()` returns `action_hash` (mcp_tools.rs line 86, shared.ts line 16) used to correlate `reportActionResult` back to audit entry. README describes audit trail but not this correlation token mechanism.

**File References:** /home/mir-abir/Momo/bridge/src/mcp_tools.rs, /home/mir-abir/Momo/bridge/src/mcp_stdio.rs, /home/mir-abir/Momo/bridge/src/ws_server.rs, /home/mir-abir/Momo/src/content/perception.ts, /home/mir-abir/Momo/src/sw/message-router.ts, /home/mir-abir/Momo/src/lib/tools/execute-action.ts, /home/mir-abir/Momo/src/lib/tools/shared.ts, /home/mir-abir/Momo/.kilo/worktrees/shiny-washer/PHASE9_MCP_PLAN.md, /home/mir-abir/Momo/README.md

**README vs Reality:** The README Phase 9 description (lines 114-118) accurately describes the high-level architecture: 4 MCP tools over stdio, dual-mode bridge, and policy enforcement. However, it omits significant implementation details:

**What README describes correctly**:
- Tool names and purposes (read_page_content, get_interactive_elements, execute_action, list_tabs)
- NDJSON JSON-RPC 2.0 transport over stdio
- Strict ref-only targeting with no CSS selector fallback
- Stale reference recovery with structured error hints
- Policy engine as trust boundary
- Multi-tab support via optional tab_id parameter

**What README omits**:
1. **Multi-layer validation**: Ref format validation enforced at 3 independent layers (bridge validation, tool execution, perception query)
2. **Strict result mapping**: Error detection is stricter than documented - inconsistent success+error payloads fail, non-boolean success fails
3. **Two-phase audit logging**: Authorization writes Pending entry, execution updates to Success/Failed
4. **Secondary safety gates**: Sensitive field detection and destructive keyword detection happen AFTER policy approval, can still block
5. **Pre-authorization optimization**: Human confirmation bypasses policy check to avoid double token charge
6. **DOS protection**: 1 MiB line size limit with drain logic in NDJSON parser
7. **Attribute lifecycle**: Active cleanup of both ref attribute types before re-injection to prevent stale refs
8. **CDP session dependency**: Click/type fail if CDP session unavailable
9. **Field metadata contract**: Type action sends field attributes and text_length to policy engine
10. **Correlation mechanisms**: action_hash token links authorization to execution result, request_id correlates Command/CommandResult
11. **Label/state derivation**: Specific algorithms for computing accessible names and state arrays from DOM
12. **Additional output fields**: navigationOccurred, summary, data fields in every tool result
13. **Scroll window fallback**: Can scroll window when no ref provided
14. **Redaction points**: Applied in command handler for list_tabs, in perception layer for sensitive values

The implementation is MORE defensive and MORE detailed than the README suggests, with defense-in-depth validation, multiple safety gates beyond policy engine, and careful error handling throughout the perception→validation→execution→audit pipeline.

**Gaps/TODOs:**
- Unify data-momo-ref and data-momo-ref-id: Two parallel ref attribute schemes coexist (perception.ts lines 222-236). Technical debt flagged in PHASE9_MCP_PLAN.md §10.2 to be unified in later phase.
- Per-session execute_action serialization: Currently globally serialized (message-router.ts comment about single-active-session). Multi-session parallelism deferred per PHASE9_MCP_PLAN.md §6.4.
- bridge_port file race: Mode A and Mode B can conflict on ~/.momo/bridge_port. PHASE9_MCP_PLAN.md §3.2 mentions distinct mcp_bridge_port as follow-up.
- Command cancellation best-effort: notifications/cancelled removes pending request but doesn't abort in-flight CDP action (PHASE9_MCP_PLAN.md §6.4). True interruption not implemented.
- Unsigned darwin binaries: Prebuilt binaries trigger Gatekeeper prompts. PHASE9_MCP_PLAN.md §9.4 flags codesigning as follow-up.
- Cross-origin Shadow DOM fallback: PHASE9_MCP_PLAN.md §5.5 flags capture_viewport (screenshot + VLM) as future fifth tool for canvas/obfuscated pages. Not in v1 scope.
- MCP SDK reference implementation tests: PHASE9_MCP_PLAN.md §11 calls for verification against @modelcontextprotocol/sdk stdio transport. Test coverage not visible in examined files.

## Extension Capabilities & Gaps

- Action Set: 10 fully implemented tools - navigate, click, type, scroll, extract, wait, observe, human_click, human_type, execute_action
- All actions use CDP for trusted input (Input.insertText, Input.dispatchMouseEvent) not synthetic events
- Dual reference system: data-momo-ref-id (momo-N) from perception, data-momo-ref (el_XX) from getInteractiveElements
- Stale reference recovery: resolveByRefStrict returns structured {status: stale_reference, ref, hint} when element missing/detached/hidden/non-actionable/zero-sized
- getInteractiveElements strips all [data-momo-ref] attributes before re-tagging to prevent stale refs surviving re-renders (perception.ts:222)
- Sensitive field detection: password, cc-*, cvv, cvc, card, api-key, token, authorization patterns in type/autocomplete/name/id
- Destructive click detection: pay/buy/delete/logout keywords + form submit controls trigger confirmation gate
- Policy enforcement: bridge authorization required for all write actions (navigate/click/type/scroll), confirmation flow for sensitive/destructive targets
- Perception layer: Readability + Turndown produces Markdown, injects ref_ids on actionable elements only
- No TODO/STUB/FIXME markers found in codebase - all listed tools are complete implementations
- Task queue infrastructure exists but underutilized - only periodic_observation/sync_state/cleanup handlers, no active background monitoring
- Verification system: only 4 types (elementVisible/Hidden, textContains, urlMatches), custom JS deliberately rejected (orchestrator.ts:531-534)
- Session recovery: interrupted sessions marked error on SW restart, working-copy preservation for resume, checkpoints every CHECKPOINT_INTERVAL steps

**File References:** /home/mir-abir/Momo/src/lib/tool-registry.ts, /home/mir-abir/Momo/src/sw/orchestrator.ts, /home/mir-abir/Momo/src/content/perception.ts, /home/mir-abir/Momo/src/content/ax-extractor.ts, /home/mir-abir/Momo/src/lib/tools/click.ts, /home/mir-abir/Momo/src/lib/tools/type.ts, /home/mir-abir/Momo/src/lib/tools/navigate.ts, /home/mir-abir/Momo/src/lib/tools/scroll.ts, /home/mir-abir/Momo/src/lib/tools/execute-action.ts, /home/mir-abir/Momo/src/lib/tools/shared.ts, /home/mir-abir/Momo/src/sw/message-router.ts

**README vs Reality:** README claims self-recovery from stale references - FULLY IMPLEMENTED with robust dual-ref system, explicit stale_reference error signaling, and getInteractiveElements cleanup strategy. No auto-retry at tool level (fail-loud design) but structured error allows bridge to re-fetch and retry. Navigation changes tracked via pageRevision counter incremented on navigationOccurred. README claims crash-resistant operation with WAL and checkpoints - PARTIALLY IMPLEMENTED: checkpoints work (every CHECKPOINT_INTERVAL steps to IndexedDB), interrupted sessions marked error on restart, but full WAL replay not observed (infrastructure exists in task-queue.ts with WalEntry/WalOperation types but minimal usage). README claims natural language planning - EXTERNAL: orchestrator executes pre-built Plan structures with steps/contingencies/verification faithfully but NL-to-plan conversion happens outside extension (bridge/LLM layer).

**Gaps/TODOs:**
- File upload - no tool for input[type=file] interaction
- Drag and drop - no CDP drag simulation
- Keyboard shortcuts - only Enter key via pressEnter flag, no Ctrl+C/V or multi-key combos
- Tab management - list_tabs exists but no switch_to_tab/activate_tab tool
- Iframe targeting - all tools use allFrames:false, no cross-frame actions
- Visual verification - no screenshot comparison or OCR capabilities
- Network interception - no request/response verification or header manipulation
- Shadow DOM - no penetration into shadow roots for element targeting
- Context menus - no right-click simulation
- Hover actions - mouseMoved used internally but not exposed as standalone tool
- Double-click and long-press - no multi-event gesture support
- Task queue underutilized - infrastructure exists for periodic observations but orchestrator runLoop does not actively schedule background tasks
- WAL replay - write-ahead log types defined but full replay not implemented (only checkpoint restore)
- Multi-frame coordination - no mechanism to target specific iframes or coordinate actions across frames

## Realistic Use Cases

- Momo is a Chrome MV3 extension + Rust bridge for secured local browser automation using YOUR authenticated sessions, cookies, and residential IP
- Core capability: navigate, click, type, scroll, extract via 10 registered tools with policy enforcement
- MCP integration works: 4 tools (read_page_content, get_interactive_elements, execute_action, list_tabs) over stdio JSON-RPC 2.0
- Fail-closed security is REAL: Rust PolicyEngine evaluates origin allowlist → action permissions → token budget → risk classification → confirmation requirements before ANY action executes
- Redaction engine is production-grade: strips passwords/tokens/PII/credit-cards before LLM context with 21 dedicated tests (most-tested module)
- Sensitive field detection: auto-flags password inputs, credit card fields by autocomplete/name/id patterns, fails closed when field_is_sensitive flag missing
- Destructive action detection: identifies submit/delete/payment/logout buttons via DESTRUCTIVE_KEYWORDS list, requires human confirmation
- Trusted input via CDP Input.dispatchMouseEvent: not synthetic JS events that sites can detect
- WebSocket authentication: per-install token from ~/.momo/auth_token, rejects non-chrome-extension origins at handshake
- Audit trail is immutable: SQLite log at ~/.momo/policy.db records authorization decisions, execution outcomes, timestamps, risk classifications
- Empty allowlist = deny EVERYTHING by design (unconfigured install cannot perform any actions)
- Redirects are re-validated: navigate checks final URL origin after redirect, denies if target origin not in allowlist
- Stale reference recovery: auto-retries with fresh element resolution in Mode A (orchestrator), but MCP clients must handle manually
- Chrome internal pages (chrome://) CANNOT be automated - extension cannot inject content scripts there
- Non-http(s) URLs blocked: javascript:, data:, file:, chrome:// all rejected by scheme hardening in navigate tool
- CRITICAL vulnerability: vitest 1.6.1 has RCE-class dev-server arbitrary file read/exec (GHSA advisory)
- HIGH vulnerability: vite 5.4.21 has path-traversal in .map handling
- orchestrator.ts is 1,312 lines with ZERO tests - core state machine robustness is unverified
- 8 silent .catch(() => {}) blocks swallow errors with no logging
- No CI/CD on pull requests - tests/lint only run on v* tag releases, broken code can reach main silently
- tool-registry.ts is 1,689 lines / 73KB - god file concentrating most tool execution risk
- 77 any type usages due to disabled ESLint rules (no-explicit-any, no-unused-vars, ban-ts-comment all off)
- Service worker suspension is known issue: Chrome can kill SW after 30s inactivity, interrupting long tasks
- Token budget enforced: default 100k tokens/task, resets every 24h, actions denied when exceeded
- Confirmation cannot be bypassed: even MCP clients cannot skip human approval for Dangerous/Payment/Auth classified actions
- MCP Mode B stale references: clients get isError:true with stale_reference, must re-fetch get_interactive_elements manually
- Optional permissions: debugger and <all_urls> requested on first use (least privilege), not pre-granted
- Security audit found ZERO credential leaks across entire git history
- Rust bridge uses std::env::var for API keys - never hardcoded, loaded at runtime only
- README uses placeholder sk-ant-... format, not real keys in documentation

**File References:** /home/mir-abir/Momo/bridge/src/policy.rs, /home/mir-abir/Momo/bridge/src/mcp_tools.rs, /home/mir-abir/Momo/src/lib/tool-registry.ts, /home/mir-abir/Momo/src/lib/tools/navigate.ts, /home/mir-abir/Momo/src/lib/tools/click.ts, /home/mir-abir/Momo/src/lib/tools/human-click.ts, /home/mir-abir/Momo/src/lib/redaction.ts, /home/mir-abir/Momo/manifest.json, /home/mir-abir/Momo/docs/audits/TECHNICAL_AUDIT.md, /home/mir-abir/Momo/docs/audits/SECURITY_AUDIT_REPORT.md, /home/mir-abir/Momo/docs/ARCHITECTURE.md, /home/mir-abir/Momo/README.md

**README vs Reality:** README claims are 80% accurate but omit critical prototype-level gaps. ACCURATE: (1) Policy-governed security is genuinely strong - Rust PolicyEngine with fail-closed model is real, not aspirational. (2) Redaction at source works - 21 tests prove passwords/tokens/PII stripped before LLM. (3) MCP integration delivers 4 tools over stdio as documented. (4) Local-first architecture uses YOUR Chrome profile with real cookies/IP. MISLEADING: (1) Autonomous execution and self-recovery are architectural concepts but core orchestrator has ZERO tests, so robustness unverified. (2) Crash-resistant operation via WAL/checkpoints exists in code but SW suspension is documented bug. OMITTED: (1) CRITICAL vitest RCE + HIGH vite vulnerabilities in build toolchain. (2) No CI/CD pipeline - broken code can reach main silently. (3) God-files (tool-registry 1,689 lines, orchestrator 1,312 lines) concentrate risk. (4) 8 silent error handlers swallow failures. VERDICT: Security model is production-grade, implementation has prototype-level gaps. Best for local dev/testing or MCP integration experiments, NOT production automation until vulnerabilities patched and test coverage added.

**Gaps/TODOs:**
- CRITICAL: Patch vitest 1.6.1 RCE vulnerability - upgrade to vitest 4.x
- HIGH: Patch vite 5.4.21 path-traversal vulnerability - upgrade to vite 6.x+
- HIGH: Add CI/CD pipeline for pull requests - run lint, typecheck, test on every PR to main
- HIGH: Add tests for orchestrator.ts core state machine - currently 0 tests for 1,312 lines
- MEDIUM: Fix 8 silent catch blocks - add error logging at minimum
- MEDIUM: Split tool-registry.ts god-file - extract 1,689 lines into per-tool modules
- MEDIUM: Re-enable ESLint rules - surface 77 any usages by changing no-explicit-any from off to warn
- MEDIUM: Add Rust CI - cargo test and cargo clippy not run in current release workflow
- LOW: Enable Dependabot - prevent dependency drift that produced current CVE backlog
- LOW: Add vitest.config.ts with coverage reporting - set 70% floor on src/lib and src/sw
- LOW: Remove committed .kilo/ directory - local worktree artifact with nested node_modules bloating repo
- LOW: Add .env* to .gitignore explicitly - defense-in-depth for credential protection

## Known Rough Edges

- warning_threshold field is persisted but has no associated logic—no warnings are emitted when token usage crosses 80%
- risk_thresholds struct with 6 numeric values is persisted but never consulted—risk classification is purely keyword-based, not threshold-based
- data_retention field (Session|Persistent) is defined and persisted but never enforced—no logic differentiates retention behavior
- ADR-0001 lists 'deduct_tokens' as step 6 but implementation merges it into step 4—documentation should be updated to reflect actual single-phase budget enforcement
- No retry logic or exponential backoff for transient failures
- No rate-limit detection or queuing mechanism
- No provider abstraction - difficult to extend with new providers
- Model list hardcoded instead of dynamic discovery
- No timeout configuration per provider
- No metrics or observability for provider health
- System prompt hardcoded in Anthropic requests instead of being configurable
- Unify data-momo-ref and data-momo-ref-id: Two parallel ref attribute schemes coexist (perception.ts lines 222-236). Technical debt flagged in PHASE9_MCP_PLAN.md §10.2 to be unified in later phase.
- Per-session execute_action serialization: Currently globally serialized (message-router.ts comment about single-active-session). Multi-session parallelism deferred per PHASE9_MCP_PLAN.md §6.4.
- bridge_port file race: Mode A and Mode B can conflict on ~/.momo/bridge_port. PHASE9_MCP_PLAN.md §3.2 mentions distinct mcp_bridge_port as follow-up.
- Command cancellation best-effort: notifications/cancelled removes pending request but doesn't abort in-flight CDP action (PHASE9_MCP_PLAN.md §6.4). True interruption not implemented.
- Unsigned darwin binaries: Prebuilt binaries trigger Gatekeeper prompts. PHASE9_MCP_PLAN.md §9.4 flags codesigning as follow-up.
- Cross-origin Shadow DOM fallback: PHASE9_MCP_PLAN.md §5.5 flags capture_viewport (screenshot + VLM) as future fifth tool for canvas/obfuscated pages. Not in v1 scope.
- MCP SDK reference implementation tests: PHASE9_MCP_PLAN.md §11 calls for verification against @modelcontextprotocol/sdk stdio transport. Test coverage not visible in examined files.
- File upload - no tool for input[type=file] interaction
- Drag and drop - no CDP drag simulation
- Keyboard shortcuts - only Enter key via pressEnter flag, no Ctrl+C/V or multi-key combos
- Tab management - list_tabs exists but no switch_to_tab/activate_tab tool
- Iframe targeting - all tools use allFrames:false, no cross-frame actions
- Visual verification - no screenshot comparison or OCR capabilities
- Network interception - no request/response verification or header manipulation
- Shadow DOM - no penetration into shadow roots for element targeting
- Context menus - no right-click simulation
- Hover actions - mouseMoved used internally but not exposed as standalone tool
- Double-click and long-press - no multi-event gesture support
- Task queue underutilized - infrastructure exists for periodic observations but orchestrator runLoop does not actively schedule background tasks
- WAL replay - write-ahead log types defined but full replay not implemented (only checkpoint restore)
- Multi-frame coordination - no mechanism to target specific iframes or coordinate actions across frames
- CRITICAL: Patch vitest 1.6.1 RCE vulnerability - upgrade to vitest 4.x
- HIGH: Patch vite 5.4.21 path-traversal vulnerability - upgrade to vite 6.x+
- HIGH: Add CI/CD pipeline for pull requests - run lint, typecheck, test on every PR to main
- HIGH: Add tests for orchestrator.ts core state machine - currently 0 tests for 1,312 lines
- MEDIUM: Fix 8 silent catch blocks - add error logging at minimum
- MEDIUM: Split tool-registry.ts god-file - extract 1,689 lines into per-tool modules
- MEDIUM: Re-enable ESLint rules - surface 77 any usages by changing no-explicit-any from off to warn
- MEDIUM: Add Rust CI - cargo test and cargo clippy not run in current release workflow
- LOW: Enable Dependabot - prevent dependency drift that produced current CVE backlog
- LOW: Add vitest.config.ts with coverage reporting - set 70% floor on src/lib and src/sw
- LOW: Remove committed .kilo/ directory - local worktree artifact with nested node_modules bloating repo
- LOW: Add .env* to .gitignore explicitly - defense-in-depth for credential protection
