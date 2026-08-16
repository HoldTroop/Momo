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
    this.createAlarms();
  }

  private async createAlarms() {
    // Keep-alive: fires every minute to prevent SW suspension
    await chrome.alarms.create(this.keepAliveAlarm, {
      periodInMinutes: 1,
    });

    // Checkpoint: fires every 5 minutes to persist state
    await chrome.alarms.create(this.checkpointAlarm, {
      periodInMinutes: 5,
    });

    // Watchdog: fires every 1 minute to check agent health (minimum per spec)
    await chrome.alarms.create(this.watchdogAlarm, {
      periodInMinutes: 1,
    });
  }

  async handleAlarm(alarm: chrome.alarms.Alarm) {
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
  }

  private async handleKeepAlive() {
    // Touch storage to reset idle timer
    await chrome.storage.local.get('keepalive');
    await chrome.storage.local.set({ keepalive: Date.now() });

    // Also ping the native messaging host to keep it alive
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
    const lastProgress = state.history.length > 0
      ? state.history[state.history.length - 1].timestamp
      : state.checkpoints.length > 0
        ? state.checkpoints[state.checkpoints.length - 1].timestamp
        : 0;

    if (now - lastProgress > 120_000 && this.orchestrator.isActive()) {
      console.warn('[Watchdog] Task appears stuck, attempting recovery');
      // Could trigger recovery logic here
    }

    // Check native messaging host health
    try {
      await chrome.runtime.sendNativeMessage('agent.bridge', { type: 'PING' });
    } catch {
      console.warn('[Watchdog] Native messaging host unreachable');
      // Could attempt restart
    }
  }

  async stop() {
    await chrome.alarms.clear(this.keepAliveAlarm);
    await chrome.alarms.clear(this.checkpointAlarm);
    await chrome.alarms.clear(this.watchdogAlarm);
  }
}