# v0.2.0-legacy — Full Autonomous AI Browser Extension

**Released:** 2026-08-16
**Commit:** `fbac93f`
**Base:** `v0.1.0-legacy` (`4f8f6b9`)

---

## What this version does

This is the **first complete implementation** of the Autonomous AI Browser Extension — a fully local, Manifest V3 Chrome extension that executes complex multi-step browser tasks using your authenticated sessions, residential IP, and local hardware.

### Core Capabilities

- **Autonomous task execution** — Describe a goal in natural language; the agent plans, acts, verifies, and recovers
- **Local-first architecture** — Runs entirely in your browser; no cloud browser, no data leaves your machine unless you configure cloud LLM fallbacks
- **Real user context** — Uses your actual Chrome profile: cookies, sessions, certificates, HSTS, behavioral history
- **Anti-bot resilient by design** — Not evasion: real TLS (BoringSSL), HTTP/2 (nghttp2), residential IP, genuine fingerprint
- **Policy-governed** — Allowlists, risk classification, confirmation gates, audit logging, token budgets
- **Human-in-the-loop** — Confirm/deny/takeover for sensitive actions (payments, auth, dangerous ops)
- **Crash recovery** — Write-ahead log + checkpoints in IndexedDB; survives SW kills, browser restarts, crashes
- **Side Panel UI** — Real-time streaming, plan visualization, session management, intervention modals

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Chrome Extension (Manifest V3)                                 │
├─────────────────────────────────────────────────────────────────┤
│  Service Worker (Orchestrator)  ◄──►  Offscreen Document        │
│  - Task queue, alarms, WAL       │  - WebLLM / local inference  │
│  - State machine, checkpoints    │  - Watchdog, metrics         │
│  - Message routing               │  - Kill switch               │
├─────────────────────────────────────────────────────────────────┤
│  Content Scripts (ISOLATED world)    │  Side Panel (React)      │
│  - AX tree extraction (CDP)          │  - Streaming chat UI     │
│  - MutationObserver                  │  - Plan visualization    │
│  - Human input fallback              │  - Session history       │
├─────────────────────────────────────────────────────────────────┤
│  Native Messaging Host (Rust)                              │
│  - JSON-RPC over stdio (primary)                           │
│  - CDP session multiplexer (tabs, iframes, workers)        │
│  - LLM gateway: Ollama (local) + Anthropic/OpenAI (cloud)  │
│  - InputExecutor: CDP Input API for trusted events         │
│  - Policy engine: SQLite audit log, allowlists, budgets    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Components

### Service Worker (`src/sw/`)
- **Orchestrator** (`orchestrator.ts`) — Full state machine with pause/resume, page revision tracking, idempotency keys, token budget tracking, public `captureDomSnapshot()`
- **Message Router** (`message-router.ts`) — 13 handlers: `START_TASK`, `STOP_TASK`, `PAUSE_TASK`, `RESUME_TASK`, `GET_STATE`, `EXECUTE_TOOL`, `GET_DOM_SNAPSHOT`, `HUMAN_RESPONSE`, `GET_SESSIONS`, `DELETE_SESSION`, `CDP_COMMAND`, `CDP_ATTACH_REQUEST`, `CDP_GET_TARGETS`, `CDP_DETACH`
- **Alarm Manager** (`alarm-manager.ts`) — Trilogy: keepalive (1 min), checkpoint (5 min), watchdog (1 min minimum)
- **CDP Adapter** (`cdp-adapter.ts`) — `chrome.debugger` API wrapper (no raw remote-debugging port)

### Content Scripts (`src/content/`)
- **AX Extractor** (`ax-extractor.ts`) — CDP `Accessibility.getFullAXTree` with JS fallback; MutationObserver for incremental updates
- **Human Input** (`human-input.ts`) — Fallback simulation (untrusted events); dispatches MouseEvent/KeyboardEvent with JSDoc warnings
- **DOM Observer** (`dom-observer.ts`) — Tracks DOM mutations for cache invalidation

### Offscreen Document (`src/offscreen/`)
- **Main** (`index.ts`) — LLM worker management, simulation engine, watchdog, metrics loop, **kill switch handler** (terminates all offscreen processes)
- **HTML** (`index.html`) — Metrics dashboard (memory, uptime, LLM/simulation status), structured logs, kill switch button
- **LLM Worker** (`llm-worker.ts`) — WebLLM proxy (dynamic import for build compatibility)

### Native Messaging Host (`bridge/src/`)
- **Main** (`main.rs`) — JSON-RPC server, routes to CDP manager, LLM gateway, InputExecutor, PolicyEngine
- **CDP Manager** (`cdp.rs`) — Extension-initiated CDP sessions only (no localhost:9222); multi-target multiplexer
- **InputExecutor** (`simulation.rs`) — CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` for trusted events
- **Policy Engine** (`policy.rs`) — SQLite audit log, allowlist validation, token budget, risk classification (Read/Write/Navigation/Payment/Auth/Dangerous), confirmation policy (Always/Sensitive/Never)
- **LLM Gateway** (`llm.rs`) — Ollama + Anthropic/OpenAI with circuit breaker

### Side Panel (`src/sidepanel/`)
- **App** (`index.tsx`) — Streaming chat, plan visualization (step-by-step with status), session list, human intervention modal (Confirm/Deny/Takeover with action hash + page revision binding)

### Persistence (`src/lib/`)
- **Dexie + WAL** (`persistence.ts`) — IndexedDB with SuperJSON serialization; sessions, WAL entries, checkpoints, task queue, DOM cache
- **Task Queue** (`task-queue.ts`) — Priority queue with retry policies, exponential backoff, dead-letter handling

### Tool Registry (`src/lib/tool-registry.ts`)
Policy-compliant tools with:
- Risk classification: `read`, `write`, `navigation`, `payment`, `auth`, `dangerous`
- Confirmation gates per risk class and `confirmationPolicy`
- Data classification: `public`, `internal`, `pii`, `secret`
- Token cost tracking per tool call

### LLM Client (`src/lib/llm-client.ts`)
- Multi-provider: Ollama (local), Anthropic, OpenAI
- **Redaction layer** — Strips passwords, secrets, PII, credit cards, tokens from observations before LLM
- JSON Schema validation for tool calls
- Streaming support

---

## How to install/build

### Prerequisites
- Node.js 18+ and npm
- Rust 1.70+ (for native messaging host)
- Chrome/Chromium 118+ (Manifest V3, `chrome.debugger`)

### Build from source

```bash
# Install extension dependencies
npm install

# Build extension (Vite → dist/)
npm run build

# Build native messaging host (Rust → bridge/target/release/agent-bridge)
npm run build:bridge

# Or build both
npm run build:all
```

### Install in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `Momo/` directory (repo root with `manifest.json`)
4. Install native messaging host:
   - Copy `bridge/agent.bridge.json` to your OS native messaging directory:
     - **Linux:** `~/.config/google-chrome/NativeMessagingHosts/`
     - **macOS:** `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
     - **Windows:** `%USERPROFILE%\AppData\Local\Google\Chrome\User Data\NativeMessagingHosts\`
   - Edit `agent.bridge.json` → replace `__EXTENSION_ID__` with the extension ID from `chrome://extensions/`
   - Ensure the binary path points to `bridge/target/release/agent-bridge`

### Development

```bash
# Watch mode (rebuilds on change)
npm run dev

# Run tests
npm run test

# Lint
npm run lint
```

### Package.json Scripts

| Script | Description |
|--------|-------------|
| `dev` | Vite watch mode |
| `build` | Production build to `dist/` |
| `build:bridge` | Cargo build --release for native host |
| `build:all` | Both extension and bridge |
| `test` | Vitest run |
| `lint` | ESLint on `src/` |

---

## What Changed Since v0.1.0-legacy

**Everything.** v0.1.0-legacy was an empty scaffold (README only). This release delivers the complete extension.

### Major/Architectural Changes

| Area | Description |
|------|-------------|
| **Manifest V3** | `manifest.json` with minimal permissions; `debugger` and `<all_urls>` moved to `optional_permissions` / `optional_host_permissions`; service worker, offscreen document, side panel, content scripts declared |
| **Native Messaging** | `bridge/agent.bridge.json` with build-time `__EXTENSION_ID__` placeholder; Rust host with JSON-RPC over stdio |
| **CDP via `chrome.debugger`** | **No raw WebSocket to localhost:9222** — all CDP sessions initiated by extension via `chrome.debugger.attach()`; bridge manages sessions only |
| **Policy Engine** | SQLite audit log (`bridge/src/policy.rs`), allowlist validation, token budgets, risk classification, confirmation gates |
| **Human-in-the-Loop** | Orchestrator promises bound to action hash + page revision; Side Panel modal with Confirm/Deny/Takeover |
| **Crash Recovery** | WAL + checkpoints in IndexedDB (Dexie + SuperJSON); resume from last checkpoint + replay WAL |
| **SW Lifecycle Trilogy** | Alarms (keepalive/checkpoint/watchdog) + Offscreen Document + persistent Port |
| **Redaction Layer** | Automatic stripping of passwords, secrets, PII, credit cards, tokens from LLM observations |

### Minor/Feature Changes

- **LLM Client**: Multi-provider (Ollama/Anthropic/OpenAI) with JSON Schema tool validation
- **Tool Registry**: 12 policy-compliant tools (`navigate`, `click`, `type`, `extract`, `scroll`, `wait`, `observe`, `human_click`, `human_type`, etc.) with risk classification
- **AX Tree Extraction**: CDP `Accessibility.getFullAXTree` with JS fallback; 10-50x smaller than raw DOM
- **Offscreen Document**: WebLLM worker, watchdog, metrics UI, kill switch
- **Side Panel**: React UI with streaming, plan viz, session history, intervention modal
- **Task Queue**: Persistent priority queue with retry policies and dead-letter handling
- **Automation Hygiene**: Minimal — only `navigator.webdriver = undefined` (no evasion techniques)

### Patch/Fixes

- **Vite build fixes**: Removed deleted entry points (`fingerprint-guard.ts`, `anti-bot.ts`); fixed `llm-worker.ts` dynamic import
- **Alarm manager**: Watchdog period corrected from 0.5 → 1 minute
- **Orchestrator**: `checkUrlMatches` made async; fixed `verifyStep` caller
- **Icons**: PNG icons generated from source image; manifest updated to reference PNG paths

### Internal/Chore

- **Deleted evasion code**: `anti-bot.ts` (364 lines), `fingerprint-guard.ts` (227 lines) — removed per Architecture Blueprint Section 7
- **Bridge rewrite**: `simulation.rs` → `InputExecutor`; removed Perlin noise, spring-damper, log-normal/gamma/weibull distributions, micro-jitter, dwell/flight time distributions, error injection
- **Content human-input**: Removed spring-damper, Perlin noise, distribution sampling, error injection; kept basic `dispatchEvent` with `isTrusted: false` warning
- **Dependencies**: Added `superjson` for persistence serialization; `rusqlite`, `dirs`, `md-5` in Rust Cargo.toml
- **Cargo.toml**: Pinned dependencies; removed unpinned git dependency

---

## Breaking Changes / Migration Notes

| From v0.1.0-legacy | Action Required |
|--------------------|-----------------|
| No extension code existed | Fresh install required |
| Native messaging host must be installed | Copy `agent.bridge.json` to OS native messaging dir; update extension ID and binary path |
| `debugger` permission is optional | User will be prompted on first CDP attach |
| `<all_urls>` is optional | User will be prompted on first cross-origin access |

---

## Release Assets

- **Source code**: Full repository at tag `v0.2.0-legacy`
- **Built extension**: `dist/` folder (generated by `npm run build`)
- **Native host binary**: `bridge/target/release/agent-bridge` (generated by `npm run build:bridge`)

> **Note**: Attach `dist/` as a zip and the native host binary to the GitHub Release for easy installation.

---

## What's Next (v0.3.0+ roadmap)

- [ ] Test suite (unit, integration, E2E)
- [ ] Minification + structured logging cleanup
- [ ] Bridge build integration in CI + Cargo.lock pin
- [ ] Offscreen WebLLM worker full implementation
- [ ] Chrome Web Store packaging
- [ ] Auto-update via GitHub Releases