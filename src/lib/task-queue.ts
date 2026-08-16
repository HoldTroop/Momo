import { PersistenceManager } from './persistence.js';
import { TaskQueueEntry, TaskType, RetryPolicy, TaskStatus } from '../sw/orchestrator.js';

export class TaskQueue {
  private persistence: PersistenceManager;
  private processing = false;
  private processorInterval: number | null = null;

  constructor(persistence: PersistenceManager) {
    this.persistence = persistence;
  }

  async enqueue(entry: Omit<TaskQueueEntry, 'id' | 'attempts' | 'status'>): Promise<string> {
    const id = `${entry.type}-${crypto.randomUUID()}`;
    const fullEntry: TaskQueueEntry = {
      ...entry,
      id,
      attempts: 0,
      status: 'pending',
    };

    await this.persistence.saveTask(fullEntry);
    return id;
  }

  async startProcessing(sessionId: string, processor: (entry: TaskQueueEntry) => Promise<void>) {
    if (this.processing) return;
    this.processing = true;

    this.processorInterval = window.setInterval(async () => {
      try {
        await this.processNext(sessionId, processor);
      } catch (error) {
        console.error('[TaskQueue] Processing error:', error);
      }
    }, 1000);
  }

  async stopProcessing() {
    this.processing = false;
    if (this.processorInterval) {
      clearInterval(this.processorInterval);
      this.processorInterval = null;
    }
  }

  private async processNext(sessionId: string, processor: (entry: TaskQueueEntry) => Promise<void>) {
    const entry = await this.persistence.getNextPendingTask(sessionId);
    if (!entry) return;

    await this.persistence.updateTask(entry.id, { status: 'running', attempts: entry.attempts + 1 });

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

      // Re-queue with delay
      setTimeout(async () => {
        await this.persistence.updateTask(entry.id, { status: 'pending' });
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