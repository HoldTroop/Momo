import { BridgeRequest, BridgeResponse, BridgeEvent } from '../sw/orchestrator.js';

type PendingResolver = (resp: BridgeResponse) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private pending = new Map<string, PendingResolver>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private messageId = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private baseReconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private isClosing = false;
  private onEventCallback: (evt: BridgeEvent) => void;

  constructor(onEvent: (evt: BridgeEvent) => void) {
    this.onEventCallback = onEvent;
  }

  async connect(): Promise<void> {
    this.url = await discoverBridgeUrl();
    this.isClosing = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
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

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WsClient] Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    this.reconnectAttempts++;
    console.log(`[WsClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch(() => {
        // doConnect handles its own errors via onclose
      });
    }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Send application-level ping
        this.ws.send(JSON.stringify({ type: 'PING' }));
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
      throw new Error('WebSocket not connected');
    }

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

      this.ws!.send(JSON.stringify(request));
    });
  }

  close() {
    this.isClosing = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pending.forEach((_, id) => this.pending.delete(id));
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

async function discoverBridgeUrl(): Promise<string> {
  // 1. Try env var (set by bridge at startup)
  if (typeof process !== 'undefined' && process.env.MOMO_BRIDGE_WS_PORT) {
    return `ws://127.0.0.1:${process.env.MOMO_BRIDGE_WS_PORT}/ws`;
  }

  // 2. Try well-known file
  try {
    // In extension context, we can't read files directly.
    // This will be handled by bridge-port.ts which uses chrome.runtime.sendNativeMessage
    // or reads from a known location. For now, fall through to scanning.
  } catch {}

  // 3. Fallback: scan common ports
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
      // Continue scanning
    }
  }

  throw new Error('Could not discover bridge port');
}

// Singleton getter
let wsClientInstance: WsClient | null = null;

export function getWsClient(onEvent?: (evt: BridgeEvent) => void): WsClient {
  if (!wsClientInstance) {
    if (!onEvent) throw new Error('WsClient not initialized and no onEvent provided');
    wsClientInstance = new WsClient(onEvent);
  }
  return wsClientInstance;
}

export function initWsClient(onEvent: (evt: BridgeEvent) => void): WsClient {
  wsClientInstance = new WsClient(onEvent);
  return wsClientInstance;
}