# Changelog

All notable changes to this project are documented in this file. The format
mirrors the GitHub Release notes and follows [Conventional Commits](https://www.conventionalcommits.org/)
so changes can be auto-categorized going forward.

Category mapping to Conventional Commit types:

| Section | Commit types |
|---------|--------------|
| 💥 Breaking Changes | `feat!`, `fix!`, `refactor!`, or `BREAKING CHANGE:` in the body |
| 🚀 Features | `feat:` |
| 🐛 Fixes | `fix:` |
| 🧰 Chore / Internal | `chore:`, `refactor:`, `docs:`, `style:`, `test:`, `ci:`, `perf:` |

---

## [Unreleased]

Security remediation of the external audit (`audit-report.md`, audited revision
`bb99b6af`). Fixes 2 critical, 6 high, 4 medium, and 4 low findings, plus two
additional Rust build blockers the audit missed. `chrome.debugger` is now the
sole input path; the Rust bridge is the authoritative policy boundary.

### 🔒 Security

- **C1 — Enforce policy on trusted input.** `human_click` / `human_type` /
  `human_scroll` / `human_mouse_move` now authorize through the bridge's
  `SIMULATE_*` endpoint (`policy_engine.evaluate`) before executing, and only
  execute the returned action via `chrome.debugger` on `allowed`. The extension
  no longer self-authorizes.
- **C2 — Redact secrets at the source.** Added `src/lib/redaction.ts`
  (`isSensitiveInput`, `redactText`, `redactInputValue`); applied in
  `ax-extractor.ts`, `dom-compressor.ts`, `persistence.ts`, and `llm-client.ts`
  so passwords, tokens, card numbers, and PII never reach DOM snapshots,
  persisted state, or the LLM.
- **H7 — Fail-closed, look-alike-safe allowlist.** `policy.rs` now uses
  exact-or-subdomain-bounded matching (`host == domain || host.endsWith("." + domain)`);
  an empty allowlist denies all. Closes the `evil-example.com` suffix bypass and
  the empty-allowlist-allow-all default.
- **M3 — Remove `eval` verification.** Replaced the `eval`-based custom
  verification with structured, non-`eval` checks (no arbitrary JS execution).
- **M4 — Stop leaking typed text.** `human_type` no longer returns typed text in
  its summary; sensitive values are redacted before entering `state.history`.

### 🐛 Fixes

- **H1 — Native-message type casing.** Added
  `#[serde(rename_all = "SCREAMING_SNAKE_CASE")]` to `BridgeRequest`; aligned
  remaining message strings between the extension and the bridge.
- **H2 — Bridge build blocker.** Removed the unused, unavailable `llama-cpp-2`
  dependency (LLM goes through `reqwest`); the bridge now compiles.
- **H3/H4/H5 — Removed dead CDP layer.** Deleted `cdp.rs` and `simulation.rs`
  (raw-WebSocket CDP, private `CdpManager`, undeliverable responses, discarded
  command errors); `chrome.debugger` is the sole input path.
- **H6 — All-frame duplication.** CDP input/extract now target the active tab's
  `tabId` with `allFrames: false` instead of fanning out to every frame.
- **H8 — Kill switch propagates.** `OFFSCREEN_KILLED` now sends `SHUTDOWN` to the
  bridge and aborts the running task.
- **H9 — LLM traffic consolidated through the Rust bridge.** There is no
  `llm-worker.ts`; LLM calls route through the service worker to the bridge's
  `LlmGateway` over the authenticated WebSocket.
- **M1 — Real session identity.** Tasks now carry an explicit `sessionId` field
  instead of deriving it from the task-id string.
- **M2 — Stale-task recovery.** `task-queue.ts` requeues stranded
  `running`/`pending` tasks on init.
- **M5 — Offscreen events consumed.** Registered handlers for `LLM_RESPONSE`,
  `LLM_STREAM_CHUNK`, `SIMULATION_COMPLETE`, `PERSIST_STATE`, and `OFFSCREEN_KILLED`.
- **M6 — CDP listener leak.** `cdp-adapter.ts` `detach()` removes the
  `onEvent`/`onDetach` listeners added in `attach()`.
- **L1/L2 — Real session management.** `GET_SESSIONS` returns actual sessions;
  `DELETE_SESSION` deletes them.
- **L3 — STOP_TASK aborts.** `handleStopTask` now calls `orchestrator.abortTask()`.

### 🧰 Chore / Internal

- **L4 — Tooling.** Added ESLint (flat config) to devDeps; drove
  `npx tsc --noEmit` and `npm run lint` to clean; pinned `tsconfig.json` to
  ES2023 with `skipLibCheck`.
- **Tests.** Added unit tests for policy allowlist matching (Rust) and redaction
  (TypeScript); `cargo test` and `npm run test` now run 4 and 12 tests.

---

## [v0.2.0-legacy] — 2026-08-16

First complete implementation of the Autonomous AI Browser Extension — a fully
local, Manifest V3 Chrome extension that executes complex multi-step browser
tasks using your authenticated sessions, residential IP, and local hardware.

**Commit:** `fbac93f` · **Base:** `v0.1.0-legacy` (`4f8f6b9`)

### What this version does

- **Autonomous task execution** — describe a goal in natural language; the agent plans, acts, verifies, and recovers.
- **Local-first architecture** — runs entirely in the browser; no cloud browser, no data leaves the machine unless cloud LLM fallbacks are configured.
- **Real user context** — uses the actual Chrome profile: cookies, sessions, certificates, HSTS, behavioral history.
- **Anti-bot resilient by design** — not evasion: real TLS (BoringSSL), HTTP/2 (nghttp2), residential IP, genuine fingerprint.
- **Policy-governed** — allowlists, risk classification, confirmation gates, audit logging, token budgets.
- **Human-in-the-loop** — confirm/deny/takeover for sensitive actions (payments, auth, dangerous ops).
- **Crash recovery** — write-ahead log + checkpoints in IndexedDB; survives SW kills, browser restarts, crashes.
- **Side Panel UI** — real-time streaming, plan visualization, session management, intervention modals.

### 💥 Breaking Changes

- First functional release — no prior extension code to migrate from (`v0.1.0-legacy` was an empty README scaffold).
- `debugger` and `<all_urls>` permissions moved to `optional_permissions` / `optional_host_permissions`; the `debugger` permission is now requested at runtime via `chrome.permissions.request` on first CDP attach (`ensureDebuggerPermission`, `src/lib/permissions.ts`), and denial degrades gracefully (CDP stays disabled until granted).
- Native messaging host (`bridge/agent.bridge.json`) must be installed with `__EXTENSION_ID__` replaced by the loaded extension's ID.

### 🚀 Features

- **Manifest V3 architecture** — service worker, offscreen document, side panel, content scripts.
- **Service Worker** — `orchestrator.ts` state machine (pause/resume, page revision, idempotency keys, token budget), `message-router.ts` (13 handlers), `alarm-manager.ts` (keepalive/checkpoint/watchdog trilogy), `cdp-adapter.ts` (`chrome.debugger` wrapper).
- **CDP via `chrome.debugger`** — no raw WebSocket to `localhost:9222`; sessions initiated by the extension.
- **Native Messaging host (Rust)** — JSON-RPC over stdio; CDP session multiplexer; `InputExecutor` for trusted `Input.dispatchMouseEvent`/`dispatchKeyEvent`.
- **Policy engine** — SQLite audit log, allowlist validation, token budgets, risk classification (Read/Write/Navigation/Payment/Auth/Dangerous), confirmation policy (Always/Sensitive/Never).
- **LLM client** — multi-provider (Ollama / Anthropic / OpenAI), JSON Schema tool validation, streaming, redaction layer (strips passwords/secrets/PII/credit cards/tokens).
- **Tool registry** — 12 policy-compliant tools with risk classification, confirmation gates, data classification, token cost tracking.
- **AX tree extraction** — CDP `Accessibility.getFullAXTree` with JS fallback; 10–50x smaller than raw DOM.
- **Offscreen document** — WebLLM worker, watchdog, metrics UI, kill switch.
- **Side Panel (React)** — streaming chat, plan visualization, session history, human intervention modal with action-hash + page-revision binding.
- **Persistence** — IndexedDB (Dexie) with WAL + checkpoints, serialized via SuperJSON.
- **Task queue** — priority queue with retry policies, exponential backoff, dead-letter handling.

### 🐛 Fixes

- Vite build: removed deleted entry points (`fingerprint-guard.ts`, `anti-bot.ts`); fixed `llm-worker.ts` dynamic import.
- Alarm manager: watchdog period corrected from 0.5 → 1 minute.
- Orchestrator: `checkUrlMatches` made async; fixed `verifyStep` caller.
- Icons: PNG icons generated from source image; manifest updated to reference PNG paths.

### 🧰 Chore / Internal

- Removed evasion code (`anti-bot.ts` 364 lines, `fingerprint-guard.ts` 227 lines) per Architecture Blueprint Section 7.
- Bridge rewrite: `simulation.rs` → `InputExecutor`; removed Perlin noise, spring-damper, distribution sampling, micro-jitter, dwell/flight-time distributions, error injection.
- Content `human-input.ts`: removed spring-damper, Perlin noise, distribution sampling, error injection; kept `dispatchEvent` with `isTrusted: false` warning.
- Dependencies: added `superjson`; added `rusqlite`, `dirs`, `md-5` to `bridge/Cargo.toml`; pinned dependencies, removed unpinned git dependency.

---

## [v0.1.0-legacy] — 2026-08-16

Initial repository scaffold — README only. Baseline tag for the legacy release line.

**Commit:** `4f8f6b9`

### What this version does

- Minimal starting point containing only the project README. No extension code, no build artifacts, no functional components.
- Serves as the historical baseline for the legacy release line.

### How to install/build

> Not applicable — this version contains no buildable extension code.

### 🧰 Chore / Internal

- Initial commit: `README.md`.

---

## How to install/build

```bash
# Install extension dependencies
npm install

# Build extension (Vite → dist/)
npm run build

# Build native messaging host (Rust → target/release/agent-bridge)
npm run build:bridge

# Or build both
npm run build:all

# Watch mode (rebuilds on change)
npm run dev

# Run tests / lint
npm run test
npm run lint
```

See `CONTRIBUTING.md` for the full contribution and release workflow.
