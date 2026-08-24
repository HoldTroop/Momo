# Phase 2: Architectural Decisions

**Date**: 2026-08-23  
**Status**: AWAITING APPROVAL  
**Phase**: Design decisions only — no code changes in this phase

---

## Overview

This document presents 12 architectural decisions for complex items requiring design choices before implementation. Each decision is presented with:
- The architectural question being resolved
- A recommended default with codebase-specific reasoning
- Alternative approaches with tradeoffs
- Dependencies on other decisions or debt items

All items are flagged **DECISION NEEDED** — these are recommendations for human approval, not implemented changes.

---

## Decision 1: disc-4 — Risk Threshold Enforcement

### Question
How should numeric risk thresholds be interpreted and enforced? What do threshold values represent, and over what time window are they evaluated?

### Recommended Default
**Sliding window action counter per risk category**

- Track action counts per category (read/write/navigation/payment/auth/dangerous) in a 1-hour sliding window
- Thresholds represent action count limits per category per window
- Example: `{read: 100, write: 20, payment: 3, dangerous: 1}` means max 100 reads, 20 writes, 3 payment actions, 1 dangerous action per hour
- Window slides continuously (not daily reset) to prevent "reset rush" exploits
- Store in `bridge/src/tracking.rs` with in-memory ring buffer + IndexedDB persistence for crash recovery

**Rationale**: Existing codebase has per-session orchestration state and IndexedDB persistence layer (persistence.ts). Sliding window matches the session-oriented design while preventing circumvention via timing. Simpler than weighted severity scoring.

### Alternatives

1. **Weighted severity score**: Each action has a severity weight; threshold is cumulative score limit
   - **Pro**: More granular control (1 dangerous = 10 reads)
   - **Con**: Requires defining weight values for every action type; harder to reason about

2. **Daily reset counters**: Reset all counters at midnight UTC
   - **Pro**: Simpler implementation (single timestamp check)
   - **Con**: Exploitable (user can exhaust quota, wait for reset, repeat)

### Dependencies
- **Blocks**: None
- **Blocked by**: None
- **Related**: disc-6 (retention policy affects how long counters are stored)

### DECISION NEEDED ✋

---

## Decision 2: disc-6 — Data Retention Policy Enforcement

### Question
When does a "session" end for retention purposes, and how should persistent log TTL be configured?

### Recommended Default
**Session ends on explicit termination or 24-hour timeout; persistent logs have configurable TTL with 90-day default**

- **Session lifetime**: Ends when (a) user clicks "End Session" in UI, (b) 24 hours of inactivity (no MCP tool calls), or (c) browser restart with no session resume within 1 hour
- **Persistent log TTL**: User-configurable via `DataRetentionPolicy.persistent_ttl_days` field (add to schema), default 90 days
- **Cleanup schedule**: Background task runs hourly to purge expired logs
- **Implementation**: New `bridge/src/audit_cleanup.rs` module with `cleanup_expired_logs()` function

**Rationale**: 24-hour timeout matches typical session timeout patterns in web applications. 90-day default aligns with common compliance retention periods (SOC2, GDPR "reasonable retention"). Hourly cleanup is frequent enough to prevent unbounded growth without excessive overhead.

### Alternatives

1. **Tab close = session end**: Session ends immediately when browser tab closes
   - **Pro**: More aggressive cleanup, lower storage usage
   - **Con**: Accidental tab close loses all audit history; conflicts with resume workflow

2. **Fixed 30-day persistent TTL**: No user configuration, hardcoded 30 days
   - **Pro**: Simpler (no config schema changes)
   - **Con**: Too restrictive for compliance use cases (many standards require 90+ days)

### Dependencies
- **Blocks**: None
- **Blocked by**: None
- **Related**: quality-2 (WAL replay needs session lifecycle awareness)

### DECISION NEEDED ✋

---

## Decision 3: mcp-6 — capture_viewport Tool Architecture

### Question
Should the VLM integration be synchronous (blocking) or asynchronous (queued), and where should the VLM API key be stored?

### Recommended Default
**Asynchronous with task queue integration; API key in bridge config with secure storage**

- **Execution model**: `capture_viewport` returns immediately with `task_id`, VLM processing runs in background, client polls `get_task_status(task_id)` for result
- **API key storage**: Store in bridge's secure config file (`~/.momo/config.toml`) with filesystem permissions 0600, never in IndexedDB
- **Rate limiting**: 10 screenshots/hour per session (enforced via disc-4 threshold system once implemented)
- **VLM provider**: Default to Anthropic Claude Vision API; make provider configurable for future extensibility

**Rationale**: Blocking on VLM API (2-5 second latency) would freeze the MCP request-response loop. Async execution matches the existing task-queue pattern (quality-1). Secure config file storage prevents API key leakage via IndexedDB export or devtools inspection.

### Alternatives

1. **Synchronous blocking execution**: Wait for VLM response before returning
   - **Pro**: Simpler implementation (no task queue integration)
   - **Con**: Blocks orchestrator during VLM call; poor UX for multi-second latency

2. **API key in environment variables**: Read from `ANTHROPIC_API_KEY` env var
   - **Pro**: Matches common dev practice
   - **Con**: Extension environment variables are not secure (visible in chrome://extensions internals)

### Dependencies
- **Blocks**: None
- **Blocked by**: quality-1 (task queue needs expansion for async execution model)
- **Related**: actions-6 (screenshot capture tooling is shared infrastructure)

### DECISION NEEDED ✋

---

## Decision 4: actions-1 — File Upload Security Model

### Question
What directories should be allowed for file uploads, and should the allow-list be user-configurable?

### Recommended Default
**Hardcoded allow-list of safe directories with opt-in user expansion**

- **Default allow-list**: `~/Downloads`, `~/Documents`, `~/Desktop` (cross-platform equivalents on Windows/Linux)
- **User expansion**: User can add additional directories via settings UI with explicit warning dialog
- **Path validation**: Canonicalize all paths, reject symlinks, reject paths outside allow-list (even via traversal)
- **File size limit**: 100MB hard cap (reject larger files before read)
- **MIME validation**: Check file magic bytes match declared MIME type using `file-type` npm package

**Rationale**: Default allow-list covers common user-accessible locations without exposing system directories. User expansion allows advanced workflows (e.g., test fixtures in project directories) without weakening default security. Existing codebase has no file-system permission model, so this establishes the first boundary.

### Alternatives

1. **User must approve every directory on first use**: No default allow-list, prompt for each new directory
   - **Pro**: Strongest security (explicit approval for every location)
   - **Con**: Poor UX for common workflows (e.g., uploading multiple files from Downloads)

2. **No allow-list**: User can upload from any readable path
   - **Pro**: Maximum flexibility
   - **Con**: Unacceptable security risk (agent could leak `/etc/passwd`, SSH keys, etc.)

### Dependencies
- **Blocks**: None
- **Blocked by**: None
- **Related**: actions-6, actions-7 (share "sensitive action" confirmation pattern)

### DECISION NEEDED ✋

---

## Decision 5: actions-4 — Tab Switching and Multi-Tab Orchestration

### Question
Should `switch_to_tab` maintain a single-tab orchestration model (pause old tab, resume new tab) or support true multi-tab coordination?

### Recommended Default
**Single-tab model with explicit context switching (pause/resume)**

- **Behavior**: `switch_to_tab` pauses orchestration on current tab, switches focus, resumes on new tab
- **State preservation**: Current tab's perception cache and action history are frozen but retained in memory
- **Resume semantics**: Switching back to paused tab restarts from frozen state (no re-perception unless explicitly requested)
- **Limitation**: Only one tab is "active" for orchestration at a time (consistent with existing `context.tabId` design)

**Rationale**: Existing orchestrator assumes single `context.tabId` (orchestrator.ts:586, 610, 634). Multi-tab coordination requires fundamental architectural changes (quality-3, roadmap-2). Single-tab model is a safe incremental step that enables tab-switching workflows without breaking orchestrator invariants.

### Alternatives

1. **True multi-tab orchestration**: Allow parallel action execution across multiple tabs
   - **Pro**: Enables advanced workflows (e.g., compare data across two tabs)
   - **Con**: Requires solving quality-3 (multi-frame coordination) and mcp-2 (global serialization) first; major architectural change

2. **No state preservation**: Switching tabs resets orchestration state
   - **Pro**: Simplest implementation (stateless)
   - **Con**: Poor UX (cannot return to previous tab's work)

### Dependencies
- **Blocks**: None (can implement incrementally)
- **Blocked by**: None (but true multi-tab requires quality-3 + mcp-2 resolution)
- **Related**: quality-3 (multi-frame coordination), roadmap-2 (multi-tab roadmap item)

### DECISION NEEDED ✋

---

## Decision 6: actions-5 — Iframe Targeting Depth Limit

### Question
What maximum iframe nesting depth should be supported to prevent resource exhaustion?

### Recommended Default
**3-level depth limit with configurable override**

- **Default limit**: Perception traverses iframes up to 3 levels deep (main → iframe → nested iframe → stop)
- **Rationale for 3**: Covers 95% of real-world scenarios (most sites have 0-2 iframe levels; 3+ is rare outside ads/malicious pages)
- **Override**: User can increase via settings (max 10 levels) with warning about performance impact
- **Error handling**: If target element is in iframe beyond depth limit, return clear error message with depth info

**Rationale**: Malicious pages can nest hundreds of iframes (iframe bombs). Unbounded traversal risks memory exhaustion and slow perception. 3-level limit balances functionality (supports common embedded widgets, payment forms) with safety.

### Alternatives

1. **No depth limit**: Traverse all iframes regardless of nesting
   - **Pro**: Maximum functionality
   - **Con**: Vulnerable to iframe bombs; perception could take minutes or crash extension

2. **1-level limit**: Only traverse direct children of main frame
   - **Pro**: Simplest, fastest
   - **Con**: Breaks common legitimate cases (e.g., Stripe payment iframe inside merchant's wrapper iframe)

### Dependencies
- **Blocks**: None
- **Blocked by**: None
- **Related**: quality-3 (multi-frame coordination), actions-8 (shadow-DOM has similar depth concern)

### DECISION NEEDED ✋

---

## Decision 7: actions-6 — Screenshot Storage and Lifecycle

### Question
Should screenshots be stored in IndexedDB for comparison operations, and if so, what is their TTL?

### Recommended Default
**Ephemeral in-memory storage with optional short-term IndexedDB cache**

- **Default behavior**: Screenshots stored in memory only (Map<ref_id, Blob>), cleared on tab navigation or session end
- **Comparison workflow**: `capture_screenshot` returns `ref_id`, `verify_visual_change(before_ref)` compares against in-memory ref
- **Optional persistence**: User can enable "screenshot history" mode, which stores last 10 screenshots per tab in IndexedDB with 24-hour TTL
- **Audit log**: All screenshot captures logged (timestamp, URL, ref_id) but image data is ephemeral

**Rationale**: Screenshots often contain PII/credentials. Default-ephemeral minimizes exposure window. In-memory storage is sufficient for within-session comparisons (the primary use case). Optional persistence supports debugging workflows without making it the default.

### Alternatives

1. **Always persist to IndexedDB**: Store all screenshots with 7-day TTL
   - **Pro**: Enables post-session debugging, historical comparison
   - **Con**: High disk usage (screenshots are large); persistent PII exposure risk

2. **Never store, always re-capture**: No caching at all
   - **Pro**: Zero storage footprint
   - **Con**: Re-capturing for comparison is wasteful (duplicate network traffic, visual state might have changed)

### Dependencies
- **Blocks**: None
- **Blocked by**: None
- **Related**: disc-6 (retention policy), mcp-6 (shares screenshot capture infrastructure)

### DECISION NEEDED ✋

---

## Decision 8: actions-7 — Network Interception Scope

### Question
Should network interception be tab-scoped (only current orchestrator tab) or global (all tabs)?

### Recommended Default
**Tab-scoped interception tied to active orchestrator context**

- **Scope**: `observe_network()` only intercepts requests from `context.tabId` (the current orchestrator tab)
- **Activation**: Interception enabled when first network tool is invoked, auto-disabled after 60 seconds of inactivity or tab switch
- **Buffer size**: Ring buffer of last 100 requests per tab (oldest evicted when buffer full)
- **Cross-tab isolation**: Tab A's network log is never visible to orchestrator working in Tab B

**Rationale**: Global interception violates user privacy (would capture requests from unrelated tabs). Tab-scoped matches existing orchestrator's single-tab model. Auto-disable prevents persistent performance overhead.

### Alternatives

1. **Global interception**: Capture all browser requests across all tabs
   - **Pro**: Enables cross-tab correlation (e.g., "did login in Tab A trigger API call visible in Tab B?")
   - **Con**: Major privacy violation; user cannot consent per-tab

2. **Request-scoped interception**: Only intercept specific URL patterns, never broad capture
   - **Pro**: Minimal performance impact
   - **Con**: Requires user to predict relevant URLs upfront; misses unexpected API calls

### Dependencies
- **Blocks**: None
- **Blocked by**: None
- **Related**: actions-4 (tab switching must disable old tab's interception)

### DECISION NEEDED ✋

---

## Decision 9: actions-8 — Shadow-DOM Risk Classification

### Question
Should all shadow-DOM actions automatically elevate to HIGH risk, or only for specific widget types (payment, auth)?

### Recommended Default
**Heuristic-based elevation: HIGH risk for sensitive widgets, MEDIUM for others**

- **HIGH risk** (HITL confirmation required):
  - Shadow root contains `input[type=password]` or `input[autocomplete*=cc-]` (credit card)
  - Host element is from known payment providers (stripe.com, square.com, paypal.com)
  - Host element has ARIA role `dialog` or `alertdialog` (modal dialogs often contain sensitive forms)
- **MEDIUM risk** (policy-based confirmation):
  - All other shadow-DOM actions
- **Audit trail**: Log shadow boundary crossings with risk classification reasoning

**Rationale**: Blanket HIGH risk for all shadow-DOM would generate excessive confirmation prompts (many benign widgets use shadow-DOM for styling). Heuristic targets actual sensitive content while preserving usability.

### Alternatives

1. **Always HIGH risk**: All shadow-DOM actions require HITL confirmation
   - **Pro**: Safest (no heuristic false negatives)
   - **Con**: Poor UX (e.g., clicking a styled button in a web component triggers HITL prompt)

2. **Never elevate**: Treat shadow-DOM actions same as regular DOM
   - **Pro**: No additional confirmation overhead
   - **Con**: Misses the fact that shadow-DOM is often used to isolate sensitive UI

### Dependencies
- **Blocks**: None
- **Blocked by**: None
- **Related**: disc-4 (risk classification feeds into threshold enforcement)

### DECISION NEEDED ✋

---

## Decision 10: quality-1 — Task Queue Priority Model

### Question
Should the task queue use strict priority (HIGH always runs before MEDIUM) or fair scheduling (prevent starvation)?

### Recommended Default
**Fair scheduling with priority weighting (high = 3x, medium = 1x, low = 0.5x)**

- **Scheduling**: When queue is non-empty, select next task by weighted random: `weight = task.priority_multiplier * (1 + age_minutes/60)`
- **Priority multipliers**: HIGH = 3.0, MEDIUM = 1.0, LOW = 0.5
- **Age bonus**: Tasks gain weight over time (~1.67% per minute, reaching 100% bonus after 60 minutes) to prevent indefinite starvation
- **Example with current formula**: 
  - Fresh HIGH task: `3.0 × (1 + 0/60) = 3.0`
  - 10-minute LOW task: `0.5 × (1 + 10/60) ≈ 0.583`
  - LOW task needs ~300 minutes (5 hours) to reach parity with fresh HIGH

**Rationale**: Strict priority causes starvation (low-priority background sync never runs if high-priority actions keep arriving). Fair scheduling ensures all tasks eventually execute while still favoring higher priority. Existing orchestrator has no queue-starvation protections.

**⚠️ CONSIDERATION**: For an interactive browser agent, a 5-hour wait for LOW-priority tasks may be unreasonably long. Alternative formula with faster convergence: `weight = task.priority_multiplier * (1 + age_minutes/15)` would give:
- Fresh HIGH: 3.0
- 10-minute LOW: 0.5 × (1 + 10/15) ≈ 0.833
- LOW reaches parity at 75 minutes (1.25 hours)

This 4x faster convergence (15-minute divisor vs 60-minute) still preserves priority while preventing multi-hour starvation. **Recommend reviewing the 5-hour window before implementation** — if too long, consider reducing the divisor to 15 or 20.

### Alternatives

1. **Strict priority with timeout fallback**: HIGH always first, but if LOW task waits >1 hour, force-run it
   - **Pro**: Simpler (no weighted random math)
   - **Con**: Still allows near-starvation (LOW tasks always delayed)

2. **Round-robin regardless of priority**: Ignore priority, just FIFO
   - **Pro**: Simplest implementation
   - **Con**: Defeats purpose of having priorities

### Dependencies
- **Blocks**: mcp-6 (async VLM execution needs queue)
- **Blocked by**: None
- **Related**: quality-2 (WAL replay for crash recovery of queued tasks)

### DECISION NEEDED ✋

---

## Decision 11: quality-2 — WAL Operation Schema

### Question
What operations should be logged to the WAL, and how should they be validated on replay?

### Recommended Default
**Allowlist of state-mutating operations with JSON-schema validation**

**WAL operations**:
```typescript
type WalOperation =
  | { op: 'addStep', step: PlanStep }
  | { op: 'updateStepStatus', index: number, status: StepStatus }
  | { op: 'setToolResult', stepIndex: number, result: ToolResult }
  | { op: 'appendHistory', message: Message }
  | { op: 'updateGoal', goal: string }
```

**Validation on replay**:
- Check `op` is in allowlist (reject unknown operations)
- Validate payload against JSON schema for that operation type
- Verify index bounds (e.g., `updateStepStatus` index < steps.length)
- Skip operations that reference redacted data (if `data` contains `[REDACTED]` sentinel)

**Rationale**: Allowlist prevents replay of malicious operations injected via IndexedDB tampering. JSON schema validation catches malformed payloads. Existing codebase has SuperJSON serialization but no validation layer.

### Alternatives

1. **No validation, trust WAL contents**: Replay all operations blindly
   - **Pro**: Faster replay (no validation overhead)
   - **Con**: Vulnerable to IndexedDB tampering (attacker could inject arbitrary state mutations)

2. **Cryptographically signed WAL entries**: HMAC each entry with secret key
   - **Pro**: Strongest integrity guarantee
   - **Con**: Requires key management; overkill for single-user extension

### Dependencies
- **Blocks**: None
- **Blocked by**: None
- **Related**: disc-6 (retention policy affects WAL cleanup), quality-1 (task queue needs WAL for crash recovery)

### DECISION NEEDED ✋

---

## Decision 12: quality-3 — Frame Context Switching UX

### Question
Should frame-targeted actions be explicit (`click(selector, frame_id)`) or implicit (`click(selector)` auto-resolves frame from perception)?

### Recommended Default
**Explicit frame_id parameter with auto-resolve fallback**

- **Primary mode**: Tools accept optional `frame_id` parameter (e.g., `click(selector, {frame_id: 123})`)
- **Auto-resolve fallback**: If `frame_id` omitted, resolve from element ref (perception metadata includes `{ref: "el_42", frame_id: 0}`)
- **Error handling**: If selector matches elements in multiple frames without `frame_id`, return error listing all matching frames
- **MCP tool**: Add `list_frames()` tool returning `{frame_id, origin, src, name, depth}[]` for explicit targeting

**Rationale**: Explicit parameter gives advanced users full control. Auto-resolve fallback makes simple cases (single-frame page) ergonomic (no need to specify frame_id: 0 every time). Existing perception already tracks element metadata, extending with frame_id is straightforward.

### Alternatives

1. **Always explicit**: No auto-resolve, frame_id is required parameter
   - **Pro**: No ambiguity
   - **Con**: Poor UX for common case (most pages have only main frame)

2. **Always implicit**: Tools never accept frame_id, always auto-resolve from perception
   - **Pro**: Simplest API surface
   - **Con**: Impossible to target second occurrence of selector in different frame

### Dependencies
- **Blocks**: actions-5 (iframe targeting needs this decision)
- **Blocked by**: None
- **Related**: actions-4 (tab switching and frame switching are analogous patterns)

### DECISION NEEDED ✋

---

## Summary of Dependencies

### No Blockers (Can Start Immediately After Approval)
- disc-4 (Risk threshold enforcement)
- disc-6 (Data retention policy)
- actions-1 (File upload)
- actions-6 (Screenshot tools)
- actions-7 (Network interception)
- actions-8 (Shadow-DOM)
- quality-2 (WAL replay)

### Has Prerequisites
- **mcp-6** (VLM tool) — Blocked by quality-1 (needs task queue for async execution)
- **actions-4** (Tab switching) — Related to quality-3 but can proceed with single-tab model
- **actions-5** (Iframe targeting) — Blocked by quality-3 (multi-frame coordination) for full implementation
- **quality-1** (Task queue) — Blocks mcp-6
- **quality-3** (Multi-frame) — Blocks actions-5

### Recommended Implementation Order

**Phase 3 (Can Start Immediately)**:
1. disc-4, disc-6 (policy enforcement — foundational)
2. quality-2 (WAL replay — improves crash recovery)
3. actions-1, actions-6, actions-7, actions-8 (independent tool additions)

**Phase 4 (After Phase 3)**:
1. quality-1 (task queue expansion)
2. mcp-6 (VLM tool, depends on quality-1)
3. quality-3 (multi-frame coordination)
4. actions-4 (tab switching, enhanced by quality-3)
5. actions-5 (iframe targeting, depends on quality-3)

---

## Explicit Statement

**No code was changed in this phase.** This document contains design decisions only. Implementation will occur in subsequent phases after human approval of these recommendations.
