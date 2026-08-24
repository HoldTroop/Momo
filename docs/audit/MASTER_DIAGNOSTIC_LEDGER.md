# Master Diagnostic Ledger

**Tree state (HEAD)**: `60e179fae2f11dccb7658c084561d13b147272b8`
**Generated**: 2026-08-23 (read-only recon — no files mutated)
**Total items**: 54 — **OPEN 32 · RESOLVED 15 · N/A 7**

**Method**: 54 independent read-only verifiers (one per ID-ledger row) located each issue to exact `file:line`; every result keyed by the immutable `seq` from `docs/audit/ID_LEDGER.md`, so no `item_id` can be mismatched. Critical/security items were additionally confirmed against `package.json`, `package-lock.json`, and `.github/workflows/` by direct inspection.

---

## ⚠️ Correction to prior reports

The round-1 audit (`docs/FIX_VERIFICATION_AUDIT.md`) and round-2 report (`docs/FIX_ROUND_2_REPORT.md`) both describe **`security-1` (vitest RCE) and `security-2` (vite path-traversal) as still open**. That is **incorrect**. Both were patched in commit `773d3ce` (`chore(security): remove .kilo artifact and patch critical vitest/vite CVEs`) **before** either audit ran:

- `vitest` is now `^4.1.11` (lockfile-resolved **4.1.11**), not `1.6.1`.
- `vite` is now `^8.2.2` (lockfile-resolved **8.2.2**), not `5.4.21`.

The `FIX_ROUND_2_REPORT.md` "Coverage Gaps" section is therefore factually wrong on these two items. This ledger is authoritative.

---

## 1 · Package-Related

| Item_ID | Classification | Status | Directory/File:Line | Issue Summary |
|---|---|---|---|---|
| security-1 | package | ✅ RESOLVED | package.json:37 | vitest RCE-class dev-server file read/exec — **fixed**: `vitest ^4.1.11` (lockfile 4.1.11), bumped in commit `773d3ce`. |
| security-2 | package | ✅ RESOLVED | package.json:36 | vite `.map` path-traversal — **fixed**: `vite ^8.2.2` (lockfile 8.2.2), bumped in commit `773d3ce`. |

## 2 · Build-Related

| Item_ID | Classification | Status | Directory/File:Line | Issue Summary |
|---|---|---|---|---|
| mcp-5 | build | 🔴 OPEN | .github/workflows/release.yml:89-93 | Unsigned darwin binaries (ad-hoc `codesign --sign -` only) — still triggers Gatekeeper; no notarization. |
| security-3 | build | ✅ RESOLVED | .github/workflows/ci.yml:12, pr.yml:4 | No PR CI — **fixed**: `ci.yml` (push+PR→main) and `pr.yml` (PR→main) run lint/typecheck/test + cargo check/test/clippy. |
| quality-7 | build | 🔴 OPEN | eslint.config.mjs:23 | 77→88 `any` usages; `no-explicit-any` was flipped `off`→`warn` (rule re-enabled) but the `any` debt remains across 13 files. |
| quality-8 | build | ✅ RESOLVED | .github/workflows/pr.yml | No Rust CI — **fixed**: `pr.yml` runs `cargo check` + `cargo test` + `cargo clippy -- -D warnings`; `ci.yml` runs `cargo check` + `cargo test --all-features`. |
| quality-9 | build | ✅ RESOLVED | .github/dependabot.yml | No Dependabot — **fixed**: config present, covers npm + cargo with weekly grouped PRs. |
| quality-10 | build | ✅ RESOLVED | vitest.config.ts:15-26 | No coverage thresholds — **fixed**: 70% floor on lines/functions/branches/statements for `src/lib/**` + `src/sw/**`. |
| quality-11 | build | ✅ RESOLVED | \<none\> | Committed `.kilo/` artifact — **fixed**: directory removed (commit `773d3ce`) and `.gitignore`d. |
| quality-12 | build | ✅ RESOLVED | .gitignore:8-11 | `.env*` not ignored — **fixed**: `.env`, `.env.*`, `.env.local`, `.env.*.local` all ignored. |

## 3 · Code-Related

| Item_ID | Classification | Status | Directory/File:Line | Issue Summary |
|---|---|---|---|---|
| disc-1 | code | ✅ RESOLVED | \<none\> | `token_budget_per_task` flat field — **fixed**: README/FAQ now use nested `token_budget.max_tokens` (commit `9880de1`). |
| disc-2 | code | ✅ RESOLVED | \<none\> | ADR-0001 step-6 `deduct_tokens` — **fixed**: ADR now documents atomic deduction inside step 4 (docs/adr/0001-policy-gate.md:44-46). |
| disc-3 | code | ✅ RESOLVED | \<none\> | `warning_threshold` never consulted — **fixed**: `tracing::warn!` emitted at bridge/src/policy.rs:394-403. |
| disc-4 | code | 🔴 OPEN | bridge/src/policy.rs:50-63, 434-458 | `risk_thresholds` (6 numeric) persisted (load:222, save:240) but never enforced; `classify_risk()` is keyword-only. |
| disc-5 | code | ✅ RESOLVED | \<none\> | `Low`/`Moderate` confirmation_policy — **fixed**: README:301,680 document `always`/`sensitive`/`never`. |
| disc-6 | code | 🔴 OPEN | bridge/src/policy.rs:32-41 | `data_retention` (Session/Persistent) defined+persisted (19,71,220,238) but never enforced; TODO(v2) at 32-34. |
| llm-1 … llm-7 | code | ⚪ N/A | \<none\> | Retry/backoff, rate-limit, provider abstraction, hardcoded models, per-provider timeout, metrics, hardcoded prompt — **component deleted**: `bridge/src/llm.rs` removed (commit `22ec205`); bridge is now MCP-only with no internal LLM client. |
| mcp-1 | code | 🔴 OPEN | src/content/perception.ts:51-52, 232-235 | Two parallel ref schemes (`momo-N` vs `el_N`) still coexist, not unified. |
| mcp-2 | code | 🔴 OPEN | src/sw/message-router.ts:187-196 | `execute_action` still globally serialized (single active session), not per-session. |
| mcp-3 | code | 🔴 OPEN | bridge/src/main.rs:544-562 | `bridge_port` file race (Mode A vs Mode B) via `try_lock_exclusive`, no distinct MCP port. |
| mcp-4 | code | 🔴 OPEN | bridge/src/mcp_stdio.rs:170-176 | `notifications/cancelled` removes pending request but does not abort in-flight CDP action. |
| mcp-6 | code | 🔴 OPEN | \<none\> | `capture_viewport` (screenshot+VLM) fifth tool absent — only 10 tools registered in src/lib/tool-registry.ts. |
| mcp-7 | code | 🔴 OPEN | \<none\> | No MCP SDK reference-implementation tests; `@modelcontextprotocol/sdk` not a dependency. |
| actions-1 | code | 🔴 OPEN | \<none\> | No file-upload tool (`input[type=file]`). |
| actions-2 | code | 🔴 OPEN | \<none\> | No drag-and-drop; CDP adapter exposes only mouse events, no `dispatchDragEvent`. |
| actions-3 | code | 🔴 OPEN | src/lib/tools/type.ts | No keyboard shortcuts (Ctrl+C/V, chords); only Enter via `pressEnter`. |
| actions-4 | code | 🔴 OPEN | \<none\> | No `switch_to_tab`/`activate_tab`; only `list_tabs` (message-router.ts + mcp_tools.rs). |
| actions-5 | code | 🔴 OPEN | src/lib/tools/click.ts:97 (+13 files) | No iframe targeting — `allFrames:false` hardcoded across 14 sites. |
| actions-6 | code | 🔴 OPEN | \<none\> | No visual verification (screenshot comparison / OCR). |
| actions-7 | code | 🔴 OPEN | \<none\> | No network interception / request-response verification. |
| actions-8 | code | 🔴 OPEN | src/content/perception.ts:43-46 | No shadow-DOM penetration — `createTreeWalker(document.body)` + `querySelector` skip shadow roots. |
| actions-9 | code | 🔴 OPEN | \<none\> | No context-menu (right-click); mouse dispatch hardcodes left button. |
| actions-10 | code | 🔴 OPEN | \<none\> | No standalone hover tool; `mouseMoved` internal-only. |
| actions-11 | code | 🔴 OPEN | \<none\> | No double-click / long-press gesture support. |
| quality-1 | code | 🔴 OPEN | src/lib/task-queue.ts:15-27 | Task queue underutilized — `startProcessing` invoked only for periodic/sync/cleanup, no active background scheduling. |
| quality-2 | code | 🔴 OPEN | src/lib/persistence.ts:203-226 | WAL replay not implemented — `getWalEntries`/`appendWal` exist but no full replay (checkpoint restore only). |
| quality-3 | code | 🔴 OPEN | src/sw/orchestrator.ts:551, 851 | No multi-frame coordination — single `frameId:0`, `allFrames:false` everywhere. |
| quality-4 | code | ✅ RESOLVED | src/sw/orchestrator.test.ts | orchestrator 0 tests — **fixed**: dedicated 588-line suite exists (orchestrator.ts now 1,112 lines). |
| quality-5 | code | ✅ RESOLVED | \<none\> | 8 silent `.catch(() => {})` — **fixed**: commit `a6adcc1`; 0 remaining. |
| quality-6 | code | ✅ RESOLVED | src/lib/tool-registry.ts | 1,689-line god file — **fixed**: commit `12e9b27` split it to 115-line registry + `src/lib/tools/*`. |
| roadmap-1 | code | 🔴 OPEN | \<none\> | Expand action set (file ops, form handling, drag-drop) — unimplemented. |
| roadmap-2 | code | 🔴 OPEN | \<none\> | Multi-tab coordination/window management — no `chrome.windows.*`; single `context.tabId`. |
| roadmap-3 | code | 🔴 OPEN | src/sidepanel/index.tsx | Rich HITL confirmation UX — modal is text-only (action/target/origin/risk/reversibility), no preview/highlight. |
| roadmap-4 | code | 🔴 OPEN | \<none\> | OpenAI/Gemini providers — provider layer deleted (22ec205); Anthropic/Ollama only in docs. |
| roadmap-5 | code | 🔴 OPEN | src/sw/orchestrator.ts:644-654 | Advanced error recovery — bounded retry exists but no perception-refresh context preservation. |
| roadmap-6 | code | 🔴 OPEN | \<none\> | Enterprise compliance pack (SSO/RBAC/reports) — not implemented. |
| roadmap-7 | code | 🔴 OPEN | bridge/src/policy.rs:44-48 | Token budget optimization/streaming — fixed budget, no streaming support. |
| roadmap-8 | code | 🔴 OPEN | \<none\> | WebArena/Mind2Web/GAIA benchmarks — no harness or eval code. |

---

## 4 · Gap Report (items with no resolvable concrete location)

These are **absence-shaped** issues: the gap is that a feature/file does **not** exist. Their `Directory/File:Line` is `<none>` by definition; the anchor file (where the missing thing *would* live) is listed.

- **Package/build gaps — already closed** (no longer gaps): security-1, security-2, security-3, quality-8, quality-9, quality-10, quality-11, quality-12.
- **Still-open absence gaps** (feature/file truly missing): llm-1…7 (component deleted → N/A, not a gap), mcp-6, mcp-7, actions-1, actions-2, actions-4, actions-6, actions-7, actions-9, actions-10, actions-11, roadmap-1, roadmap-2, roadmap-4, roadmap-6, roadmap-8.

## 5 · Reconciliation assertions

- 54 ledger rows → 54 verified results, **0 missing** (`seq` 001–054 contiguous, no duplicates, no orphans).
- Every row appears in exactly one classification section.
- `found:false` rows carry `Directory/File:Line = <none>` (or the fixed/correct location where the resolution is observable) with an evidence line — never a guessed path.
- Direct ground-truth spot-checks confirmed the agent results for the security/CI/god-file/coverage items (package.json, package-lock.json, `.github/workflows/*`, `wc -l`, `.gitignore`).

## 6 · Definition of done

- One immutable `docs/audit/ID_LEDGER.md` + one `docs/audit/MASTER_DIAGNOSTIC_LEDGER.md` (this file).
- 100% of Phase-1 items classified (package/code/build) and status-tagged (OPEN/RESOLVED/N/A).
- `git status` is clean except the two audit files under `docs/audit/`.
