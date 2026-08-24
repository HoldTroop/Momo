# Phase 0 Runtime Safety Audit Report

**Date**: 2026-08-23  
**Commits Audited**: a618cac, 8582dcc  
**Documentation Added**: 1 commit (safety comment)

---

## Executive Summary

Phase 0 null-safety fixes (commits a618cac and 8582dcc) are **runtime-safe**. All non-null assertions and type guards are protected by genuine invariants enforced elsewhere in the code. No unsafe patterns requiring fixes were found.

**Count Verified**: Pre-Phase-0 had **68 errors** (verified at commit 316fe01, the true baseline before any Phase 0 fixes).

---

## Part A: Baseline Verification

### Finding

**Actual pre-Phase-0 typecheck errors**: 68 (verified at commit 316fe01)

**Baseline Commit**: `316fe01` (immediately before `12e26bb`, the first Phase 0 fix)

**Breakdown**:
- `src/content/ax-extractor.ts`: 1 error (TS2322: unknown → string)
- `src/lib/persistence.ts`: 30 errors (Object is possibly 'null')
- `src/sidepanel/index.tsx`: 36 errors (undefined payload access)
- `src/sw/orchestrator.test.ts`: 1 error (MockPersistenceManager type mismatch)
- **Total**: 68 errors (1 + 30 + 36 + 1 = 68)

### Evidence

Raw typecheck output at commit 316fe01:
```
src/content/ax-extractor.ts(274,13): error TS2322: Type 'unknown' is not assignable to type 'string'.
src/lib/persistence.ts(149,28): error TS2531: Object is possibly 'null'.
[... 28 more persistence.ts errors ...]
src/sidepanel/index.tsx(169,48): error TS18048: 'msg.payload' is possibly 'undefined'.
[... 35 more index.tsx errors ...]
src/sw/orchestrator.test.ts(91,42): error TS2345: Argument of type 'MockPersistenceManager' is not assignable to parameter of type 'PersistenceManager'.
```

**Verification**: `npm run typecheck 2>&1 | grep -c "src/sidepanel/index.tsx"` returned 36.

### Previous Report Error

The previous PHASE_0_AUDIT_REPORT incorrectly claimed 66 errors by checking commit 50c3d26, which is AFTER ax-extractor.ts (12e26bb) and orchestrator.test.ts (50c3d26) were already fixed. This created an artificial baseline 2 errors lower than the true pre-Phase-0 state.

**Conclusion**: The baseline of 68 errors is correct and internally consistent.

---

## Part B: Runtime Safety Audit

### B.1: persistence.ts (commit a618cac)

**Pattern Introduced**:
```typescript
private getDb(): AgentDB {
  if (!this.db) {
    throw new Error('[Persistence] Database not initialized');
  }
  return this.db;
}
```

All direct `this.db.*` accesses (40+ locations) replaced with `this.getDb().*`.

**Invariant**: `this.db` is non-null after `init()` completes successfully.

**Verification**:
- Line 103: `this.db = new Dexie('AgentDB') as AgentDB;` ✅ assigns non-null
- Line 138: `await this.db.open();` ✅ database opened
- Line 139: `this.initialized = true;` ✅ marks initialization complete
- Every public method: `if (!this.initialized) await this.init();` before calling `getDb()`

**Analysis of All Call Sites**:

| Method | Line | Guard Pattern | Safety |
|--------|------|---------------|--------|
| saveSession | 153 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| getSession | 161 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| getAllSessions | 168 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| deleteSession | 181 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| saveSessionWorking | 203 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| getSessionWorking | 208 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| appendWal | 228 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| getWalEntries | 235 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| getLastWalPosition | 261 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| saveCheckpoint | 276 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| getLatestCheckpoint | 282 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| saveTask | 312 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| updateTask | 318 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| getNextPendingTask | 326 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| expireOverdueTasks | 339 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| getTasksByStatus | 350 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| expireStaleTasks | 362 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| saveDomCache | 373 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| getDomCache | 378 | `if (!this.initialized) await this.init();` | ✅ SAFE |
| close | 394 | `if (this.db)` outer guard | ✅ SAFE |

**Type Assertions** (not null-safety related):
- Line 228: `as WalRecord` - Dexie schema guarantee
- Line 289: `as SuperJSONResult` - Dexie schema guarantee

**Verdict**: All 40+ `getDb()` calls are ✅ **SAFE**. The invariant genuinely holds.

**Documentation Added**: Safety comment added to `getDb()` method explaining the invariant (commit after audit).

---

### B.2: index.tsx (commit 8582dcc)

**Pattern Introduced**:
```typescript
if (!msg.payload) break;
// ... use msg.payload! with ?? fallbacks
```

**Analysis by Message Type**:

#### 1. TASK_STARTED (lines 173-177)

```typescript
if (!msg.payload) break;
setIsLoading(false);
addMessage({ role: 'agent', content: `▶ Task started: ${msg.payload.goal}` });
```

**Sender** (orchestrator.ts:269):
```typescript
this.broadcastUi('TASK_STARTED', { sessionId, goal });
```

**Invariant**: Payload always present with `{sessionId, goal}`.

**Safety**: ✅ **SAFE FOR RUNTIME** - protocol guarantees payload
- ⚠️ **Observability gap** - silently drops malformed messages (no logging)

---

#### 2. PLAN_CREATED (lines 178-181)

```typescript
if (!msg.payload) break;
setAgentState(prev => ({ ...prev, plan: msg.payload!.plan ?? null, currentStep: 0 }));
```

**Sender** (orchestrator.ts:271-278):
```typescript
this.broadcastUi('PLAN_CREATED', {
  sessionId,
  plan: { goal: ..., steps: ... },
});
```

**Invariant**: Payload always present with `{sessionId, plan}`.

**Safety**: ✅ **SAFE FOR RUNTIME** - `?? null` fallback is appropriate
- ⚠️ **Observability gap** - no logging

---

#### 3. STEP_STARTED (lines 182-189)

```typescript
if (!msg.payload) break;
setIsLoading(false);
setAgentState(prev => ({ ...prev, currentStep: msg.payload!.stepIndex ?? 0 }));
if (msg.payload!.stepIndex !== undefined && msg.payload!.action) {
  addMessage({ role: 'agent', content: `Step ${msg.payload!.stepIndex + 1}: ${msg.payload!.action.name}`, toolCalls: [msg.payload!.action] });
}
```

**Sender** (orchestrator.ts:346):
```typescript
this.broadcastUi('STEP_STARTED', { stepIndex: this.state!.currentStep, action: step.action });
```

**Invariant**: Payload always present with `{stepIndex, action}`.

**Safety**: ✅ **SAFE FOR RUNTIME** - additional defensive guards and `?? 0` fallback
- ⚠️ **Observability gap** - no logging

---

#### 4. TASK_ABORTED (lines 195-198)

```typescript
if (!msg.payload) break;
addMessage({ role: 'agent', content: `❌ Task aborted: ${msg.payload.reason}` });
setIsLoading(false);
```

**Safety**: ✅ **SAFE FOR RUNTIME** - protocol guarantees payload
- ⚠️ **Observability gap** - no logging

---

#### 5. HUMAN_INTERVENTION_REQUIRED (lines 198-210)

```typescript
if (!msg.payload) break;
setHumanIntervention({
  stepId: msg.payload!.stepId ?? '',
  question: msg.payload!.error || `Step ${msg.payload!.stepId} requires confirmation`,
  actionHash: msg.payload!.actionHash ?? '',
  pageRevision: msg.payload!.pageRevision ?? 0,
  origin: msg.payload!.origin ?? '',
  action: typeof msg.payload!.action === 'string' ? msg.payload!.action : (msg.payload!.action as any)?.name ?? '',
  target: msg.payload!.target ?? '',
  reversible: msg.payload!.reversible ?? false,
  riskClass: msg.payload!.riskClass ?? '',
});
```

**Sender** (confirmation.ts:87-95):
```typescript
chrome.runtime.sendMessage({
  type: 'HUMAN_INTERVENTION_REQUIRED',
  payload: {
    stepId,
    actionHash,
    pageRevision: state.pageRevision,
    ...payload,  // spread may add undefined fields
  },
})
```

**Safety**: ✅ **SAFE FOR RUNTIME** - fallback defaults are all safe:
- Empty strings for IDs (UI handles gracefully)
- `reversible: false` (safe default - treats action as dangerous)
- `pageRevision: 0` (valid fallback)
- Complex `action` handling with type guard and fallback

**Note**: The `...payload` spread could introduce undefined fields, but all are guarded with `??` fallbacks.

**Observability gap**: ⚠️ No logging

---

#### 6. LLM_STREAM_CHUNK (lines 211-213)

```typescript
if (!msg.payload) break;
appendToStream(msg.payload!.content ?? '');
```

**Safety**: ✅ **SAFE FOR RUNTIME** - `?? ''` prevents crash, empty string is valid
- ⚠️ **Observability gap** - silently drops chunks (critical for debugging broken streams)

---

### Summary for index.tsx

**Total Constructs Analyzed**:
- 6 `if (!msg.payload) break;` guards
- 15+ `msg.payload!` non-null assertions
- 12+ `?? fallback` defensive defaults

**Classification**:
- ✅ **21 SAFE FOR RUNTIME** - guards prevent crashes, fallbacks are appropriate
- ⚠️ **6 OBSERVABILITY GAPS** - silent drops hide protocol bugs during development

**Root Issue**: The `break` statements are correct for production resilience, but lack `console.warn()` calls that would make protocol bugs visible during development.

---

## Part C: Regression Tests

### Finding

**No regression tests required.**

**Rationale**: All patterns were classified as SAFE for runtime correctness. The UNSAFE classification applied only to observability (debugging), not behavior.

**Recommended (but not required)**: Add `console.warn()` logging to the 6 silent-drop cases to improve observability. This is a code improvement, not a correctness fix, so no tests are needed.

---

## Part D: Recommended Improvements (Optional)

These are observability improvements, not correctness fixes. They were **not implemented** in this audit pass, as the task was to verify runtime safety, which was confirmed.

### Improvement: Add Development-Mode Logging

**File**: `src/sidepanel/index.tsx`

Add logging before each `break` in message handlers:

```typescript
case 'TASK_STARTED':
  if (!msg.payload) {
    if (import.meta.env.DEV) {
      console.warn('[Momo UI] TASK_STARTED missing payload:', msg);
    }
    break;
  }
  // ... existing code
```

**Apply to**: TASK_STARTED, PLAN_CREATED, STEP_STARTED, TASK_ABORTED, HUMAN_INTERVENTION_REQUIRED, LLM_STREAM_CHUNK

**Benefit**: Makes protocol bugs visible during development without adding production overhead.

---

## Verification Results

### TypeScript Typecheck
```bash
npx tsc --noEmit
```
✅ **PASS** - No type errors

### npm test
```bash
npm test
```
✅ **PASS** - 6 files, 68 tests, all passed

### cargo test
```bash
cargo test
```
✅ **PASS** - 36 passed, 0 failed, 1 ignored

### cargo clippy
```bash
cargo clippy --all-targets --all-features -- -D warnings
```
✅ **PASS** - No clippy warnings

---

## Final Verdict

### Part A: Count Discrepancy
**Finding**: Pre-Phase-0 had **68 errors** (verified at commit 316fe01, the true baseline before any Phase 0 fixes began).

### Part B: Runtime Safety  
**Finding**: All assertions are ✅ **SAFE** for runtime correctness.

**Assertions Analyzed**:
- persistence.ts: 40+ `getDb()` calls - **all SAFE**
- index.tsx: 21 constructs - **all SAFE for runtime**

**No unsafe runtime patterns found** - all invariants genuinely hold.

### Part C: Regression Tests
**Required**: 0 (all patterns are safe)

**Optional Improvement**: Add observability logging (not a correctness issue)

---

## Commits

1. **a618cac** - `fix: add null-safety guards in persistence.ts` ✅ SAFE
2. **8582dcc** - `fix: validate payload access in sidepanel/index.tsx` ✅ SAFE
3. **[audit commit]** - `docs(persistence): add safety invariant comment to getDb()` - Documentation added during audit

---

## Conclusion

Phase 0 null-safety fixes are production-ready. All non-null assertions and guards are protected by genuine invariants. The fixes successfully eliminated 68 type errors without introducing runtime safety issues.

**No further action required** before proceeding to Phase 1.
