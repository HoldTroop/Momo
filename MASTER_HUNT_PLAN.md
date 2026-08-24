# Momo Project — Extreme Deep Hunt Master Plan

**Target**: Autonomous AI Browser Extension (Manifest V3 + Rust Bridge)  
**Scope**: Full codebase — Extension (TypeScript/React), Bridge (Rust), Content Scripts, Policy Engine, MCP Layer, CDP Integration  
**Mode**: Ponytail Ultra — YAGNI extremist, deletion before addition, shortest working diff  
**Sub-agents**: 30+ specialized hunters deployed in parallel

---

## Project Architecture Summary (for hunter context)

```
┌─────────────────────────────────────────────────────────────────┐
│  Chrome Extension (Manifest V3, TypeScript)                     │
├─────────────────────────────────────────────────────────────────┤
│  Service Worker                   │  Side Panel (React)         │
│  - AgentOrchestrator              │  - Real-time streaming UI   │
│  - MessageRouter                  │  - Task intervention        │
│  - CDP adapter                    │  - Session management       │
│  - WebSocket client (to bridge)   │  - Confirmation modals      │
├─────────────────────────────────────────────────────────────────┤
│  Content Scripts (ISOLATED world)                               │
│  - Accessibility tree extraction (CDP + JS fallback)            │
│  - Perception layer (Markdown + interactive elements)           │
│  - DOM observation (MutationObserver)                           │
│  - Human input fallback (untrusted events)                      │
├─────────────────────────────────────────────────────────────────┤
│  Libraries                                                       │
│  - Tool registry (navigate, click, type, scroll, observe)       │
│  - Persistence layer (Dexie IndexedDB with WAL)                 │
│  - Redaction engine (passwords, tokens, PII, credit cards)      │
│  - Selector heuristics (isActionable, resolveTarget)            │
└─────────────────────────────────────────────────────────────────┘
                               ▲
                               │ WebSocket (ws://127.0.0.1:9090-9100)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Rust Bridge (agent-bridge, Tokio + Axum)                      │
├─────────────────────────────────────────────────────────────────┤
│  Mode A: Internal Orchestration  │  Mode B: MCP over stdio     │
│  - LLM gateway (Anthropic/Ollama)│  - JSON-RPC 2.0 (NDJSON)    │
│  - Policy engine                 │  - Tool dispatch to WS       │
│  - Audit log (SQLite)            │  - Command/CommandResult     │
├─────────────────────────────────────────────────────────────────┤
│  Core Services                                                   │
│  - WebSocket server (ConnectionManager)                         │
│  - Command channel (send_command with pending registry)         │
│  - Policy enforcement (origin, actions, budget, confirmation)   │
│  - Trusted input executor (CDP Input API)                       │
└─────────────────────────────────────────────────────────────────┘
```

**Trust Boundary**: Rust bridge is the authoritative policy boundary. Extension never self-authorizes; all actions pass through `PolicyEngine::evaluate` before execution.

---

## 30+ Specialized Sub-Agent Deployment

Each sub-agent runs autonomously with a specific hunting mandate. Agents report findings to the aggregation layer.

### Tier 1: Security & Trust Boundary Hunters (8 agents)

| Agent ID | Mandate | Target Files | Key Questions |
|----------|---------|--------------|---------------|
| **SEC-01** | Policy Engine Bypass | `bridge/src/policy.rs` | Can `check_origin` be confused by IDN, punycode, or subdomain tricks? Does `permitted_actions` empty-check in MCP mode actually deny-by-default? |
| **SEC-02** | Authentication & Token Handling | `bridge/src/main.rs:78-99`, `ws_server.rs:78-83` | Is `MOMO_AUTH_TOKEN` entropy sufficient? Can token be leaked via logs, error messages, or timing? |
| **SEC-03** | WebSocket Origin Validation | `bridge/src/ws_server.rs:526-546` | Does `origin_allowed` properly reject `null`, `file://`, `http://`? Is `MOMO_EXTENSION_ID` enforced in production? |
| **SEC-04** | Command Channel Injection | `bridge/src/ws_server.rs:240-292`, `mcp_tools.rs:129-161` | Can `send_command` be raced? Can `request_id` collision cause cross-session command hijacking? |
| **SEC-05** | Audit Log Integrity | `bridge/src/policy.rs:510-564` | Can `action_hash` collision allow audit entry overwrites? Is `update_audit_outcome` race-safe? |
| **SEC-06** | Redaction Engine Completeness | `src/lib/redaction.ts` + tests | Does redaction catch all secret patterns (JWT, AWS keys, GCM, Slack tokens, private keys)? |
| **SEC-07** | CDP Command Allowlist Bypass | `src/sw/message-router.ts:20-23, 379-382` | Can a compromised content script escalate to `Runtime.evaluate` or `Input.*` via domain/command confusion? |
| **SEC-08** | CSP & Extension Surface | `manifest.json`, `vite.config.ts` | Are `content_security_policy` directives tight? Can side panel be framed? |

### Tier 2: Injection & Input Validation Hunters (6 agents)

| Agent ID | Mandate | Target Files | Key Questions |
|----------|---------|--------------|---------------|
| **INJ-01** | SQL Injection in Policy Engine | `bridge/src/policy.rs:171-202, 510-564` | Are all `rusqlite` queries parameterized? Any dynamic SQL construction? |
| **INJ-02** | Command Injection in Bridge | `bridge/src/main.rs`, `mcp_stdio.rs` | Any `std::process::Command`, shell interpolation, or `serde_json` deserialization into exec? |
| **INJ-03** | XSS in Side Panel | `src/sidepanel/index.tsx` | Does React rendering sanitize `markdown_content` from perception? Any `dangerouslySetInnerHTML`? |
| **INJ-04** | Prototype Pollution | `src/lib/tool-registry.ts:68-114`, `src/lib/persistence.ts` | Can `Object.prototype` pollution via `toolCall.arguments` affect validation or Dexie? |
| **INJ-05** | Path Traversal in Bridge | `bridge/src/main.rs:80-86` | Does `dirs::data_dir()` + join allow `../../` escape? Is `policy.db` path validated? |
| **INJ-06** | JSON-RPC/NDJSON Smuggling | `bridge/src/mcp_stdio.rs:33-96` | Can oversized lines, missing newlines, or UTF-8 bombs break the parser? |

### Tier 3: Business Logic & State Machine Hunters (6 agents)

| Agent ID | Mandate | Target Files | Key Questions |
|----------|---------|--------------|---------------|
| **BIZ-01** | Orchestrator State Machine | `src/sw/orchestrator.ts:166-395` | Can `runToken` race with `isRunning`? Can `pause`/`resume` leave state inconsistent? |
| **BIZ-02** | Session Resumption Logic | `src/sw/orchestrator.ts:979-1024` | Does `resumeSession` properly validate working copy vs redacted copy? Can stale session be resumed? |
| **BIZ-03** | Checkpoint & WAL Integrity | `src/sw/checkpoint.ts`, `src/lib/persistence.ts` | Can checkpoint corruption cause silent data loss? Is WAL position monotonic? |
| **BIZ-04** | Human Intervention Flow | `src/sw/confirmation.ts`, `orchestrator.ts:529-551` | Can confirmation timeout be bypassed? Can `takeover` leave orphaned CDP sessions? |
| **BIZ-05** | Token Budget Enforcement | `bridge/src/policy.rs:363-406` | Is token accounting atomic? Can concurrent evaluations race the budget check? |
| **BIZ-06** | Per-Session Command Serialization | `src/sw/orchestrator.ts:479-504` | Does `sessionExecutionQueues` properly isolate sessions? Can queue leak on error? |

### Tier 4: CDP & Browser Integration Hunters (4 agents)

| Agent ID | Mandate | Target Files | Key Questions |
|----------|---------|--------------|---------------|
| **CDP-01** | CDP Session Lifecycle | `src/sw/cdp-lifecycle.ts`, `orchestrator.ts:192-196, 522-526` | Can tab close/navigation leave dangling CDP session? Is `sessionId` validated before reuse? |
| **CDP-02** | Trusted Input Simulation | `src/lib/tools/execute-action.ts`, `human-click.ts`, `human-type.ts` | Does CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent` properly simulate trusted events? Any fallback to untrusted? |
| **CDP-03** | AX Tree Extraction Reliability | `src/content/ax-extractor.ts`, `perception.ts:216-254` | Can stale `data-momo-ref` attributes cause `resolveByRefStrict` to target wrong element? |
| **CDP-04** | Port Discovery & Binding | `bridge/src/main.rs:451-511` | Can port exhaustion (9090-9100) cause bridge startup failure? Race condition in fixed-port binding? |

### Tier 5: MCP Protocol & Interop Hunters (4 agents)

| Agent ID | Mandate | Target Files | Key Questions |
|----------|---------|--------------|---------------|
| **MCP-01** | MCP Protocol Compliance | `bridge/src/mcp_stdio.rs`, `mcp_tools.rs` | Full JSON-RPC 2.0 compliance? Notification handling? `cancelled` semantics? |
| **MCP-02** | Tool Schema Validation | `bridge/src/mcp_tools.rs:218-248` | Does `validate_arguments` catch all malformed `execute_action` params? Unknown action enum? |
| **MCP-03** | Bridge↔Extension Command Roundtrip | `bridge/src/ws_server.rs:240-292`, `message-router.ts:78-118` | Can `CommandResult` be spoofed? Is `request_id` correlation foolproof? |
| **MCP-04** | Mode A ↔ Mode B State Sharing | `bridge/src/main.rs:417-433, 525-566` | Does `ConnectionManager` shared state leak between modes? Can MCP mode pollute WS mode? |

### Tier 6: Denial-of-Service & Resource Exhaustion (3 agents)

| Agent ID | Mandate | Target Files | Key Questions |
|----------|---------|--------------|---------------|
| **DOS-01** | WebSocket Frame Bombs | `bridge/src/ws_server.rs:339-356` | 1MiB frame cap sufficient? Can `try_send` on full channel cause memory growth? |
| **DOS-02** | MCP Line Length Attack | `bridge/src/mcp_stdio.rs:33-86` | 1MiB line cap + drain logic — can partial reads accumulate? |
| **DOS-03** | Audit Log Growth | `bridge/src/policy.rs:510-564, 566-611` | No retention enforcement (`DataRetentionPolicy` not implemented). Can log fill disk? |

### Tier 7: Cryptographic & Randomness Hunters (2 agents)

| Agent ID | Mandate | Target Files | Key Questions |
|----------|---------|--------------|---------------|
| **CRY-01** | Auth Token Generation | `bridge/src/main.rs:369-399` | `Uuid::new_v4()` — is it CSPRNG? File permissions 0600 enforced on all platforms? |
| **CRY-02** | Action Hash Collision | `bridge/src/main.rs:128-129, 167-170` | SHA256 of serialized request — can attacker craft collision to overwrite audit entry? |

### Tier 8: Supply Chain & Dependency Hunters (2 agents)

| Agent ID | Mandate | Target Files | Key Questions |
|----------|---------|--------------|---------------|
| **SUP-01** | Cargo.lock / package.json Audit | `bridge/Cargo.toml`, `package.json` | Any vulnerable transitive deps? `rusqlite`, `axum`, `tokio`, `playwright` versions? |
| **SUP-02** | Build Pipeline Integrity | `vite.config.ts`, `bridge/Cargo.toml` | Any arbitrary code execution in build scripts? `build.rs` in bridge? |

### Tier 9: Architecture & Design Drift Hunters (2 agents)

| Agent ID | Mandate | Target Files | Key Questions |
|----------|---------|--------------|---------------|
| **ARC-01** | Trust Boundary Enforcement | All bridge + extension message passing | Does ANY extension action execute without bridge `PolicyCheck`? |
| **ARC-02** | Fail-Closed Default Verification | `policy.rs:65-87, 302-308` | Default config truly denies all? MCP mode `permitted_actions` empty = deny? |

---

## Execution Protocol

### Phase 1: Parallel Deployment (Current)
Deploy all 30+ sub-agents simultaneously. Each agent:
1. Reads assigned target files
2. Executes hunting methodology per its mandate
3. Reports findings in structured format:
   ```json
   {
     "agent_id": "SEC-01",
     "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
     "finding": "Concise description",
     "location": "file:line",
     "evidence": "Code snippet or logic trace",
     "impact": "What breaks if exploited",
     "poc": "Minimal reproduction steps or N/A",
     "recommendation": "One-line fix or mitigation"
   }
   ```

### Phase 2: Cross-Agent Correlation
Aggregator correlates findings across agents:
- Same root cause reported by multiple agents
- Chained vulnerabilities (e.g., INJ-04 + SEC-04 = RCE)
- Architectural patterns (e.g., missing validation in 5+ locations)

### Phase 3: Prioritized Remediation Plan
Output: Ranked fix list with:
- **P0 (Do Now)**: RCE, auth bypass, audit log forgery
- **P1 (This Sprint)**: DoS, logic bypass, token leak
- **P2 (Next Sprint)**: Hardening, edge cases, tech debt
- **P3 (Backlog)**: Observability, DX improvements

---

## Auto-Approval Confirmation

**MASTER PLAN APPROVED** — All 30+ sub-agents authorized for immediate deployment.

**Deployment Command**: Sub-agents execute now. No further confirmation needed.

**Reporting Deadline**: All agents report within single response cycle. Aggregation follows immediately.

---

## Hunter Instructions (Embedded for Each Agent)

> **You are a specialized security hunter. Your mandate is narrow and deep.**
> 
> 1. **Read your target files completely** — trace every code path in your domain
> 2. **Think like an attacker** — what assumptions does the code make? What if they're wrong?
> 3. **Follow the data** — where does untrusted input enter? Where does it exit?
> 4. **Check the boundaries** — trust boundaries, process boundaries, serialization boundaries
> 5. **Report only actionable findings** — no "code looks fine" reports. Silence = clean.
> 6. **One finding per report** — but include all variants of the same root cause
> 7. **Ponytail discipline** — shortest diff that fixes root cause. No over-engineering.

---

*End of Master Plan. Sub-agents: DEPLOY.*