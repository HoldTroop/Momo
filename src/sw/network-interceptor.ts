/**
 * Tab-scoped network interception with auto-disable.
 *
 * Design decision: actions-7 from docs/PHASE_2_DECISIONS.md
 * - Scope: only intercept requests from active orchestrator tab
 * - Auto-disable after 60s inactivity or tab switch
 * - Ring buffer of last 100 requests per tab
 * - Cross-tab isolation (Tab A's log never visible to Tab B)
 */

export interface NetworkRequest {
  request_id: string;
  method: string;
  url: string;
  timestamp: number;
  headers?: Record<string, string>;
  initiator?: string;
}

export interface NetworkResponse {
  request_id: string;
  status_code: number;
  timestamp: number;
  headers?: Record<string, string>;
}

export interface NetworkLog {
  request: NetworkRequest;
  response?: NetworkResponse;
}

const MAX_REQUESTS_PER_TAB = 100;
const INACTIVITY_TIMEOUT_MS = 60_000;

export class NetworkInterceptor {
  private tabLogs: Map<number, NetworkLog[]> = new Map();
  private activeTab: number | null = null;
  private lastActivity: number = 0;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private listener: ((details: chrome.webRequest.WebRequestDetails) => void) | null = null;

  /**
   * Enable interception for a specific tab.
   * Automatically disables after 60s of inactivity.
   */
  enable(tabId: number): void {
    if (this.activeTab !== null && this.activeTab !== tabId) {
      this.disable();
    }

    this.activeTab = tabId;
    this.lastActivity = Date.now();
    this.resetTimeout();

    if (!this.listener) {
      this.listener = (details) => this.handleRequest(details);
      chrome.webRequest.onBeforeRequest.addListener(
        this.listener,
        { urls: ['<all_urls>'], tabId },
        ['requestBody']
      );
    }
  }

  /**
   * Disable interception and clear listeners.
   */
  disable(): void {
    if (this.listener) {
      chrome.webRequest.onBeforeRequest.removeListener(this.listener);
      this.listener = null;
    }
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.activeTab = null;
  }

  /**
   * Get network log for a specific tab.
   */
  getLog(tabId: number): NetworkLog[] {
    return this.tabLogs.get(tabId) ?? [];
  }

  /**
   * Clear log for a specific tab (called on navigation).
   */
  clearTab(tabId: number): void {
    this.tabLogs.delete(tabId);
  }

  /**
   * Clear all logs.
   */
  clearAll(): void {
    this.tabLogs.clear();
  }

  private handleRequest(details: chrome.webRequest.WebRequestDetails): void {
    if (this.activeTab === null || details.tabId !== this.activeTab) {
      return;
    }

    this.lastActivity = Date.now();
    this.resetTimeout();

    const log = this.getOrCreateLog(details.tabId);
    const request: NetworkRequest = {
      request_id: details.requestId,
      method: details.method,
      url: details.url,
      timestamp: details.timeStamp,
      initiator: details.initiator,
    };

    log.push({ request });

    // Ring buffer: keep only last MAX_REQUESTS_PER_TAB
    if (log.length > MAX_REQUESTS_PER_TAB) {
      log.shift();
    }
  }

  private getOrCreateLog(tabId: number): NetworkLog[] {
    if (!this.tabLogs.has(tabId)) {
      this.tabLogs.set(tabId, []);
    }
    return this.tabLogs.get(tabId)!;
  }

  private resetTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
    }
    this.timeoutHandle = setTimeout(() => {
      this.disable();
    }, INACTIVITY_TIMEOUT_MS);
  }
}

// Singleton instance
export const networkInterceptor = new NetworkInterceptor();
