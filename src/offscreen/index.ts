interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

class OffscreenAgent {
  private statusEl: HTMLElement;
  private logsEl: HTMLElement;
  private memEl: HTMLElement;
  private uptimeEl: HTMLElement;
  private simEl: HTMLElement;
  private killSwitchEl: HTMLButtonElement;
  private isRunning = false;
  private watchdogInterval: number | null = null;
  private metricsInterval: number | null = null;
  private port: chrome.runtime.Port | null = null;
  private startTime = Date.now();

  constructor() {
    this.statusEl = document.getElementById('status')!;
    this.logsEl = document.getElementById('logs')!;
    this.memEl = document.getElementById('mem-metric')!;
    this.uptimeEl = document.getElementById('uptime-metric')!;
    this.simEl = document.getElementById('sim-metric')!;
    this.killSwitchEl = document.getElementById('kill-switch') as HTMLButtonElement;
    this.init();
  }

  private async init() {
    this.log('info', 'Offscreen document starting...');

    // Connect to service worker
    const connection = chrome.runtime.connect({ name: 'offscreen' });
    this.port = connection;

    connection.onMessage.addListener((message) => this.handleMessage(message));
    connection.onDisconnect.addListener(() => this.handleDisconnect());

    // Kill switch handler
    this.killSwitchEl.addEventListener('click', () => this.handleKillSwitch());

    // Initialize components.
    // Human input simulation lives in the service worker (chrome.debugger) — the
    // offscreen document no longer owns a SIMULATE_* input path.
    this.simEl.textContent = 'Disabled (chrome.debugger)';
    this.simEl.style.color = '#888';
    this.startWatchdog();
    this.startMetricsLoop();

    this.setStatus('running', 'Offscreen agent running');
    this.log('info', 'Offscreen agent initialized');
  }

  private startWatchdog() {
    this.watchdogInterval = window.setInterval(() => {
      this.performHealthCheck();
    }, 30_000); // Every 30 seconds
  }

  private startMetricsLoop() {
    this.metricsInterval = window.setInterval(() => {
      this.updateMetrics();
    }, 1000); // Update UI every second
  }

  private updateMetrics() {
    // Memory
    if ('memory' in performance) {
      const mem = (performance as any).memory;
      const usedMB = Math.round(mem.usedJSHeapSize / 1024 / 1024);
      this.memEl.textContent = `${usedMB} MB`;
      if (usedMB > 150) this.memEl.style.color = '#f39c12';
      else if (usedMB > 300) this.memEl.style.color = '#e94560';
      else this.memEl.style.color = '#2ecc71';
    }

    // Uptime
    const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    this.uptimeEl.textContent = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  private performHealthCheck() {
    // Check SW connection
    if (!this.port) {
      this.log('warn', 'Health check: No SW connection');
      return;
    }

    // Check memory
    if ('memory' in performance) {
      const mem = (performance as any).memory;
      const usedMB = Math.round(mem.usedJSHeapSize / 1024 / 1024);
      if (usedMB > 150) {
        this.log('warn', `High memory usage: ${usedMB}MB`);
      }
    }

    // Ping bridge
    this.sendToBridge({ type: 'PING' }).catch(() => {
      this.log('warn', 'Bridge unreachable');
    });

    this.log('info', 'Health check OK');
  }

  private handleMessage(message: any) {
    switch (message.type) {
      case 'PERSIST_STATE':
        this.handlePersistState(message.payload);
        break;
      case 'GET_STATUS':
        this.sendToSw({ type: 'STATUS_RESPONSE', payload: this.getStatus() });
        break;
    }
  }

  private handlePersistState(payload: any) {
    // Forward to persistence
    this.sendToSw({ type: 'PERSIST_STATE', payload });
  }

  private handleDisconnect() {
    this.log('warn', 'Disconnected from Service Worker');
    this.port = null;
    // Try to reconnect
    setTimeout(() => this.init(), 5000);
  }

  private handleKillSwitch() {
    this.log('warn', '🛑 KILL SWITCH ACTIVATED - Terminating all offscreen processes');
    this.killSwitchEl.disabled = true;
    this.killSwitchEl.textContent = '🛑 KILLED';
    this.killSwitchEl.style.background = '#666';

    // Simulation lives in the SW (chrome.debugger); nothing to terminate here.
    this.simEl.textContent = 'Disabled';
    this.simEl.style.color = '#888';

    // Clear intervals
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }

    // Close port to SW
    if (this.port) {
      this.port.postMessage({ type: 'OFFSCREEN_KILLED' });
      this.port.onDisconnect.removeListener(() => this.handleDisconnect());
      this.port = null;
    }

    this.setStatus('error', 'Offscreen agent killed');
    this.log('warn', 'All offscreen processes terminated. Refresh to restart.');
  }

  private async sendToBridge(request: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.port) return reject(new Error('No SW connection'));

      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const handler = (msg: any) => {
        if (msg.requestId === requestId) {
          this.port!.onMessage.removeListener(handler);
          resolve(msg.payload);
        }
      };
      this.port.onMessage.addListener(handler);
      this.port.postMessage({ ...request, requestId });

      setTimeout(() => {
        this.port!.onMessage.removeListener(handler);
        reject(new Error('Bridge timeout'));
      }, 30000);
    });
  }

  private sendToSw(message: any) {
    if (this.port) {
      this.port.postMessage(message);
    }
  }

  private getStatus() {
    return {
      running: this.isRunning,
      memory: 'memory' in performance ? Math.round((performance as any).memory.usedJSHeapSize / 1024 / 1024) : 0,
      simulationEngine: false,
      uptime: Date.now() - this.startTime,
    };
  }

  private setStatus(state: 'running' | 'idle' | 'error', message: string) {
    this.statusEl.className = `status ${state}`;
    this.statusEl.textContent = message;
  }

  private log(level: 'info' | 'warn' | 'error', message: string) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    entry.textContent = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    this.logsEl.appendChild(entry);
    this.logsEl.scrollTop = this.logsEl.scrollHeight;

    // Limit log entries
    while (this.logsEl.children.length > 500) {
      this.logsEl.removeChild(this.logsEl.firstChild!);
    }
  }
}

// Note: the offscreen "Human Simulation Engine" was removed and there is no
// internal LLM. Per the design decision, chrome.debugger (in the service worker)
// is the sole input path and the bridge authorizes every SIMULATE_* request.
// The offscreen document now only relays native-messaging requests, runs the
// watchdog/health check, and hosts the kill switch.

// Initialize
const agent = new OffscreenAgent();
(window as any).__offscreenAgent = agent;