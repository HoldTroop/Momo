import { AgentState, Checkpoint, WalEntry, WalOperation, TaskQueueEntry, TaskStatus } from '../sw/orchestrator.js';
import SuperJSON from 'superjson';
import { redactText } from './redaction.js';

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
  private walPosition = 0;

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
      data: entry.data,
    };

    const id = await this.db.wal.add(record);
    this.walPosition = id;
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

  getWalPosition(): number {
    return this.walPosition;
  }

  async saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    if (!this.initialized) await this.init();

    const record: CheckpointRecord = {
      sessionId,
      stepIndex: checkpoint.stepIndex,
      stateSnapshot: SuperJSON.serialize(checkpoint.stateSnapshot),
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
      payload: entry.payload,
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

  private redactStateForPersistence(state: AgentState): AgentState {
    return {
      ...state,
      domCache: new Map(
        Array.from(state.domCache.entries()).map(([url, dom]) => [url, this.redactCompressedDom(dom)])
      ),
      history: state.history.map(step => ({
        ...step,
        result: {
          ...step.result,
          summary: redactText(step.result.summary ?? ''),
        },
      })),
    };
  }

  private serializeState(state: AgentState): any {
    return SuperJSON.serialize({
      ...state,
      domCache: Array.from(state.domCache.entries()),
    });
  }

  private deserializeState(data: any): AgentState {
    const deserialized = SuperJSON.deserialize(data) as any;
    return {
      ...deserialized,
      domCache: new Map(deserialized.domCache || []),
    };
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