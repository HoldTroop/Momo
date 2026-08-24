# ID Ledger — Single Source of Truth

**Tree state (HEAD)**: `60e179fae2f11dccb7658c084561d13b147272b8`
**Generated**: 2026-08-23 (read-only recon)
**Total items**: 54

> **Why this file exists**: the prior fix workflow silently dropped ~49 items because verification subagents returned mismatched `item_id`s. This ledger pins each item to an immutable `seq` + `item_id` + `claim_text` so no downstream agent can invent or mis-associate an ID. Downstream agents must address items by `seq`+`item_id` together, and must never synthesize an ID of their own.

> **Count reconciliation note**: this ledger enumerates **54** items. The prior round-1 audit (`docs/FIX_VERIFICATION_AUDIT.md`) reported "53 findings" / "40 not audited", but its own "Items Not Audited" list enumerates **41** entries, and 13 audited + 41 not-audited = 54. The prior tally had an off-by-one counting error (a symptom of the same coordination bug). This ledger is authoritative.

## Schema

| Column | Meaning |
|---|---|
| `seq` | Immutable sort key (`001…054`), assigned in source-document order |
| `item_id` | Canonical ID (legacy prefix preserved where unambiguous) |
| `priority` | CRITICAL / HIGH / MEDIUM / LOW |
| `classification` | Pre-assigned hint: `package` / `code` / `build` (refined by Phase 3 decision tree) |
| `claim` | One-line authoritative claim text |
| `files` | Hint: files to inspect (not exhaustive) |
| `last_status` | Carried forward from round-1/round-2 reports |

## Ledger

| seq | item_id | priority | classification | claim | files | last_status |
|---|---|---|---|---|---|---|
| 001 | disc-1 | HIGH | code | README/FAQ document flat `token_budget_per_task` but policy.rs uses nested `token_budget.max_tokens` | README.md, docs/FAQ.md, bridge/src/policy.rs | fixed |
| 002 | disc-2 | MEDIUM | code | ADR-0001 lists `deduct_tokens` as step 6 (separate) but implementation merges it into step 4 `check_token_budget` | docs/adr/0001-policy-gate.md, bridge/src/policy.rs | not-audited |
| 003 | disc-3 | HIGH | code | `token_budget.warning_threshold` persisted but never consulted (no warning on threshold cross) | bridge/src/policy.rs | fixed |
| 004 | disc-4 | MEDIUM | code | `risk_thresholds` (6 numeric) persisted but never enforced; `classify_risk()` is keyword-only | bridge/src/policy.rs | not-fixed |
| 005 | disc-5 | HIGH | code | README shows `Low`/`Moderate` as confirmation_policy values; enum is Always/Sensitive/Never only | README.md, bridge/src/policy.rs | fixed |
| 006 | disc-6 | MEDIUM | code | `data_retention` (Session/Persistent) defined+persisted but never enforced | bridge/src/policy.rs | not-fixed |
| 007 | llm-1 | MEDIUM | code | No retry logic / exponential backoff for transient LLM failures | bridge/src/llm.rs (deleted), bridge/src/ | n/a |
| 008 | llm-2 | MEDIUM | code | No rate-limit detection or request queuing | bridge/src/llm.rs (deleted) | not-audited |
| 009 | llm-3 | MEDIUM | code | No provider abstraction (monolithic LlmGateway) | bridge/src/llm.rs (deleted) | n/a |
| 010 | llm-4 | MEDIUM | code | Model list hardcoded, not dynamic discovery | bridge/src/llm.rs (deleted) | n/a |
| 011 | llm-5 | MEDIUM | code | No per-provider timeout configuration | bridge/src/llm.rs (deleted) | not-audited |
| 012 | llm-6 | MEDIUM | code | No provider health metrics / observability | bridge/src/llm.rs (deleted) | not-audited |
| 013 | llm-7 | MEDIUM | code | System prompt hardcoded, not configurable | bridge/src/llm.rs (deleted) | not-audited |
| 014 | mcp-1 | LOW | code | Two parallel ref schemes (`data-momo-ref` vs `data-momo-ref-id`) not unified | src/content/perception.ts | not-audited |
| 015 | mcp-2 | LOW | code | `execute_action` globally serialized, not per-session | src/sw/message-router.ts | not-audited |
| 016 | mcp-3 | LOW | code | `bridge_port` file race between Mode A and Mode B | bridge/src/main.rs, bridge/src/ws_server.rs | not-audited |
| 017 | mcp-4 | LOW | code | Command cancellation best-effort (does not abort in-flight CDP action) | bridge/src/ws_server.rs, bridge/src/mcp_stdio.rs | not-audited |
| 018 | mcp-5 | LOW | build | Unsigned darwin binaries trigger Gatekeeper prompts | bridge/src/, .github/ | not-audited |
| 019 | mcp-6 | LOW | code | No `capture_viewport` (screenshot+VLM) fifth tool for canvas/obfuscated pages | src/lib/tool-registry.ts, src/lib/tools/ | not-audited |
| 020 | mcp-7 | LOW | code | No MCP SDK reference-implementation tests | bridge/tests/, tests/ | not-audited |
| 021 | actions-1 | MEDIUM | code | No file upload tool (`input[type=file]`) | src/lib/tools/, src/lib/tool-registry.ts | not-audited |
| 022 | actions-2 | MEDIUM | code | No drag-and-drop simulation | src/lib/tools/ | not-audited |
| 023 | actions-3 | MEDIUM | code | No keyboard shortcuts (Ctrl+C/V, multi-key); only Enter via `pressEnter` | src/lib/tools/type.ts | not-audited |
| 024 | actions-4 | MEDIUM | code | No `switch_to_tab`/`activate_tab` tool (list_tabs only) | src/lib/tools/, src/sw/message-router.ts | not-audited |
| 025 | actions-5 | MEDIUM | code | No iframe targeting (`allFrames:false` everywhere) | src/lib/tools/ | not-audited |
| 026 | actions-6 | MEDIUM | code | No visual verification (screenshot comparison / OCR) | src/lib/tools/ | not-audited |
| 027 | actions-7 | MEDIUM | code | No network interception / request-response verification | src/lib/tools/ | not-audited |
| 028 | actions-8 | MEDIUM | code | No shadow-DOM penetration for element targeting | src/content/perception.ts | not-fixed |
| 029 | actions-9 | MEDIUM | code | No context-menu (right-click) simulation | src/lib/tools/ | not-audited |
| 030 | actions-10 | MEDIUM | code | No standalone hover tool (`mouseMoved` internal only) | src/lib/tools/ | not-audited |
| 031 | actions-11 | MEDIUM | code | No double-click / long-press gesture support | src/lib/tools/ | not-audited |
| 032 | security-1 | CRITICAL | package | vitest 1.6.1 RCE-class dev-server arbitrary file read/exec (GHSA) | package.json, package-lock.json | not-fixed |
| 033 | security-2 | HIGH | package | vite 5.4.21 path-traversal in `.map` handling | package.json, package-lock.json | not-fixed |
| 034 | security-3 | HIGH | build | No CI/CD on pull requests (tests/lint only run on v* tag releases) | .github/workflows/ | not-audited |
| 035 | quality-1 | LOW | code | Task queue underutilized (no active background scheduling) | src/lib/task-queue.ts, src/sw/orchestrator.ts | not-audited |
| 036 | quality-2 | MEDIUM | code | WAL replay not implemented (checkpoint restore only) | src/lib/task-queue.ts | not-audited |
| 037 | quality-3 | MEDIUM | code | No multi-frame coordination (iframe targeting / cross-frame actions) | src/lib/tools/, src/sw/orchestrator.ts | not-fixed |
| 038 | quality-4 | HIGH | code | `orchestrator.ts` ~1,312 lines with zero tests | src/sw/orchestrator.ts, tests/ | not-audited |
| 039 | quality-5 | MEDIUM | code | 8 silent `.catch(() => {})` blocks swallow errors | src/content/dom-observer.ts, src/sw/orchestrator.ts, src/sidepanel/index.tsx | fixed |
| 040 | quality-6 | MEDIUM | code | `tool-registry.ts` ~1,689-line god file | src/lib/tool-registry.ts | not-audited |
| 041 | quality-7 | MEDIUM | build | 77 `any` usages from disabled ESLint rules (no-explicit-any off) | eslint.config.*, .eslintrc*, src/ | not-audited |
| 042 | quality-8 | MEDIUM | build | No Rust CI (cargo test/clippy not in release workflow) | .github/workflows/ | not-audited |
| 043 | quality-9 | LOW | build | No Dependabot config (dependency drift produced CVE backlog) | .github/dependabot.yml | not-audited |
| 044 | quality-10 | LOW | build | No vitest.config.ts coverage thresholds (70% floor) | vitest.config.ts | fixed |
| 045 | quality-11 | LOW | build | Committed `.kilo/` worktree artifact directory (nested node_modules) | .kilo/ | not-audited |
| 046 | quality-12 | LOW | build | `.env*` not in `.gitignore` explicitly | .gitignore | not-audited |
| 047 | roadmap-1 | LOW | code | Expand action set: file ops, form handling, drag-drop | src/lib/tool-registry.ts, src/lib/tools/ | not-audited |
| 048 | roadmap-2 | LOW | code | Multi-tab coordination & window management | src/sw/message-router.ts, src/lib/tools/ | not-audited |
| 049 | roadmap-3 | LOW | code | Rich human-in-the-loop confirmation UX (visual preview) | src/sidepanel/index.tsx | not-fixed |
| 050 | roadmap-4 | LOW | code | OpenAI + Gemini provider support (Anthropic/Ollama only) | bridge/src/llm.rs (deleted), README.md | not-audited |
| 051 | roadmap-5 | LOW | code | Advanced error recovery with context preservation | src/sw/orchestrator.ts | not-audited |
| 052 | roadmap-6 | LOW | code | Enterprise compliance pack (SSO / RBAC / compliance reports) | bridge/src/policy.rs | not-audited |
| 053 | roadmap-7 | LOW | code | Token budget optimization + streaming support | bridge/src/policy.rs | not-audited |
| 054 | roadmap-8 | LOW | code | Benchmark against WebArena / Mind2Web / GAIA | tests/, README.md | not-audited |

## Reconciliation (Phase 1 gate)

- **Count**: 54 ledger rows, `seq` 001–054 contiguous, `item_id` unique (no duplicates).
- **Source**: every row traces to a discrete claim in `docs/SELF_ANALYSIS.md` (DISCREPANCY 1–5, LLM gaps, MCP gaps, extension gaps, security/quality findings) or `docs/COMPETITIVE_ANALYSIS_AND_ROADMAP.md` (recommendations 1–8).
- **Legacy alias map**: `disc-1…6` = DISCREPANCY 1…5 (DISCREPANCY 3 split into `disc-3` warning_threshold + `disc-4` risk_thresholds); `llm-1…7`, `mcp-1…7`, `actions-1…11`, `security-1…3`, `quality-1…12`, `roadmap-1…8` as labeled.
- **Anti-contamination rule**: downstream agents consume `item_id` + `seq` from THIS table; the orchestrator keys every result by the dispatched `seq`, never by an agent's self-reported ID.
