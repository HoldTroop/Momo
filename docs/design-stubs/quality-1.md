# Design Stub: quality-1 — Task Queue Underutilization

## Files to Modify

1. **`src/lib/task-queue.ts:15-27`** — Expand task types beyond periodic/sync/cleanup; add priority queue and scheduling API
2. **`src/sw/orchestrator.ts`** — Integrate task queue for background action chains, retry logic, deferred execution
3. **`src/sw/message-router.ts`** — Queue long-running MCP tool executions instead of blocking
4. **`src/lib/persistence.ts`** — Store pending tasks in IndexedDB for crash recovery
5. **`bridge/src/mcp_tools.rs`** — Add async task submission endpoint (`queue_action`, `check_task_status`)
6. **`src/lib/tool-registry.ts`** — Register task management tools (`list_pending_tasks`, `cancel_task`)

## MCP Tool Schema & Architecture Flow

**New MCP tools**:
- `queue_action(action, params, priority?, delay_ms?)` → `{task_id: string, status: "queued"}`
- `get_task_status(task_id)` → `{status: "queued"|"running"|"completed"|"failed", result?: any}`
- `cancel_task(task_id)` → `{cancelled: bool}`

**Flow**:
1. Long-running actions (multi-step navigation, form fills, waiting for page loads) submit to task queue
2. Queue maintains priority heap: HIGH (user-initiated) > MEDIUM (background sync) > LOW (cleanup)
3. Worker processes one task at a time, stores intermediate state in IndexedDB
4. On crash/extension reload, queue replays incomplete tasks from persistence layer (relates to quality-2 WAL replay)

## Security Implications

- **Task persistence risk**: Queued actions containing sensitive parameters (passwords, tokens) must not be persisted in plaintext
- **Queue poisoning**: Malicious tab could flood queue with low-priority tasks, causing DoS; needs per-origin rate limiting
- **Stale task execution**: Tasks queued before policy changes might execute with outdated permissions; must re-validate policy at execution time
- **Race conditions**: Concurrent task execution could violate single-session assumption (relates to mcp-2 global serialization)
- **Mitigation**: Encrypt sensitive task params at rest, enforce per-origin task quotas, re-check confirmation_policy before dequeuing, maintain single-worker invariant
