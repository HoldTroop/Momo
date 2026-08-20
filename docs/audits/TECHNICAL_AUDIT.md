# Technical Audit Report — Momo

**Date:** 2026-08-20
**Auditor:** Senior Staff Engineer (automated evidence-based review)
**Scope:** Full repository — TypeScript extension + Rust bridge
**Commit:** `d2b7bc7`

---

## 1. Executive Summary

Momo is a **Chrome Manifest V3 extension (TypeScript) paired with a Rust backend bridge**, totaling ~11,800 lines across 42 source files. The architecture is clean and layer-based with strong separation between the service worker, content scripts, React side panel, shared libraries, and the Rust policy/LLM bridge. The security posture is genuinely strong — fail-closed policy engine, redaction at source, and an authenticated WebSocket channel are real, not aspirational.

The two most urgent issues are **(1) a Critical-severity `vitest` dev-server vulnerability and a High-severity `vite` vulnerability** in the build toolchain, and **(2) the absence of any CI that runs tests/lint on pull requests** — the only workflow is tag-triggered release packaging, so broken code can reach `main` silently. Secondary concerns are two god-files (`tool-registry.ts` at 1,689 lines, `orchestrator.ts` at 1,312 lines) that concentrate most of the risk, and a suite of disabled ESLint rules that let `any`-typed code and silent `.catch(() => {})` blocks accumulate unchecked.

The project is well-documented, the test suite is meaningful where it exists (redaction and security-critical paths are covered), and the runtime versions (Node 22, Rust 1.97) are current. Overall health is **above average for a solo-maintained project of this complexity** — the fixes are targeted and low-effort relative to their impact.

---

## 2. Findings Table

| Area | Finding | Severity | Recommended Fix |
|------|---------|----------|-----------------|
| Dependencies | `vitest` 1.6.1 has a Critical vuln (UI server arbitrary file read/exec) — GHSA in dev toolchain | **Critical** | Upgrade to vitest 4.x (or at minimum 2.x) |
| Dependencies | `vite` 5.4.21 has a High path-traversal vuln in `.map` handling | **High** | Upgrade to vite 6.x+ (audit suggests 8.2.2) |
| Dependencies | `@mozilla/readability` 0.4.4 has a DoS-via-Regex CVE (CWE-1333) | Medium | Upgrade to 0.6.0 (semver-major but drop-in API) |
| CI/CD | No CI on pull requests or pushes to `main` — tests/lint only run on `v*` tags | **High** | Add a `ci.yml` workflow: lint + typecheck + test on PRs |
| CI/CD | No Dependabot/Renovate — dependencies drift silently | Medium | Enable Dependabot (GitHub-native, zero-config) |
| Code Quality | `tool-registry.ts` is 1,689 lines / 73KB — god file | Medium | Split executors into per-tool modules |
| Code Quality | `orchestrator.ts` is 1,312 lines / 45KB — god file | Medium | Extract confirmation-flow and CDP-lifecycle into modules |
| Code Quality | ESLint disables `no-explicit-any`, `no-unused-vars`, `ban-ts-comment`, `no-non-null-assertion` | Medium | Re-enable; `any` appears 77×, suppressions 10× |
| Code Quality | 8 silent `.catch(() => {})` blocks swallow errors with no logging | Low | Log the error at minimum; escalate where it's a real failure |
| Code Quality | 80 `console.*` / `debugger` statements in production source | Low | Gate behind a build-time flag or strip in production build |
| Testing | No tests for `orchestrator.ts` (core state machine, 1,312 lines) | **High** | Add unit tests for the run loop, confirmation, and retry logic |
| Testing | No vitest config file — relies on defaults, no coverage reporting | Low | Add `vitest.config.ts` with `coverage` enabled |
| Tooling | `cargo outdated` not available — Rust dependency freshness unverified | Low | Install `cargo-outdated`; run against `Cargo.lock` |
| Structure | `.kilo/` directory committed with a nested `node_modules` + worktree | Medium | Remove from repo; add to `.gitignore` |
| Documentation | `README.md` states "MIT License" in some references but LICENSE is PolyForm Noncommercial | Medium | Reconcile (README badge is correct; older text says MIT) |

---

## 3. Tech Stack Update Plan

Ordered by priority (risk-adjusted):

| # | Dependency | Current | Target | Benefit | Risk | Order |
|---|-----------|---------|--------|---------|------|-------|
| 1 | vitest | 1.6.1 | 4.1.11 | Removes Critical dev-server RCE-class vuln | LOW — test-only, minor config changes | Do first |
| 2 | vite | 5.4.21 | 6.x → 8.x | Removes High path-traversal + esbuild CVE (transitive) | MEDIUM — build pipeline, plugin compat | Second |
| 3 | @mozilla/readability | 0.4.4 | 0.6.0 | Removes DoS-regex CVE (CWE-1333) | LOW — API stable for `parse()` | Third |
| 4 | @types/chrome | 0.0.268 | 0.2.6 | Accurate MV3 typings | LOW | Any time |
| 5 | react / react-dom | 18.3.1 | 19.2.8 | React 19 perf + concurrent features | MEDIUM — breaking API changes | Defer (needs migration) |
| 6 | typescript | 5.9.3 | 7.0.2 | Native type improvements | MEDIUM — may surface new errors | Defer (bundle with React 19) |
| 7 | @vitejs/plugin-react | 4.7.0 | 6.1.0 | Required for React 19 + vite 8 | MEDIUM | Bundle with React 19 |

**Migration notes:**
- **vite/vitest** can be bumped together (`npm i -D vite@6 vitest@2`) since vitest is built on vite. Verify `vite.config.ts` custom `contentScriptBuilds()` plugin still works — it uses `viteBuild()` recursively, which is stable across these versions.
- **readability 0.6.0** changed only internals; the `Readability` constructor + `parse()` surface is unchanged. Update `src/content/perception.ts` import path if it imports from a deep path.
- **React 19** removes `ReactDOM.render` (already using `createRoot` presumably) and changes ref/context types. Do this as a separate, tested PR — do not bundle with the security patches.

---

## 4. Quick Wins (low-effort, high-impact)

1. **Add `.github/workflows/ci.yml`** — run `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` on every PR to `main`. This is the single highest-value change: it stops silent regressions. (~15 min)
2. **Enable Dependabot** — `.github/dependabot.yml` for `npm` and `cargo` ecosystems. Zero ongoing maintenance, stops the drift that produced the current CVE backlog.
3. **Upgrade vitest + vite + readability** — one PR, three `npm i -D` commands, removes the Critical and High findings.
4. **Re-enable `no-explicit-any` in ESLint** (change `'off'` → `'warn'`). Don't fail the build yet, but surface the 77 `any` usages so they're visible.
5. **Remove `.kilo/` from the repo** — `git rm -r .kilo && echo ".kilo/" >> .gitignore`. It's a local worktree artifact with a nested `node_modules`, bloating the repo.
6. **Fix silent catches** — change the 8 `.catch(() => {})` blocks to `.catch((e) => console.warn('...', e))` so failures are at least observable.

---

## 5. Longer-Term Improvements

1. **Split `tool-registry.ts` (1,689 lines).** Each tool executor (`navigate`, `click`, `type`, `scroll`, `observe`, `extract`) is self-contained — extract them into `src/lib/tools/*.ts` with a shared `ToolPolicy`/`ToolContext` module. Reduces the file's blast radius and makes tool-specific tests co-locatable.
2. **Extract `orchestrator.ts` sub-concerns.** The confirmation/timeout flow, CDP session lifecycle, and checkpoint/persistence logic are distinct enough to live in `confirmation.ts`, `cdp-lifecycle.ts`, and `checkpoint.ts`. This also unlocks unit-testing the state machine that is currently untested.
3. **Add coverage reporting** (`vitest.config.ts` with `coverage: ['v8']`) and set a floor (e.g. 70% on `src/lib` and `src/sw`) so regressions are visible.
4. **Add Rust CI** — currently the release workflow builds the extension but does **not** run `cargo test` for the bridge. Add `cargo test` and `cargo clippy -- -D warnings` to CI.
5. **Adopt a lint-driven type boundary** — replace the 10 `@ts-ignore`/`@ts-expect-error` suppressions with narrow, typed shims for the `window.__perception*` globals so the compiler can actually check them.
6. **Consider a monorepo tool** (npm workspaces or Turborepo) if the bridge and extension grow further; today's two-package layout is fine but the `.kilo/` stray directory suggests local-tooling drift that a workspace definition would prevent.

---

## 6. What's Already Done Well

- **Security model is real and layered.** The fail-closed policy engine (`PolicyEngine::evaluate` in `bridge/src/policy.rs`) with origin allowlist → permitted-action → token-budget → risk-classification is correctly ordered, and the extension re-verifies rather than self-authorizing. This is a genuinely strong design for an autonomous browser agent.
- **Redaction at the source.** `src/lib/redaction.ts` strips secrets/PII/credit-cards before data reaches DOM snapshots, persistence, or the LLM — and it has **21 dedicated tests**, the most-tested module in the codebase. The right code is being tested hardest.
- **Consistent module structure.** Clean layer separation (`sw/`, `content/`, `sidepanel/`, `lib/`, `bridge/`) with zero default exports — named exports throughout make refactoring and grep-based analysis tractable.
- **TypeScript strictness where it counts.** `strict: true` and `noUncheckedIndexedAccess: true` are enabled, which catches a class of bugs most TS projects silently accept.
- **Documentation is thorough and current.** README, CONTRIBUTING, CHANGELOG, SECURITY, an ADR (`docs/adr/0001-policy-gate.md`), and detailed phase plans all exist and describe the actual code, not an idealized version.
- **Security-critical test coverage.** The `tool-registry-security.test.ts` and `tool-registry-shadowing.test.ts` files specifically target the field-shadowing bug and policy-bypass paths — regression tests for real, previously-shipped vulnerabilities.
- **Secure secret handling.** API keys are loaded via `std::env::var("ANTHROPIC_API_KEY")` at runtime, never hardcoded, and `.mcp.json` (which may contain tokens) is correctly gitignored. A prior audit confirmed zero credential leaks across the full git history.
- **Runtime currency.** Node 22 (LTS) and Rust 1.97 (current) — the project is not on end-of-life runtimes.

---

## Appendix — Evidence Trail

- **Line counts:** `tool-registry.ts` 1,689 · `orchestrator.ts` 1,312 · total TS+Rust ~11,825
- **Dependency scan:** `npm outdated` shows 10 outdated packages (2 PATCH/MINOR, 8 MAJOR)
- **Vuln scan:** `npm audit` → 5 findings (1 critical, 1 high, 2 moderate, 1 low)
- **`any` usage:** 77 occurrences · **@ts-ignore suppressions:** 10 · **silent catches:** 8 · **debug statements:** 80
- **Tests:** 32 vitest (5 files) + 27 cargo tests · **no tests** for `orchestrator.ts`
- **CI:** `release.yml` only (tag-triggered) · **no** PR/commit CI · **no** Dependabot
- **ESLint disabled rules:** `no-explicit-any`, `no-unused-vars`, `ban-ts-comment`, `no-non-null-assertion`, `no-var-requires`
