// CDP attachment/detachment and tab-tracking for the orchestrator. The
// orchestrator owns a single mutable CdpBindings object (the cached session id,
// the tab it is bound to, and the tab being driven); these functions mutate that
// object so the orchestrator can delegate to them while keeping its public
// method surface. Extracted from the former god file.
import { cdpAdapter } from './cdp-adapter.js';
import { ensureDebuggerPermission, ensureHostPermission } from '../lib/permissions.js';
import type { AgentState } from './orchestrator.js';

/** Mutable CDP/dom-driving bindings owned by the AgentOrchestrator. */
export interface CdpBindings {
  sessionId: string | null;
  sessionTabId: number | null;
  drivingTabId: number | null;
}

export function createCdpBindings(): CdpBindings {
  return { sessionId: null, sessionTabId: null, drivingTabId: null };
}

export async function getActiveTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

/** Attach (once) to the active tab via chrome.debugger. */
export async function attachCdpToActiveTab(bindings: CdpBindings): Promise<string | null> {
  try {
    if (!(await ensureDebuggerPermission())) {
      console.warn('[Orchestrator] debugger permission not granted; CDP disabled');
      return null;
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    if (!activeTab?.url) {
      if (import.meta.env.DEV) {
        console.log('[Orchestrator] No active tab');
      }
      return null;
    }
    bindings.drivingTabId = activeTab.id ?? null;

    // Attach the debugger target that matches the *active* tab, preferring
    // the tabId binding (H12) and falling back to URL matching.
    const targets = await cdpAdapter.getTargets();
    const target = targets.find(t => t.type === 'page' && activeTab.id !== undefined && t.tabId === activeTab.id)
      ?? targets.find(t => t.type === 'page' && t.url === activeTab.url);
    if (!target) {
      if (import.meta.env.DEV) {
        console.log('[Orchestrator] No CDP target for active tab:', activeTab.url);
      }
      return null;
    }

    const sessionId = await cdpAdapter.attach(target.targetId);
    bindings.sessionTabId = activeTab.id ?? null;

    // Notify content script of CDP attachment
    if (activeTab.id && (await ensureHostPermission(activeTab.url))) {
      chrome.tabs.sendMessage(activeTab.id, {
        type: 'CDP_ATTACHED',
        payload: { sessionId }
      });
    }

    return sessionId;
  } catch (e) {
    console.error('[Orchestrator] CDP attach failed:', e);
    return null;
  }
}

export async function detachCdp(bindings: CdpBindings, sessionId: string): Promise<void> {
  await cdpAdapter.detach(sessionId);

  // Invalidate the cached session id so a subsequent getOrCreateCdpSession
  // re-attaches instead of reusing a stale session.
  if (bindings.sessionId === sessionId) {
    bindings.sessionId = null;
    bindings.sessionTabId = null;
  }

  // Notify content script
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id && (await ensureHostPermission(tabs[0].url))) {
    chrome.tabs.sendMessage(tabs[0].id!, { type: 'CDP_DETACHED' });
  }
}

/** Detach any active CDP session, tolerating failure (e.g. already detached). */
export async function detachCdpIfAttached(bindings: CdpBindings): Promise<void> {
  const sessionId = bindings.sessionId;
  if (!sessionId) return;
  bindings.sessionId = null;
  bindings.sessionTabId = null;
  try {
    await detachCdp(bindings, sessionId);
  } catch (e) {
    console.error('[Orchestrator] CDP detach failed:', e);
  }
}

export function getCdpSessionTabId(bindings: CdpBindings): number | null {
  return bindings.sessionTabId;
}

export function handleTabUpdate(bindings: CdpBindings, state: AgentState | null, tabId: number, tab: chrome.tabs.Tab): void {
  if (tab.url && state) {
    // Only count navigation of the tab the agent is driving, so background
    // tab loads don't falsely invalidate an in-flight human confirmation.
    if (tabId === bindings.drivingTabId) {
      state.pageRevision++;
      // Navigation may invalidate the CDP target id — drop the cached session
      // so the next use re-attaches to the current target.
      if (bindings.sessionId) {
        const sid = bindings.sessionId;
        bindings.sessionId = null;
        void detachCdp(bindings, sid).catch(e => {
          console.error('[Orchestrator] CDP detach after navigation failed:', e);
        });
      }
    }
  }
}

/** H13: The user switched to a different tab — drop the CDP session bound to
 *  the previously driven tab so the next use re-attaches to the new one. */
export function handleTabActivated(bindings: CdpBindings): void {
  if (bindings.sessionId) {
    const sid = bindings.sessionId;
    bindings.sessionId = null;
    bindings.sessionTabId = null;
    bindings.drivingTabId = null;
    void detachCdp(bindings, sid).catch(e => console.error('[Orchestrator] CDP detach on tab switch failed:', e));
  }
}

/** H13: The driven (or CDP-bound) tab was closed — clear the bindings and
 *  detach so nothing reuses a stale session. */
export function handleTabRemoved(bindings: CdpBindings, tabId: number): void {
  if (tabId === bindings.drivingTabId || (bindings.sessionTabId !== null && tabId === bindings.sessionTabId)) {
    bindings.drivingTabId = null;
    if (bindings.sessionId) {
      const sid = bindings.sessionId;
      bindings.sessionId = null;
      bindings.sessionTabId = null;
      void detachCdp(bindings, sid).catch((err) => console.warn('[Momo] Handled error:', err));
    }
  }
}
