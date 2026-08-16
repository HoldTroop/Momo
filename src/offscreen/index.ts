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
  private llmEl: HTMLElement;
  private simEl: HTMLElement;
  private killSwitchEl: HTMLButtonElement;
  private isRunning = false;
  private llmWorker: Worker | null = null;
  private watchdogInterval: number | null = null;
  private metricsInterval: number | null = null;
  private simulationEngine: HumanSimulationEngine | null = null;
  private port: MessagePort | null = null;
  private startTime = Date.now();

  constructor() {
    this.statusEl = document.getElementById('status')!;
    this.logsEl = document.getElementById('logs')!;
    this.memEl = document.getElementById('mem-metric')!;
    this.uptimeEl = document.getElementById('uptime-metric')!;
    this.llmEl = document.getElementById('llm-metric')!;
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

    // Initialize components
    await this.initLlmWorker();
    await this.initSimulationEngine();
    this.startWatchdog();
    this.startMetricsLoop();

    this.setStatus('running', 'Offscreen agent running');
    this.log('info', 'Offscreen agent initialized');
  }

  private async initLlmWorker() {
    try {
      // Create a web worker for local LLM inference (WebLLM)
      // For now, we'll use a simple worker that proxies to the bridge
      this.llmWorker = new Worker(new URL('./llm-worker.ts', import.meta.url), { type: 'module' });
      this.llmWorker.onmessage = (e) => this.handleWorkerMessage(e.data);
      this.llmWorker.onerror = (e) => this.log('error', `LLM Worker error: ${e.message}`);
      this.log('info', 'LLM Worker initialized');
      this.llmEl.textContent = 'Running';
      this.llmEl.style.color = '#2ecc71';
    } catch (e) {
      this.log('warn', `LLM Worker not available: ${e}`);
      this.llmEl.textContent = 'Unavailable';
      this.llmEl.style.color = '#f39c12';
    }
  }

  private async initSimulationEngine() {
    this.simulationEngine = new HumanSimulationEngine();
    this.log('info', 'Human Simulation Engine initialized');
    this.simEl.textContent = 'Running';
    this.simEl.style.color = '#2ecc71';
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
      case 'LLM_REQUEST':
        this.handleLlmRequest(message.payload);
        break;
      case 'SIMULATE_ACTION':
        this.handleSimulation(message.payload);
        break;
      case 'PERSIST_STATE':
        this.handlePersistState(message.payload);
        break;
      case 'GET_STATUS':
        this.sendToSw({ type: 'STATUS_RESPONSE', payload: this.getStatus() });
        break;
    }
  }

  private async handleLlmRequest(payload: any) {
    this.log('info', `LLM request: ${payload.model}`);

    if (this.llmWorker) {
      this.llmWorker.postMessage({ type: 'COMPLETE', payload });
    } else {
      // Fallback: proxy to bridge
      try {
        const result = await this.sendToBridge({ type: 'LLM_COMPLETE', payload });
        this.sendToSw({ type: 'LLM_RESPONSE', payload: result, requestId: payload.requestId });
      } catch (e) {
        this.sendToSw({ type: 'LLM_RESPONSE', payload: { error: String(e) }, requestId: payload.requestId });
      }
    }
  }

  private async handleSimulation(payload: any) {
    if (!this.simulationEngine) {
      this.log('error', 'Simulation engine not initialized');
      return;
    }

    try {
      switch (payload.action) {
        case 'click':
          await this.simulationEngine.click(payload.x, payload.y, payload.profile);
          break;
        case 'type':
          await this.simulationEngine.typeText(payload.text, payload.profile);
          break;
        case 'scroll':
          await this.simulationEngine.scroll(payload.x, payload.y, payload.deltaX, payload.deltaY, payload.profile);
          break;
        case 'mouseMove':
          await this.simulationEngine.mouseMove(payload.fromX, payload.fromY, payload.toX, payload.toY, payload.profile);
          break;
      }
      this.sendToSw({ type: 'SIMULATION_COMPLETE', payload: { success: true }, requestId: payload.requestId });
    } catch (e) {
      this.sendToSw({ type: 'SIMULATION_COMPLETE', payload: { success: false, error: String(e) }, requestId: payload.requestId });
    }
  }

  private handlePersistState(payload: any) {
    // Forward to persistence
    this.sendToSw({ type: 'PERSIST_STATE', payload });
  }

  private handleWorkerMessage(data: any) {
    if (data.type === 'LLM_CHUNK') {
      this.sendToSw({ type: 'LLM_STREAM_CHUNK', payload: data.chunk, requestId: data.requestId });
    } else if (data.type === 'LLM_COMPLETE') {
      this.sendToSw({ type: 'LLM_RESPONSE', payload: data.result, requestId: data.requestId });
    }
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

    // Terminate LLM worker
    if (this.llmWorker) {
      this.llmWorker.terminate();
      this.llmWorker = null;
      this.llmEl.textContent = 'Terminated';
      this.llmEl.style.color = '#e94560';
      this.log('info', 'LLM Worker terminated');
    }

    // Stop simulation engine
    this.simulationEngine = null;
    this.simEl.textContent = 'Terminated';
    this.simEl.style.color = '#e94560';
    this.log('info', 'Simulation Engine terminated');

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
      llmWorker: !!this.llmWorker,
      simulationEngine: !!this.simulationEngine,
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

// Human Simulation Engine (simplified version for offscreen)
class HumanSimulationEngine {
  async click(x: number, y: number, profile: any) {
    // Send to bridge for CDP-based simulation
    await chrome.runtime.sendNativeMessage('agent.bridge', {
      type: 'SIMULATE_CLICK',
      payload: { x, y, profile },
    });
  }

  async typeText(text: string, profile: any) {
    await chrome.runtime.sendNativeMessage('agent.bridge', {
      type: 'SIMULATE_TYPE',
      payload: { text, profile },
    });
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number, profile: any) {
    await chrome.runtime.sendNativeMessage('agent.bridge', {
      type: 'SIMULATE_SCROLL',
      payload: { x, y, deltaX, deltaY, profile },
    });
  }

  async mouseMove(fromX: number, fromY: number, toX: number, toY: number, profile: any) {
    await chrome.runtime.sendNativeMessage('agent.bridge', {
      type: 'SIMULATE_MOUSE_MOVE',
      payload: { fromX, fromY, toX, toY, profile },
    });
  }
}

// Initialize
const agent = new OffscreenAgent();
(window as any).__offscreenAgent = agent;