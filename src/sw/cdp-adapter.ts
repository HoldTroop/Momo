// CDP Adapter using chrome.debugger API
// Per Architecture Blueprint Section 3.3: CDP accessed via chrome.debugger in extension
// Not raw remote-debugging port

declare const chrome: {
  debugger: {
    getTargets: (callback: (targets: chrome.debugger.TargetInfo[]) => void) => void;
    attach: (target: { targetId: string }, version: string, callback: () => void) => void;
    detach: (target: { targetId: string }, callback: () => void) => void;
    sendCommand: (target: { targetId: string }, method: string, params?: any, callback?: (result: any) => void) => void;
    onEvent: {
      addListener: (callback: (source: chrome.debugger.Debuggee, method: string, params: any) => void) => void;
      removeListener: (callback: (source: chrome.debugger.Debuggee, method: string, params: any) => void) => void;
    };
    onDetach: {
      addListener: (callback: (source: chrome.debugger.Debuggee, reason: string) => void) => void;
      removeListener: (callback: (source: chrome.debugger.Debuggee, reason: string) => void) => void;
    };
  };
  runtime: {
    lastError?: { message: string };
  };
};

declare namespace chrome.debugger {
  interface TargetInfo {
    id: string;
    title?: string;
    url?: string;
    type?: string;
    tabId?: number;
    attached?: boolean;
  }
  interface Debuggee {
    targetId: string;
    tabId?: number;
  }
}

export interface CdpTarget {
  targetId: string;
  title: string;
  url: string;
  type: string;
  tabId?: number;
  attached: boolean;
}

export interface CdpSession {
  sessionId: string;
  targetId: string;
  onEvent: (method: string, params: any) => void;
  onDetach: (reason: string) => void;
  /** Internal handler refs so detach() can remove the listeners added in attach(). */
  _eventListener?: (source: chrome.debugger.Debuggee, method: string, params: any) => void;
  _detachListener?: (source: chrome.debugger.Debuggee, reason: string) => void;
}

class CdpAdapter {
  private sessions: Map<string, CdpSession> = new Map();
  private targetListeners: Map<string, (targetInfo: chrome.debugger.TargetInfo) => void> = new Map();
  private eventListeners: Map<string /*sessionId*/, Map<string /*method*/, Set<(method: string, params: any) => void>>> = new Map();
  private sessionDetachedCallbacks: Set<(sessionId: string) => void> = new Set();

  async getTargets(): Promise<CdpTarget[]> {
    return new Promise((resolve, reject) => {
      chrome.debugger.getTargets((targets) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const result: CdpTarget[] = (targets || []).map(t => ({
          targetId: t.id,
          title: t.title || '',
          url: t.url || '',
          type: t.type || '',
          tabId: t.tabId,
          attached: t.attached || false,
        }));
        resolve(result);
      });
    });
  }

  async attach(targetId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sessionId = `cdp-${crypto.randomUUID()}`;

      chrome.debugger.attach({ targetId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        const session: CdpSession = {
          sessionId,
          targetId,
          onEvent: (method, params) => {
            this.eventListeners.get(sessionId)?.get(method)?.forEach(cb => cb(method, params));
          },
          onDetach: (reason) => {
            // Remove the per-session listeners so they don't leak (or double-fire
            // after a later re-attach of the same target), then drop the session.
            this.removeSessionListeners(session);
            this.sessions.delete(sessionId);
            this.sessionDetachedCallbacks.forEach(cb => cb(sessionId));
            console.log('[CDP Adapter] Session detached:', sessionId, reason);
          },
        };

        this.sessions.set(sessionId, session);

        // Set up event listeners for this target, keeping refs so they can be removed.
        session._eventListener = (source, method, params) => {
          if (source.targetId === targetId) {
            session.onEvent(method, params);
          }
        };
        session._detachListener = (source, reason) => {
          if (source.targetId === targetId) {
            session.onDetach(reason);
          }
        };

        chrome.debugger.onEvent.addListener(session._eventListener);
        chrome.debugger.onDetach.addListener(session._detachListener);

        console.log('[CDP Adapter] Attached to target:', targetId, 'session:', sessionId);
        resolve(sessionId);
      });
    });
  }

  async detach(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    return new Promise((resolve, reject) => {
      chrome.debugger.detach({ targetId: session.targetId }, () => {
        if (chrome.runtime.lastError) {
          // Keep the session entry and listeners on failure so a later retry can
          // still find and clean up the session.
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        this.removeSessionListeners(session);
        this.sessions.delete(sessionId);
        resolve();
      });
    });
  }

  /** Subscribe to session detach events (external or internal) to invalidate caches. */
  onSessionDetached(callback: (sessionId: string) => void): () => void {
    this.sessionDetachedCallbacks.add(callback);
    return () => this.sessionDetachedCallbacks.delete(callback);
  }

  /** Remove the per-session onEvent/onDetach listeners so they don't accumulate. */
  private removeSessionListeners(session: CdpSession): void {
    if (session._eventListener) {
      chrome.debugger.onEvent.removeListener(session._eventListener);
    }
    if (session._detachListener) {
      chrome.debugger.onDetach.removeListener(session._detachListener);
    }
    this.eventListeners.delete(session.sessionId);
  }

  async sendCommand<T = any>(sessionId: string, domain: string, command: string, params: any = {}): Promise<T> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(
        { targetId: session.targetId },
        `${domain}.${command}`,
        params,
        (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result as T);
          }
        }
      );
    });
  }

  onEvent(sessionId: string, method: string, callback: (method: string, params: any) => void): () => void {
    let methodMap = this.eventListeners.get(sessionId);
    if (!methodMap) {
      methodMap = new Map();
      this.eventListeners.set(sessionId, methodMap);
    }
    let callbacks = methodMap.get(method);
    if (!callbacks) {
      callbacks = new Set();
      methodMap.set(method, callbacks);
    }
    callbacks.add(callback);

    return () => {
      const current = this.eventListeners.get(sessionId)?.get(method);
      if (!current) return;
      current.delete(callback);
      if (current.size === 0) {
        this.eventListeners.get(sessionId)?.delete(method);
      }
      if (this.eventListeners.get(sessionId)?.size === 0) {
        this.eventListeners.delete(sessionId);
      }
    };
  }

  async getAxTree(sessionId: string): Promise<any> {
    return this.sendCommand(sessionId, 'Accessibility', 'getFullAXTree', {});
  }

  async getDocument(sessionId: string): Promise<any> {
    return this.sendCommand(sessionId, 'DOM', 'getDocument', { depth: -1, pierce: true });
  }

  async querySelector(sessionId: string, nodeId: number, selector: string): Promise<any> {
    return this.sendCommand(sessionId, 'DOM', 'querySelector', { nodeId, selector });
  }

  async getBoxModel(sessionId: string, nodeId: number): Promise<any> {
    return this.sendCommand(sessionId, 'DOM', 'getBoxModel', { nodeId });
  }

  async getContentQuads(sessionId: string, nodeId: number): Promise<any> {
    return this.sendCommand(sessionId, 'DOM', 'getContentQuads', { nodeId });
  }

  async getNodeForLocation(sessionId: string, x: number, y: number): Promise<any> {
    return this.sendCommand(sessionId, 'DOM', 'getNodeForLocation', { x, y, includeUserAgentShadowDOM: true });
  }

  async executeScript(sessionId: string, script: string): Promise<any> {
    // For script execution, use Runtime domain
    return this.sendCommand(sessionId, 'Runtime', 'evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
    });
  }

  async setInputFiles(sessionId: string, nodeId: number, files: string[]): Promise<any> {
    return this.sendCommand(sessionId, 'DOM', 'setFileInputFiles', { nodeId, files });
  }

  async focus(sessionId: string, nodeId: number): Promise<any> {
    return this.sendCommand(sessionId, 'DOM', 'focus', { nodeId });
  }

  async scrollIntoView(sessionId: string, nodeId: number): Promise<any> {
    return this.sendCommand(sessionId, 'DOM', 'scrollIntoView', { nodeId });
  }

  async getOuterHTML(sessionId: string, nodeId: number): Promise<any> {
    return this.sendCommand(sessionId, 'DOM', 'getOuterHTML', { nodeId });
  }

  async dispatchMouseEvent(
    sessionId: string,
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle' = 'left',
    clickCount = 1,
  ): Promise<any> {
    return this.sendCommand(sessionId, 'Input', 'dispatchMouseEvent', { type, x, y, button, clickCount });
  }

  async insertText(sessionId: string, text: string): Promise<any> {
    return this.sendCommand(sessionId, 'Input', 'insertText', { text });
  }

  async dispatchKeyEvent(sessionId: string, key: string, type: 'keyDown' | 'keyUp'): Promise<any> {
    return this.sendCommand(sessionId, 'Input', 'dispatchKeyEvent', { type, key });
  }

  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
}

export const cdpAdapter = new CdpAdapter();