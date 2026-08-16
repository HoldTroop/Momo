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
    targetId: string;
    title?: string;
    url?: string;
    type?: string;
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
  attached: boolean;
}

export interface CdpSession {
  sessionId: string;
  targetId: string;
  onEvent: (method: string, params: any) => void;
  onDetach: (reason: string) => void;
}

class CdpAdapter {
  private sessions: Map<string, CdpSession> = new Map();
  private nextSessionId = 1;
  private targetListeners: Map<string, (targetInfo: chrome.debugger.TargetInfo) => void> = new Map();
  private eventListeners: Map<string, Set<(method: string, params: any) => void>> = new Map();

  async getTargets(): Promise<CdpTarget[]> {
    return new Promise((resolve) => {
      chrome.debugger.getTargets((targets) => {
        const result: CdpTarget[] = targets.map(t => ({
          targetId: t.targetId,
          title: t.title || '',
          url: t.url || '',
          type: t.type || '',
          attached: t.attached || false,
        }));
        resolve(result);
      });
    });
  }

  async attach(targetId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sessionId = `cdp-${this.nextSessionId++}`;

      chrome.debugger.attach({ targetId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        const session: CdpSession = {
          sessionId,
          targetId,
          onEvent: (method, params) => {
            const listeners = this.eventListeners.get(method);
            if (listeners) {
              listeners.forEach(cb => cb(method, params));
            }
          },
          onDetach: (reason) => {
            this.sessions.delete(sessionId);
            console.log('[CDP Adapter] Session detached:', sessionId, reason);
          },
        };

        this.sessions.set(sessionId, session);

        // Set up event listener for this target
        chrome.debugger.onEvent.addListener((source, method, params) => {
          if (source.targetId === targetId) {
            session.onEvent(method, params);
          }
        });

        chrome.debugger.onDetach.addListener((source) => {
          if (source.targetId === targetId) {
            session.onDetach('detached');
          }
        });

        console.log('[CDP Adapter] Attached to target:', targetId, 'session:', sessionId);
        resolve(sessionId);
      });
    });
  }

  async detach(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    return new Promise((resolve) => {
      chrome.debugger.detach({ targetId: session.targetId }, () => {
        this.sessions.delete(sessionId);
        resolve();
      });
    });
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

  onEvent(method: string, callback: (method: string, params: any) => void): () => void {
    if (!this.eventListeners.has(method)) {
      this.eventListeners.set(method, new Set());
    }
    this.eventListeners.get(method)!.add(callback);

    return () => {
      this.eventListeners.get(method)?.delete(callback);
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

  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
}

export const cdpAdapter = new CdpAdapter();