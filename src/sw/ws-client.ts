import { BridgeRequest, BridgeResponse, BridgeEvent, BridgeCommand } from '../sw/orchestrator.js';

type PendingResolver = (resp: BridgeResponse) => void;

/** A request buffered while the socket is down, flushed on reconnect (BUG 2). */
type OutboxEntry = {
  type: string;
  payload: object;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
};

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private pending = new Map<string, PendingResolver>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private messageId = 0;
  private reconnectAttempts = 0;
  private baseReconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private isClosing = false;
  /** Requests buffered while disconnected; flushed on reconnect (BUG 2). */
  private outbox: OutboxEntry[] = [];
  private onEventCallback: (evt: BridgeEvent) => void;
  private onCommandCallback: (cmd: BridgeCommand) => void;

  constructor(onEvent: (evt: BridgeEvent) => void, onCommand?: (cmd: BridgeCommand) => void) {
    this.onEventCallback = onEvent;
    this.onCommandCallback = onCommand ?? (() => {});
  }

  async connect(): Promise<void> {
    this.isClosing = false;
    this.reconnectAttempts = 0;
    return this.tryConnect();
  }

  /**
   * Discover the bridge and open a socket. A failed discovery is not fatal: it
   * schedules a reconnect, so a bridge that isn't up yet (or restarted on a new
   * port) is retried instead of leaving the client permanently disconnected
   * (BUG 2).
   */
  private async tryConnect(): Promise<void> {
    try {
      this.url = await discoverBridgeUrl();
    } catch (e) {
      console.error('[WsClient] Bridge not discoverable:', e);
      this.scheduleReconnect();
      return;
    }
    await this.doConnect();
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          console.log('[WsClient] Connected to', this.url);
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          this.flushOutbox();
          resolve();
        };

        this.ws.onmessage = (event: MessageEvent) => {
          this.handleMessage(event);
        };

        this.ws.onclose = (event: CloseEvent) => {
          console.log('[WsClient] Disconnected:', event.code, event.reason);
          this.stopHeartbeat();
          if (!this.isClosing) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = (error: Event) => {
          console.error('[WsClient] Error:', error);
          // Don't reject here; onclose will fire and handle reconnect
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  private scheduleReconnect(immediate = false) {
    if (this.isClosing) return;
    if (this.reconnectTimer) {
      if (!immediate) return;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const delay = immediate
      ? 0
      : Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    console.log(`[WsClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.tryConnect().catch(() => {
        // tryConnect routes failures to scheduleReconnect (via onclose or a
        // failed discovery), so this catch is only a safety net.
      });
    }, delay);
  }

  /** Send any requests buffered while the socket was down (BUG 2). */
  private flushOutbox() {
    if (this.outbox.length === 0) return;
    const queued = this.outbox;
    this.outbox = [];
    console.log(`[WsClient] Flushing ${queued.length} queued message(s)`);
    for (const entry of queued) {
      this.transmit(entry.type, entry.payload).then(entry.resolve).catch(entry.reject);
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Send application-level ping
        this.sendBinary({ type: 'PING' });
      } else {
        this.stopHeartbeat();
      }
    }, 15000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send an object as a BINARY WebSocket frame. The bridge's read loop only
   * matches `Message::Binary` (a text frame would be silently dropped), so every
   * extension → bridge message must be UTF-8 encoded and sent as bytes.
   */
  private sendBinary(obj: unknown): void {
    this.ws!.send(new TextEncoder().encode(JSON.stringify(obj)));
  }

  private handleMessage(event: MessageEvent) {
    let data: ArrayBuffer | string = event.data;
    if (typeof data === 'string') {
      data = new TextEncoder().encode(data).buffer;
    }

    try {
      const response: BridgeResponse = JSON.parse(new TextDecoder().decode(data));

      // Handle async events (BridgeEvent)
      if (response.type === 'Event') {
        this.onEventCallback({ event: response.payload.event || '', data: response.payload.data });
        return;
      }

      // Handle bridge → extension commands (PHASE9 §6): dispatch to the
      // command handler and expect no request/response correlation here.
      if (response.type === 'Command') {
        this.onCommandCallback({
          request_id: response.payload.request_id || '',
          command: response.payload.command || '',
          params: response.payload.params,
        });
        return;
      }

      // Handle request/response correlation
      const reqId = response.payload.request_id;
      if (reqId && this.pending.has(reqId)) {
        const resolver = this.pending.get(reqId)!;
        this.pending.delete(reqId);

        if (response.type === 'Error') {
          resolver(Promise.reject(new Error(response.payload.message || 'Bridge error')));
        } else if (response.type === 'Ok') {
          resolver(Promise.resolve(response.payload.data));
        } else {
          resolver(Promise.reject(new Error('Unexpected response type')));
        }
        return;
      }

      // Handle PONG (both WebSocket-level and application-level)
      if (response.type === 'Ok' && response.payload.data?.status === 'pong') {
        return;
      }

      console.warn('[WsClient] Unmatched response:', response);
    } catch (e) {
      console.error('[WsClient] Failed to parse message:', e);
    }
  }

  async send<T>(type: string, payload: object): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Buffer the request and reconnect; flushOutbox() sends it once the socket
      // is back up. This replaces the old throw-on-disconnect, which dropped the
      // request the moment the SW woke before the WS reconnected (BUG 2).
      return new Promise<T>((resolve, reject) => {
        this.outbox.push({ type, payload, resolve, reject });
        this.scheduleReconnect(true);
      });
    }

    return this.transmit<T>(type, payload);
  }

  private transmit<T>(type: string, payload: object): Promise<T> {
    const id = `req-${++this.messageId}-${crypto.randomUUID()}`;
    const request = { id, type, payload };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Request timeout'));
      }, 30000);

      this.pending.set(id, (result: Promise<unknown>) => {
        clearTimeout(timeout);
        result.then(resolve).catch(reject);
      });

      this.sendBinary(request);
    });
  }

  /**
   * Fire-and-forget reply to a bridge → extension `Command`. The bridge does
   * not send a response back (CommandResult is intercepted by the connection
   * manager), so no request/response correlation is registered.
   */
  sendCommandResult(requestId: string, result: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[WsClient] Cannot send CommandResult: WebSocket not connected');
      return;
    }
    const message = { type: 'COMMAND_RESULT', payload: { request_id: requestId, result } };
    this.sendBinary(message);
  }

  /**
   * Fire-and-forget application ping (keepalive). Never throws and carries no
   * request/response correlation — the bridge answers with a `status: "pong"`
   * frame that `handleMessage` ignores. Replaces the retired native-messaging
   * keepalive (BUG 5).
   */
  ping(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendBinary({ type: 'PING' });
    } else {
      // The SW just woke (keepalive/watchdog alarm): reconnect immediately so any
      // queued messages flush, rather than waiting out the next backoff tick (BUG 2).
      this.scheduleReconnect(true);
    }
  }

  close() {
    this.isClosing = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pending.forEach((_, id) => this.pending.delete(id));
    // Reject queued messages — the client is shutting down and they will never
    // be sent (BUG 2).
    for (const entry of this.outbox) {
      entry.reject(new Error('WebSocket closed'));
    }
    this.outbox = [];
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

async function discoverBridgeUrl(): Promise<string> {
  // The bridge binds a fixed port in 9090-9100 (bridge/src/main.rs). The MV3
  // service worker has no filesystem access to read ~/.momo/bridge_port and no
  // `process.env`, so discovery is a health-endpoint scan over that range
  // (BUG 1). Scan ascending and stop at the first healthy port.
  for (let port = 9000; port <= 9100; port++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(100),
      });
      if (response.ok) {
        return `ws://127.0.0.1:${port}/ws`;
      }
    } catch {
      // Port not answering; try the next one.
    }
  }

  throw new Error('Could not discover bridge port in 9000-9100');
}

// Singleton getter
let wsClientInstance: WsClient | null = null;

export function getWsClient(onEvent?: (evt: BridgeEvent) => void, onCommand?: (cmd: BridgeCommand) => void): WsClient {
  if (!wsClientInstance) {
    if (!onEvent) throw new Error('WsClient not initialized and no onEvent provided');
    wsClientInstance = new WsClient(onEvent, onCommand);
  }
  return wsClientInstance;
}

export function initWsClient(onEvent: (evt: BridgeEvent) => void, onCommand?: (cmd: BridgeCommand) => void): WsClient {
  wsClientInstance = new WsClient(onEvent, onCommand);
  return wsClientInstance;
}