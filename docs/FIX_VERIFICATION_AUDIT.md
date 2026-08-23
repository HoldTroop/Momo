# Fix Verification Audit Report

**Generated**: 2026-08-23T04:20:22.997Z  
**Source Documents**: docs/SELF_ANALYSIS.md, docs/COMPETITIVE_ANALYSIS_AND_ROADMAP.md  
**Items Audited**: 13 of 53 findings verified (40 not checked)

---

## 📊 Scoreboard

**Overall Status**: 3 fixed · 1 partially fixed · 5 not fixed · 3 no longer applicable · 1 cannot verify

**By Priority Tier**:
- **CRITICAL** (0 audited): 0 fixed, 0 not fixed
- **HIGH** (5 audited): 2 fixed/partial, 3 other (N/A or cannot verify)
- **MEDIUM** (7 audited): 1 fixed, 4 not fixed, 2 other
- **LOW** (1 audited): 1 fixed, 0 not fixed
- **Feature/Roadmap** (1 audited): 0 fixed, 1 not fixed

**Items Not Audited** (40): disc-2, llm-2, llm-5, llm-6, llm-7, all mcp-*, most actions-*, security-*, quality-1,2,4,6-9,11-12, roadmap-1,2,4-8

---

## ✅ Confirmed Fixed (3)

### HIGH Priority

**disc-3**: token_budget.warning_threshold now actively consulted in policy evaluation → [`bridge/src/policy.rs:394-403`](bridge/src/policy.rs#L394) - Lines 394-403 check `if usage_ratio > config.token_budget.warning_threshold` and emit tracing::warn! with token usage metrics. Field is loaded (L221), saved (L239), and used at runtime.

### MEDIUM Priority

**quality-5**: Silent .catch(() => {}) blocks now log errors → [`src/content/dom-observer.ts:130`](src/content/dom-observer.ts#L130) - Commit a6adcc1 (Aug 20, 2026) replaced 8 empty catch blocks with `.catch((err) => console.warn('[Momo] Handled error:', err))` across dom-observer.ts (2), index.tsx (3), message-router.ts (1), orchestrator.ts (5), ws-client.ts (1).

### LOW Priority

**quality-10**: vitest.config.ts now exists with coverage thresholds → [`vitest.config.ts:15-28`](vitest.config.ts#L15) - Config file created with v8 provider, text/html reporters, and enforced 70% thresholds (lines/functions/branches/statements) for src/lib/** and src/sw/**.

---

## 🟡 Partially Fixed (1)

### HIGH Priority

**disc-1**: token_budget field structure mismatch between docs and code
- ✅ **Fixed in README.md**: [`README.md:268-272`](README.md#L268) - Now correctly documents nested structure: `"token_budget": { "max_tokens": 100000, "warning_threshold": 0.8, "reset_interval_hours": 24 }` matching policy.rs TokenBudgetPolicy struct (lines 44-48, 72-76). Fixed in commit 6999a33.
- ⏳ **Still broken in FAQ.md**: [`docs/FAQ.md:285,431,440`](docs/FAQ.md#L285) - FAQ still contains obsolete flat field name "token_budget_per_task" at three locations.

---

## ❌ Still Not Fixed (5)

### MEDIUM Priority

**disc-4**: risk_thresholds struct with 6 numeric values persisted but never used → [`bridge/src/policy.rs:50-63`](bridge/src/policy.rs#L50) - RiskThresholds struct defined with #[allow(dead_code)] at L54. TODO comment (L50-53) explicitly states "RiskThresholds are persisted to the database but not yet enforced by the policy engine. Risk classification is currently keyword-based". classify_risk() method (L434-458) uses only keyword matching (`'navigate'→Navigation`, `'pay|purchase'→Payment`, etc.), never consults numeric thresholds. Fields loaded (L222) and saved (L240) but have zero behavioral impact.

**disc-6**: data_retention field defined and persisted but never enforced → [`bridge/src/policy.rs:32-41`](bridge/src/policy.rs#L32) - TODO comment (L32-34) explicitly confirms "DataRetentionPolicy is persisted to the database but not yet enforced by the policy engine. Session/persistent distinction is planned for Phase 10 (audit log rotation and retention)." Field marked #[allow(dead_code)] at L35. DataRetentionPolicy enum (Session|Persistent) defined at L38-41, included in PolicyConfig at L19, has default value at L71, loaded at L220, saved at L238. Grep confirms ZERO usage beyond definition/persistence - no audit log cleanup, rotation, or session-based retention logic exists.

**actions-8**: Shadow DOM - no penetration into shadow roots for element targeting → [`src/content/perception.ts:43-46`](src/content/perception.ts#L43) - Element targeting uses `document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)` which does not traverse shadow DOM boundaries. TreeWalker used at perception.ts:43,227 and ax-extractor.ts:178. Element resolution uses `document.querySelector()` at perception.ts:108,117,268 which does not pierce shadow boundaries. No `.shadowRoot` access exists anywhere in codebase (grep confirmed). This is a documented known limitation.

**quality-3**: Multi-frame coordination - no mechanism to target specific iframes or coordinate actions across frames → [`src/lib/tools/click.ts:97`](src/lib/tools/click.ts#L97) - All tool execution uses `target: { tabId: context.tabId, allFrames: false }`, restricting actions to main frame only. Found in: click.ts:97, execute-action.ts:110, extract.ts:40,64, human-click.ts:37, human-type.ts:38,69, observe.ts:30, scroll.ts:33, shared.ts:107,155, type.ts:99,167, wait.ts:37. Perception layer (perception.ts) operates only on document.body with no frame context. Single frameId:0 reference in orchestrator.ts:851 explicitly targets main frame. No code exists for iframe enumeration, frame-specific targeting, or cross-frame coordination.

### Feature/Roadmap

**roadmap-3**: Rich human-in-the-loop confirmation UX - policy denials are opaque, need visual preview → [`src/sidepanel/index.tsx:391-405`](src/sidepanel/index.tsx#L391) - Confirmation UI displays only text metadata: action name, target selector, origin URL, risk class, and reversibility flag. No screenshot capture, no visual element highlighting, no DOM preview functionality exists in codebase. Searched entire src/ for screenshot/captureVisibleTab/highlight/preview - all searches returned empty. Competitive analysis correctly identifies this as UX gap compared to competitors with "preview-then-confirm flows."

---

## 🔄 No Longer Applicable (3)

### HIGH Priority

**llm-1**: No retry logic or exponential backoff for transient LLM failures → [`bridge/src/llm.rs`](bridge/src/llm.rs) (DELETED) - File deleted from codebase (git status shows "D bridge/src/llm.rs"). The bridge has been refactored to remove all LLM functionality - no imports in main.rs, no Anthropic/Ollama client code. Bridge now only handles policy enforcement, WebSocket server, MCP tool dispatch, and audit logging. LLM calls are now handled by external MCP clients (like Claude Code), not by the bridge itself. Architecture shift: bridge previously operated in "Mode A" with internal LLM orchestration (where retry logic would have been relevant), but has transitioned to serving only as an MCP server (Mode B) where external clients control LLM interactions.

**llm-3**: No provider abstraction - monolithic implementation makes adding providers HARD → [`bridge/src/llm.rs`](bridge/src/llm.rs) (DELETED) - File completely deleted (566 lines removed) in commit cee1f1c (Aug 19, 2026). The entire internal LLM client layer was architecturally removed from the bridge. The bridge now operates as a pure policy/orchestration layer exposing MCP tools for external LLM agents, rather than containing its own LLM provider implementation. No LlmGateway, no complete_ollama, no complete_anthropic code exists in current codebase. README.md line 152 still mentions "LLM gateway (Anthropic/Ollama)" in Mode A description but this is outdated documentation.

### MEDIUM Priority

**llm-4**: Model list hardcoded instead of dynamic discovery → [`bridge/src/llm.rs`](bridge/src/llm.rs) (DELETED) - File completely deleted. The LlmGateway with hardcoded model list (`vec!["llama3.2:3b", "llama3.2:1b", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"]` at lines 173-177 in deleted version) no longer exists. No LLM gateway code found in current bridge source. This finding is not "fixed" by implementing dynamic discovery; rather, the component itself was removed, making the finding irrelevant to the current system.

---

## ❓ Cannot Verify (1)

### HIGH Priority

**disc-5**: README shows 'Low' and 'Moderate' as valid confirmation_policy values but policy.rs only defines Always/Sensitive/Never → [`README.md:100,301`](README.md#L100) vs [`bridge/src/policy.rs:26-30`](bridge/src/policy.rs#L26) - **Original claim appears to be based on misreading**. README line 100 mentions "Risk classification (Sensitive/Moderate/Low) with confirmation gates" in a feature description, but this refers to risk classification concepts, NOT confirmation_policy enum values. README lines 301 and 680 correctly document: "Valid `confirmation_policy` values: `\"always\"`, `\"sensitive\"`, `\"never\"` (lowercase only)" which matches policy.rs:26-30 ConfirmationPolicy enum (Always, Sensitive, Never) with #[serde(rename_all = "lowercase")]. While line 100's risk level description is imprecise (actual RiskClass enum at policy.rs:108-115 defines Read/Write/Navigation/Payment/Auth/Dangerous, not Sensitive/Moderate/Low), this is a separate documentation clarity issue from the finding's claim about confirmation_policy values.

---

## 📝 Summary

**What's Working**: Token budget warnings now function correctly, test coverage enforcement is in place, error logging has been improved, and the LLM abstraction layer issues were resolved by removing the layer entirely (architectural simplification).

**Critical Gaps**: Four medium-priority features remain unimplemented with explicit TODO comments (risk_thresholds, data_retention) or documented as known limitations (shadow DOM, multi-frame). One high-priority documentation inconsistency exists in FAQ.md. One roadmap UX enhancement (visual confirmation preview) remains unaddressed.

**Verification Coverage**: Only 13 of 53 (25%) findings were verified. Major areas not audited include: all security issues (vitest/vite CVEs, no CI/CD), most MCP implementation gaps (6 items), most action capabilities (10 of 11 items), and most quality issues (10 of 12 items). The 40 unaudited items represent significant blind spots in this verification pass.

**Recommendation**: Prioritize verification of CRITICAL security-1 (vitest RCE), HIGH security-3 (no PR CI), and HIGH quality-4 (orchestrator.ts untested) before next release.
