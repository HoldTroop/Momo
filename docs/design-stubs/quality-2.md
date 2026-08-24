# Design Stub: quality-2 — WAL Replay Implementation

**Issue**: `getWalEntries`/`appendWal` exist but no full replay logic (checkpoint restore only); crash recovery incomplete.

## Files to Modify

1. **src/lib/persistence.ts:203-279** — Add `replayFromCheckpoint(sessionId)` method
2. **src/sw/orchestrator.ts** — Call replay on session resume/recovery path
3. **src/types/index.ts** — Add `WalOperation` discriminated union for type-safe replay

## Architecture Flow

```
replayFromCheckpoint(sessionId):
  1. checkpoint = getLatestCheckpoint(sessionId)
  2. if (!checkpoint) return baseState
  3. state = deserialize(checkpoint.stateSnapshot)
  4. entries = getWalEntries(sessionId, afterPosition: checkpoint.walPosition)
  5. for entry in entries:
       state = applyOperation(state, entry.operation, entry.data)
  6. return state

applyOperation(state, op, data):
  switch (op):
    'addStep': state.plan.steps.push(data)
    'updateStepStatus': state.plan.steps[data.index].status = data.status
    'setToolResult': state.results[data.stepIndex] = data.result
    ...
```

## Security Implications

- **Replay integrity**: WAL entries are SuperJSON-serialized; malicious IndexedDB tampering could inject arbitrary operations → validate `operation` against allowlist before dispatch
- **State divergence**: Checkpoint + WAL must be atomic; concurrent writes during checkpoint can create inconsistent replay → use transaction-level locking or version vectors
- **Redaction preservation**: `redactValue()` strips secrets before WAL write, but replay must not rehydrate missing fields from stale state → explicit null-coalescing for redacted paths
