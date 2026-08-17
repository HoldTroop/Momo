import { AgentState, Checkpoint, WalEntry, WalOperation, TaskQueueEntry, TaskStatus } from '../sw/orchestrator.js';
import SuperJSON from 'superjson';
import { redactText, redactValue } from './redaction.js';

declare global {
  interface Window {
    Dexie: any;
    dexie: any;
  }
}

interface SessionRecord {
  sessionId: string;
  state: AgentState;
  createdAt: number;
  updatedAt: number;
}

interface WalRecord {
  id: number;
  sessionId: string;
  timestamp: number;
  operation: WalOperation;
  data: unknown;
}

interface CheckpointRecord {
  sessionId: string;
  stepIndex: number;
  stateSnapshot: unknown;
  walPosition: number;
  timestamp: number;
}

interface TaskRecord {
  id: string;
  sessionId: string;
  type: string;
  payload: unknown;
  priority: number;
  deadline: number;
  retryPolicy: unknown;
  attempts: number;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

class PersistenceManager {
  private db: any = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    // Dynamic import Dexie
    const { default: Dexie } = await import('dexie');
    this.db = new Dexie('AgentDB');

    this.db.version(1).stores({
      sessions: 'sessionId, updatedAt',
      wal: '++id, sessionId, timestamp',
      checkpoints: 'sessionId, stepIndex, timestamp',
      tasks: 'id, sessionId, status, deadline, priority',
    });

    this.db.version(2).stores({
      sessions: 'sessionId, updatedAt',
      wal: '++id, sessionId, timestamp',
      checkpoints: 'sessionId, stepIndex, timestamp',
      tasks: 'id, sessionId, status, deadline, priority',
      domCache: 'url, timestamp',
    }).upgrade(async (trans: any) => {
      // Migration from v1 to v2
      await trans.table('domCache').clear();
    });

    await this.db.open();
    this.initialized = true;
    console.log('[Persistence] Initialized');
  }

  async saveSession(sessionId: string, state: AgentState): Promise<void> {
    if (!this.initialized) await this.init();

    const existing = await this.db.sessions.get(sessionId);
    const record: SessionRecord = {
      sessionId,
      state: this.serializeState(this.redactStateForPersistence(state)),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };

    await this.db.sessions.put(record);
  }

  async getSession(sessionId: string): Promise<AgentState | null> {
    if (!this.initialized) await this.init();

    const record = await this.db.sessions.get(sessionId);
    return record ? this.deserializeState(record.state) : null;
  }

  async getAllSessions(): Promise<Array<{ state: AgentState; createdAt: number; updatedAt: number }>> {
    if (!this.initialized) await this.init();

    const records = await this.db.sessions.orderBy('updatedAt').reverse().toArray();
    return records.map((r: SessionRecord) => ({
      state: this.deserializeState(r.state),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.initialized) await this.init();

    await this.db.transaction('rw', this.db.sessions, this.db.wal, this.db.checkpoints, this.db.tasks, async () => {
      await this.db.sessions.delete(sessionId);
      await this.db.wal.where('sessionId').equals(sessionId).delete();
      await this.db.checkpoints.where('sessionId').equals(sessionId).delete();
      await this.db.tasks.where('sessionId').equals(sessionId).delete();
    });
  }

  async appendWal(sessionId: string, entry: Omit<WalEntry, 'id'>): Promise<number> {
    if (!this.initialized) await this.init();

    const record: Omit<WalRecord, 'id'> = {
      sessionId,
      timestamp: entry.timestamp,
      operation: entry.operation,
      data: redactValue(entry.data),
    };

    const id = await this.db.wal.add(record);
    return id;
  }

  async getWalEntries(sessionId: string, afterPosition: number): Promise<WalEntry[]> {
    if (!this.initialized) await this.init();

    const records = await this.db.wal
      .where('sessionId').equals(sessionId)
      .and((r: WalRecord) => r.id > afterPosition)
      .toArray();

    return records.map((r: WalRecord) => ({
      id: r.id,
      timestamp: r.timestamp,
      operation: r.operation,
      data: r.data,
    }));
  }

  async getWalPosition(): Promise<number> {
    if (!this.initialized) await this.init();
    // The WAL position is the highest auto-increment id actually persisted, not
    // an in-memory counter that resets on service-worker restart (MOMO-116).
    const last = await this.db.wal.orderBy('id').last();
    return last?.id ?? 0;
  }

  async saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    if (!this.initialized) await this.init();

    const record: CheckpointRecord = {
      sessionId,
      stepIndex: checkpoint.stepIndex,
      stateSnapshot: SuperJSON.serialize(redactValue(checkpoint.stateSnapshot)),
      walPosition: checkpoint.walPosition,
      timestamp: checkpoint.timestamp,
    };

    await this.db.checkpoints.put(record);
  }

  async getLatestCheckpoint(sessionId: string): Promise<Checkpoint | null> {
    if (!this.initialized) await this.init();

    const record = await this.db.checkpoints
      .where('sessionId').equals(sessionId)
      .reverse()
      .sortBy('timestamp')
      .then((arr: CheckpointRecord[]) => arr[0] || null);

    return record ? {
      stepIndex: record.stepIndex,
      stateSnapshot: SuperJSON.deserialize(record.stateSnapshot),
      walPosition: record.walPosition,
      timestamp: record.timestamp,
    } : null;
  }

  async saveTask(entry: TaskQueueEntry): Promise<void> {
    if (!this.initialized) await this.init();

    const record: TaskRecord = {
      id: entry.id,
      sessionId: entry.sessionId,
      type: entry.type,
      payload: redactValue(entry.payload),
      priority: entry.priority,
      deadline: entry.deadline,
      retryPolicy: entry.retryPolicy,
      attempts: entry.attempts,
      status: entry.status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.db.tasks.put(record);
  }

  async updateTask(id: string, updates: Partial<TaskRecord>): Promise<void> {
    if (!this.initialized) await this.init();

    await this.db.tasks.update(id, { ...updates, updatedAt: Date.now() });
  }

  async getNextPendingTask(sessionId: string): Promise<TaskQueueEntry | null> {
    if (!this.initialized) await this.init();

    const record = await this.db.tasks
      .where('sessionId').equals(sessionId)
      .and((r: TaskRecord) => r.status === 'pending' && r.deadline > Date.now())
      .sortBy('priority')
      .then((arr: TaskRecord[]) => arr.sort((a, b) => b.priority - a.priority)[0] || null);

    return record ? this.deserializeTask(record) : null;
  }

  async getTasksByStatus(sessionId: string, status: TaskStatus): Promise<TaskQueueEntry[]> {
    if (!this.initialized) await this.init();

    const records = await this.db.tasks
      .where('sessionId').equals(sessionId)
      .and((r: TaskRecord) => r.status === status)
      .toArray();

    return records.map((r: TaskRecord) => this.deserializeTask(r));
  }

  /** Requeue tasks stranded in `running` from a previous lifetime back to `pending`. */
  async requeueStaleRunningTasks(sessionId: string, staleBeforeMs: number): Promise<number> {
    if (!this.initialized) await this.init();

    return this.db.tasks
      .where('sessionId').equals(sessionId)
      .filter((r: TaskRecord) => r.status === 'running' && r.updatedAt < staleBeforeMs)
      .modify((r: TaskRecord) => {
        r.status = 'pending';
      });
  }

  async saveDomCache(url: string, compressedDom: any): Promise<void> {
    if (!this.initialized) await this.init();

    await this.db.domCache.put({ url, data: this.redactCompressedDom(compressedDom), timestamp: Date.now() });
  }

  async getDomCache(url: string): Promise<any | null> {
    if (!this.initialized) await this.init();

    const record = await this.db.domCache.get(url);
    return record?.data || null;
  }

  async migrate(previousVersion?: string): Promise<void> {
    console.log('[Persistence] Migrating from', previousVersion);
    // Handle schema migrations
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.initialized = false;
    }
  }

  private redactCompressedDom(dom: any): any {
    if (!dom) return dom;
    return {
      ...dom,
      title: redactText(dom.title ?? ''),
      summary: redactText(dom.summary ?? ''),
      actions: Array.isArray(dom.actions)
        ? dom.actions.map((a: any) => ({ ...a, label: redactText(a.label ?? '') }))
        : dom.actions,
    };
  }

  /**
   * Redact a tool call's arguments before they enter the persisted session. The
   * one argument that carries an arbitrary secret (the exact text typed by
   * `type`/`human_type`) is dropped outright; every other argument is scrubbed of
   * embedded secrets (emails, keys, tokens, card numbers) by `redactValue`.
   */
  private redactToolCall(action: { name: string; arguments: Record<string, unknown> }): { name: string; arguments: Record<string, unknown> } {
    if (action.name === 'type' || action.name === 'human_type') {
      return { ...action, arguments: { ...action.arguments, text: '[REDACTED]' } };
    }
    return { ...action, arguments: redactValue(action.arguments) as Record<string, unknown> };
  }

  private redactStateForPersistence(state: AgentState): AgentState {
    return {
      ...state,
      // `pendingHumanIntervention` holds `resolve`/`reject` closures that cannot
      // be serialized (and must not round-trip). Persist nothing in its place;
      // a restored session is never mid-confirmation — the confirmation is
      // re-armed by re-execution, or the session is errored on restart (D1).
      pendingHumanIntervention: null,
      // Goal, plan arguments, and variables may all embed PII/secrets the
      // external agent supplied (MOMO-017/070/076/113).
      goal: redactText(state.goal),
      plan: state.plan
        ? {
            ...state.plan,
            goal: redactText(state.plan.goal),
            steps: state.plan.steps.map(step => ({
              ...step,
              action: this.redactToolCall(step.action),
              expectedOutcome: redactText(step.expectedOutcome),
            })),
          }
        : null,
      variables: redactValue(state.variables) as Record<string, unknown>,
      history: state.history.map(step => ({
        ...step,
        action: this.redactToolCall(step.action),
        result: {
          ...step.result,
          data: redactValue(step.result.data),
          summary: redactText(step.result.summary ?? ''),
          error: step.result.error ? redactText(step.result.error) : undefined,
          confirmationData: step.result.confirmationData
            ? {
                ...step.result.confirmationData,
                target: redactText(step.result.confirmationData.target),
                data: redactValue(step.result.confirmationData.data) as Record<string, unknown>,
              }
            : undefined,
        },
      })),
    };
  }

  private serializeState(state: AgentState): any {
    return SuperJSON.serialize({ ...state });
  }

  private deserializeState(data: any): AgentState {
    return SuperJSON.deserialize(data) as AgentState;
  }

  private deserializeTask(record: TaskRecord): TaskQueueEntry {
    return {
      id: record.id,
      sessionId: record.sessionId,
      type: record.type as any,
      payload: record.payload,
      priority: record.priority,
      deadline: record.deadline,
      retryPolicy: record.retryPolicy as any,
      attempts: record.attempts,
      status: record.status,
    };
  }
}

export const persistence = new PersistenceManager();
export { PersistenceManager };