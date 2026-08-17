import { AgentOrchestrator } from './orchestrator.js';

export class AlarmManager {
  private orchestrator: AgentOrchestrator;
  private keepAliveAlarm = 'agent-keepalive';
  private checkpointAlarm = 'agent-checkpoint';
  private watchdogAlarm = 'agent-watchdog';

  constructor(orchestrator: AgentOrchestrator) {
    this.orchestrator = orchestrator;
  }

  start() {
    void this.createAlarms();
  }

  private async createAlarms() {
    // Keep-alive: fires every minute to prevent SW suspension
    await this.ensureAlarm(this.keepAliveAlarm, { periodInMinutes: 1 });

    // Checkpoint: fires every 5 minutes to persist state
    await this.ensureAlarm(this.checkpointAlarm, { periodInMinutes: 5 });

    // Watchdog: fires every 1 minute to check agent health (minimum per spec)
    await this.ensureAlarm(this.watchdogAlarm, { periodInMinutes: 1 });
  }

  /**
   * Idempotent alarm registration. `chrome.alarms.create` with an existing name
   * resets that alarm's schedule, and the SW re-runs start() on every wake, so
   * unconditionally calling create would continually push the fire times back.
   * Only create an alarm when it is not already scheduled (MOMO-027).
   */
  private async ensureAlarm(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo): Promise<void> {
    const existing = await chrome.alarms.get(name);
    if (!existing) {
      await chrome.alarms.create(name, alarmInfo);
    }
  }

  async handleAlarm(alarm: chrome.alarms.Alarm) {
    // Guard the whole dispatch so a failure in one handler can't reject the
    // onAlarm listener's promise and break the others (MOMO-092).
    try {
      switch (alarm.name) {
        case this.keepAliveAlarm:
          await this.handleKeepAlive();
          break;
        case this.checkpointAlarm:
          await this.handleCheckpoint();
          break;
        case this.watchdogAlarm:
          await this.handleWatchdog();
          break;
      }
    } catch (error) {
      console.error('[AlarmManager] Alarm handler failed:', alarm.name, error);
    }
  }

  private async handleKeepAlive() {
    // The periodic alarm itself is what wakes the service worker in MV3; a
    // storage write does nothing extra to prevent suspension. Just ping the
    // native messaging host to keep it alive (MOMO-090, MOMO-120).
    try {
      await chrome.runtime.sendNativeMessage('agent.bridge', { type: 'PING' });
    } catch {
      // Host might not be running yet, that's OK
    }
  }

  private async handleCheckpoint() {
    if (this.orchestrator.isActive()) {
      await this.orchestrator.persistState();
    }
  }

  private async handleWatchdog() {
    const state = this.orchestrator.getState();
    if (!state) return;

    // Check if task is stuck (no progress for 2 minutes)
    const now = Date.now();
    const lastProgress = state.history.at(-1)?.timestamp
      ?? state.checkpoints.at(-1)?.timestamp
      ?? 0;

    // A freshly started task has no history/checkpoint yet; don't treat it as
    // stuck before it has had a chance to make progress (MOMO-091).
    if (lastProgress !== 0 && now - lastProgress > 120_000 && this.orchestrator.isActive()) {
      console.warn('[Watchdog] Task appears stuck, aborting for recovery');
      // Real recovery action (not just a log): a task with no progress in 2
      // minutes cannot be safely auto-resumed, so abort and mark it errored to
      // require an explicit restart (MOMO-026).
      await this.orchestrator.abortTask('Watchdog: no progress for 2 minutes', true);
      return;
    }

    // Check native messaging host health
    try {
      await chrome.runtime.sendNativeMessage('agent.bridge', { type: 'PING' });
    } catch {
      console.warn('[Watchdog] Native messaging host unreachable');
    }
  }

  async stop() {
    await chrome.alarms.clear(this.keepAliveAlarm);
    await chrome.alarms.clear(this.checkpointAlarm);
    await chrome.alarms.clear(this.watchdogAlarm);
  }
}
