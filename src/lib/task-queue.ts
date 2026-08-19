import { PersistenceManager } from './persistence.js';
import { TaskQueueEntry, TaskType, RetryPolicy, TaskStatus } from '../sw/orchestrator.js';

export class TaskQueue {
  private persistence: PersistenceManager;
  private processing = false;
  private inFlight = false;
  private sessionId: string | null = null;
  private processorInterval: ReturnType<typeof setInterval> | null = null;

  constructor(persistence: PersistenceManager) {
    this.persistence = persistence;
  }

  async enqueue(sessionId: string, entry: Omit<TaskQueueEntry, 'id' | 'sessionId' | 'attempts' | 'status'>): Promise<string> {
    const id = `${entry.type}-${crypto.randomUUID()}`;
    const fullEntry: TaskQueueEntry = {
      ...entry,
      id,
      sessionId,
      attempts: 0,
      status: 'pending',
    };

    await this.persistence.saveTask(fullEntry);
    return id;
  }

  async startProcessing(sessionId: string, processor: (entry: TaskQueueEntry) => Promise<void>) {
    if (this.processing && this.sessionId === sessionId) return;
    this.stopProcessing();
    this.processing = true;
    this.sessionId = sessionId;

    // Recover tasks stranded in `running` from a prior service-worker lifetime.
    await this.persistence.requeueStaleRunningTasks(sessionId, Date.now() - 60_000);
    // Expire pending tasks whose deadline has passed so they stop reporting as
    // `pending` forever and can no longer starve the queue (MOMO-071).
    await this.persistence.sweepExpiredPendingTasks(sessionId);

    this.processorInterval = setInterval(async () => {
      const currentSessionId = this.sessionId;
      if (!currentSessionId) return;
      try {
        await this.processNext(currentSessionId, processor);
      } catch (error) {
        console.error('[TaskQueue] Processing error:', error);
      }
    }, 1000);
  }

  async stopProcessing() {
    this.processing = false;
    this.sessionId = null;
    if (this.processorInterval) {
      clearInterval(this.processorInterval);
      this.processorInterval = null;
    }
  }

  private async processNext(sessionId: string, processor: (entry: TaskQueueEntry) => Promise<void>) {
    const entry = await this.persistence.getNextPendingTask(sessionId);
    if (!entry) return;

    entry.attempts += 1;
    await this.persistence.updateTask(entry.id, { status: 'running', attempts: entry.attempts });

    try {
      await processor(entry);
      await this.persistence.updateTask(entry.id, { status: 'done' });
    } catch (error) {
      await this.handleFailure(entry, error);
    }
  }

  private async handleFailure(entry: TaskQueueEntry, error: unknown) {
    const retryPolicy = entry.retryPolicy as RetryPolicy;
    const isRetryable = retryPolicy.retryableErrors.some(e =>
      error instanceof Error && error.message.includes(e)
    );

    if (entry.attempts >= retryPolicy.maxAttempts || !isRetryable) {
      await this.persistence.updateTask(entry.id, {
        status: 'dead',
        // Could store error in payload
      });
    } else {
      const delay = Math.min(
        retryPolicy.baseDelayMs * Math.pow(retryPolicy.backoffMultiplier, entry.attempts),
        retryPolicy.maxDelayMs
      );

      // Re-queue with delay, extending the deadline so the retry isn't
      // immediately re-expired by the sweep or the deadline filter (MOMO-071).
      setTimeout(async () => {
        await this.persistence.updateTask(entry.id, {
          status: 'pending',
          deadline: Date.now() + retryPolicy.maxDelayMs,
        });
      }, delay);
    }
  }

  async getPendingCount(sessionId: string): Promise<number> {
    const tasks = await this.persistence.getTasksByStatus(sessionId, 'pending');
    return tasks.length;
  }

  async getRunningCount(sessionId: string): Promise<number> {
    const tasks = await this.persistence.getTasksByStatus(sessionId, 'running');
    return tasks.length;
  }

  createDefaultRetryPolicy(): RetryPolicy {
    return {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      backoffMultiplier: 2,
      retryableErrors: ['timeout', 'network', 'element_not_found', 'stale_element'],
    };
  }
}