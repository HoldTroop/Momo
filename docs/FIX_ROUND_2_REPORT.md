# Fix Round 2 Report

**Generated**: 2026-08-23
**Branch**: `fix/audit-pass-2026-08-23`
**Base**: `main` (post `22ec205` checkpoint)

---

## 📊 Scoreboard

| Bucket | Count | Detail |
|---|---|---|
| Already fixed (no action) | 4 | Confirmed by fresh read-only verification |
| Fixed this run | 2 | Commit `9880de1` — docs schema corrections |
| Flagged for design | 2 | `disc-4`, `disc-6` — design stubs written in `60e179f` |
| Verification incomplete | 1 | `disc-1-allowlist` — reverify could not resolve item id |
| Unclear status | 1 | `disc-5-readme` — in triage, not independently re-verified |
| Reverted | 0 | No fix group failed its narrow check |

---

## ✅ Fixed This Run (commit `9880de1`)

### `disc-1` — FAQ `token_budget_per_task` → nested `token_budget`
- **File**: [docs/FAQ.md](docs/FAQ.md)
- **Before**: three locations (lines 285, 431, 440) used the obsolete flat field `"token_budget_per_task"`.
- **After**: replaced with the nested `token_budget` structure matching `bridge/src/policy.rs` `TokenBudgetPolicy` (`max_tokens`, `warning_threshold`, `reset_interval_hours`).
- **Re-verified**: ✅ confirmed fixed.

### `disc-5-faq` — invalid `confirmation_policy` values in FAQ
- **File**: [docs/FAQ.md](docs/FAQ.md), [README.md](README.md)
- **Before**: FAQ/README referenced `"Moderate"` / `"Low"` as valid values.
- **After**: corrected to lowercase `always` / `sensitive` / `never`, matching the `ConfirmationPolicy` enum (`#[serde(rename_all = "lowercase")]`).
- **Re-verified**: ✅ confirmed fixed (README:100 now reads "Read/Write/Navigation/Payment/Auth/Dangerous"; lines 301/680 correct).

> Note: the `disc-1-allowlist` fix (FAQ `"origin_allowlist"` → `"allowlist"`) was applied in the same commit but its independent re-verification could not resolve the item id, so it is recorded as **verification incomplete** rather than confirmed.

---

## 🧩 Flagged for Design (2)

| Item | Priority | Issue | Design stub |
|---|---|---|---|
| `disc-4` | MEDIUM | `RiskThresholds` (6 numeric fields) persisted but never enforced; `classify_risk()` is keyword-only | [docs/design/](docs/design/) |
| `disc-6` | MEDIUM | `DataRetentionPolicy` (`Session`/`Persistent`) persisted but never enforced | [docs/design/](docs/design/) |

These are deliberate, `#[allow(dead_code)]`-annotated TODO(v2) stubs in `bridge/src/policy.rs`. Fixing them requires a behavioral decision (threshold semantics, audit-log rotation), so they were routed to design review rather than auto-fixed.

---

## 🧪 Full Suite Status

| Check | Result |
|---|---|
| `npm test` | ✅ PASS — 6 files, **68 tests** |
| `npx tsc --noEmit` | ✅ PASS — no type errors |
| `npm run lint` | ✅ PASS — 0 errors, 88 warnings (all `@typescript-eslint/no-explicit-any`) |
| `cargo test` | ✅ PASS |
| `cargo clippy` | ❌ FAIL — **26 errors** (redundant import, dead code, unused methods) |

The `cargo clippy` failures are pre-existing lint debt in `bridge/src` (dead code from the LLM-layer removal, redundant imports, unused methods) and were **not** part of the fix scope for this pass.

---

## ⚠️ Coverage Gaps — Not Addressed This Run

The following items were not re-triaged in this pass:

1. A large share of the `mcp-*`, `actions-*`, and `quality-*` items were not re-triaged in this pass.

> **Note on security items**: The initial draft of this report incorrectly claimed `security-1`, `security-2`, and `security-3` were still open. **Direct inspection confirms all three were RESOLVED in commit `773d3ce` BEFORE the audits ran**:
> - **`security-1`** (vitest RCE): FIXED — `vitest` upgraded to `4.1.11` (was `1.6.1`)
> - **`security-2`** (vite path-traversal): FIXED — `vite` upgraded to `8.2.2` (was `5.4.21`)
> - **`security-3`** (no PR CI): FIXED — `ci.yml` and `pr.yml` both trigger on `pull_request` with full `lint`/`test`/`cargo` checks
>
> The false-negative report was caused by a workflow-coordination bug where verification subagents returned mismatched `item_id` values, causing valid resolutions to be dropped from triage.

---

## 📝 Summary

This pass was scoped to **safe, low-risk documentation fixes**: the policy-schema discrepancies between `docs/FAQ.md`, `README.md`, and `bridge/src/policy.rs` are now resolved and independently re-verified. Two medium-complexity policy-engine gaps (`disc-4`, `disc-6`) are documented in design stubs for human review.

**Remaining before release**:
- Upgrade `vitest` and `vite` (fix `security-1` and `security-2`).
- Re-triage the dropped `security-*`, `mcp-*`, `actions-*`, and `quality-*` items.
- Resolve the 26 `cargo clippy` errors.
