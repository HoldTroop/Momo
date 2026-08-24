import { MessageRouter } from './message-router.js';
import { AgentOrchestrator } from './orchestrator.js';
import { validatePortMessage } from '../lib/message-validator.js';

interface PortConnection {
  port: chrome.runtime.Port;
  tabId?: number;
  type: 'sidepanel' | 'content' | 'devtools' | 'unknown';
  connectedAt: number;
  lastActivity: number;
}

export class PortManager {
  private orchestrator: AgentOrchestrator;
  private messageRouter: MessageRouter;
  private connections: Map<string, PortConnection> = new Map();
  private connectionIdCounter = 0;

  constructor(orchestrator: AgentOrchestrator, messageRouter: MessageRouter) {
    this.orchestrator = orchestrator;
    this.messageRouter = messageRouter;
  }

  handlePort(port: chrome.runtime.Port) {
    // Only self-origin, non-tab extension contexts may open a control port.
    // `port.sender` is undefined for extension pages (side panel);
    // it is populated for content scripts (tab) and for web pages / other
    // extensions. Reject both so privileged messages cannot be routed through an
    // untrusted connection.
    if (port.sender !== undefined) {
      if (port.sender.id !== chrome.runtime.id || port.sender.tab !== undefined) {
        console.warn('[PortManager] Rejected untrusted port:', port.name, port.sender.url || port.sender.id || 'unknown');
        port.disconnect();
        return;
      }
    }

    const connectionId = `conn-${++this.connectionIdCounter}-${Date.now()}`;
    const connection: PortConnection = {
      port,
      tabId: port.sender?.tab?.id,
      type: this.determinePortType(port),
      connectedAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.connections.set(connectionId, connection);

    port.onMessage.addListener((message) => {
      connection.lastActivity = Date.now();
      this.handleMessage(connectionId, message);
    });

    port.onDisconnect.addListener(() => {
      this.handleDisconnect(connectionId);
    });

    // Send welcome message
    port.postMessage({ type: 'CONNECTED', payload: { connectionId } });
  }

  private determinePortType(port: chrome.runtime.Port): PortConnection['type'] {
    if (port.name === 'sidepanel') return 'sidepanel';
    if (port.name === 'content-script') return 'content';
    if (port.name === 'devtools') return 'devtools';
    return 'unknown';
  }

  private async handleMessage(connectionId: string, message: unknown) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    let msg: { type: string; payload?: unknown; requestId?: string };
    try {
      msg = validatePortMessage(message);
    } catch (e) {
      console.warn('[PortManager] Dropped invalid port message', {
        error: e instanceof Error ? e.message : String(e),
        connectionId,
        portType: connection.type,
      });
      return;
    }

    try {
      let response: unknown;

      if (msg.type === 'GET_STATE') {
        response = this.orchestrator.getState();
      } else {
        response = await this.messageRouter.handle(message, connection.port.sender!);
      }

      if (msg.requestId) {
        connection.port.postMessage({ type: 'RESPONSE', requestId: msg.requestId, payload: response });
      } else if (response !== undefined) {
        connection.port.postMessage({ type: 'EVENT', payload: response });
      }
    } catch (error) {
      if (msg.requestId) {
        connection.port.postMessage({
          type: 'RESPONSE',
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private handleDisconnect(connectionId: string) {
    this.connections.delete(connectionId);
  }

  broadcast(message: unknown, filter?: (conn: PortConnection) => boolean) {
    for (const [, connection] of this.connections) {
      if (!filter || filter(connection)) {
        try {
          connection.port.postMessage(message);
        } catch (e) {
          console.error('[Momo System Error]:', e);
          // Port might be closed
        }
      }
    }
  }

  broadcastToType(type: PortConnection['type'], message: unknown) {
    this.broadcast(message, (conn) => conn.type === type);
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getConnectionsByType(type: PortConnection['type']): PortConnection[] {
    return Array.from(this.connections.values()).filter((c) => c.type === type);
  }
}