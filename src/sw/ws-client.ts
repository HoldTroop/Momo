import { BridgeRequest, BridgeResponse, BridgeEvent, BridgeCommand } from '../sw/orchestrator.js';
import { discoverBridgeUrl } from './bridge-port.js';

type PendingResolver = (result: Promise<unknown>) => void;

/** A request buffered while the socket is down, flushed on reconnect (BUG 2). */
type OutboxEntry = {
  type: string;
  payload: object;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
};

export class WsClient {
  private ws: WebSocket | null = null;
  private url = '';
  private pending = new Map<string, PendingResolver>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private messageId = 0;
  private reconnectAttempts = 0;
  private baseReconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private isClosing = false;
  private authenticated = false;
  private authFailed = false;
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
    this.authenticated = false;
    this.authFailed = false;
    return this.tryConnect();
  }

  /**
   * Discover the bridge and open a socket. A failed discovery is not fatal: it
   * schedules a reconnect, so a bridge that isn't up yet (or restarted on a new
   * port) is retried instead of leaving the client permanently disconnected
   * (BUG 2).
   */
  private async tryConnect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
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
        const ws = new WebSocket(this.url);
        this.ws = ws;
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          if (import.meta.env.DEV) {
            console.log('[WsClient] Connected to', this.url);
          }
          resolve();
          void this.performAuth();
        };

        ws.onmessage = (event: MessageEvent) => {
          this.handleMessage(event);
        };

        ws.onclose = (event: CloseEvent) => {
          if (this.ws !== ws) return;
          if (import.meta.env.DEV) {
            console.log('[WsClient] Disconnected:', event.code, event.reason);
          }
          this.stopHeartbeat();
          for (const [id, resolver] of this.pending) {
            resolver(Promise.reject(new Error('WebSocket disconnected')));
          }
          this.pending.clear();
          if (!this.isClosing) {
            this.scheduleReconnect();
          }
        };

        ws.onerror = (error: Event) => {
          console.error('[WsClient] Error:', error);
          // Don't reject here; onclose will fire and handle reconnect
        };
      } catch (e) {
        reject(e);
        this.scheduleReconnect();
      }
    });
  }

  private async performAuth(): Promise<void> {
    if (this.isClosing) return;
    let token: string | undefined;
    try {
      const stored = await chrome.storage.local.get('bridgeToken');
      token = stored?.bridgeToken as string | undefined;
    } catch (e) { console.error('[WsClient] Failed to read bridge token:', e); }
    if (!token) { console.warn('[WsClient] No bridge token configured (set it in the side panel)'); return; }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.sendBinary({ type: 'AUTH', payload: { token } });
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
    if (import.meta.env.DEV) {
      console.log(`[WsClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.tryConnect().catch((err) => console.warn('[Momo] Handled error:', err));
    }, delay);
  }

  /** Send any requests buffered while the socket was down (BUG 2). */
  private flushOutbox() {
    if (this.outbox.length === 0) return;
    const queued = this.outbox;
    this.outbox = [];
    if (import.meta.env.DEV) {
      console.log(`[WsClient] Flushing ${queued.length} queued message(s)`);
    }
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

      if (response.type === 'StreamChunk') {
        this.onEventCallback({ event: 'llm_stream_chunk', data: response.payload });
        return;
      }
      if (response.type === 'StreamEnd') {
        this.onEventCallback({ event: 'llm_stream_end', data: response.payload });
        return;
      }

      if (response.type === 'Ok' && (response.payload.data as { status?: string } | undefined)?.status === 'auth_ok') {
        this.authenticated = true;
        this.startHeartbeat();
        this.flushOutbox();
        return;
      }

      if (response.type === 'Error' && response.payload.request_id === 'auth') {
        this.authFailed = true;
        console.error('[WsClient] Bridge authentication failed:', response.payload.message);
        this.ws?.close();
        return;
      }

      if (response.type === 'Ok' && (response.payload.data as { status?: string } | undefined)?.status === 'ping') {
        if (this.authenticated) {
          this.sendBinary({ type: 'PING' });
        }
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
      if (response.type === 'Ok' && (response.payload.data as { status?: string } | undefined)?.status === 'pong') {
        return;
      }

      console.warn('[WsClient] Unmatched response:', response);
    } catch (e) {
      console.error('[WsClient] Failed to parse message:', e);
    }
  }

  async send<T>(type: string, payload: object): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      // Buffer the request and reconnect; flushOutbox() sends it once the socket
      // is back up. This replaces the old throw-on-disconnect, which dropped the
      // request the moment the SW woke before the WS reconnected (BUG 2).
      return new Promise<T>((resolve, reject) => {
        this.outbox.push({ type, payload, resolve, reject });
        if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
          this.scheduleReconnect(true);
        }
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
        result.then((value) => resolve(value as T)).catch(reject);
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated) {
      this.sendBinary({ type: 'PING' });
    } else if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      // The SW just woke (keepalive/watchdog alarm): reconnect immediately so any
      // queued messages flush, rather than waiting out the next backoff tick (BUG 2).
      this.scheduleReconnect(true);
    }
  }

  close() {
    this.isClosing = true;
    this.authenticated = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [id, resolver] of this.pending) {
      resolver(Promise.reject(new Error('WebSocket closed')));
    }
    this.pending.clear();
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