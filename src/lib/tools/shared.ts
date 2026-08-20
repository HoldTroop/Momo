// Shared helpers used across tool executors: bridge authorization, action-result
// reporting, origin parsing, read-only token accounting, and the strict-ref
// resolvers that execute_action reuses. Extracted from the former god file so
// each tool module stays focused on its own policy gate + CDP dispatch.
import { getWsClient } from '../../sw/ws-client.js';
import type { AuthResult, PolicyDecision } from './types.js';

/** Send an authorization request to the bridge via WebSocket and return its policy decision. */
export async function authorizeViaBridge(request: Record<string, unknown>): Promise<AuthResult> {
  try {
    const wsClient = getWsClient();
    const data = await wsClient.send<{ decision?: PolicyDecision; action_hash?: string } | null>('POLICY_CHECK', request);
    return {
      decision: data?.decision ?? null,
      actionHash: data?.action_hash ?? null,
    };
  } catch (e) {
    console.warn('[ToolRegistry] Bridge authorize failed:', e);
    return { decision: null, actionHash: null };
  }
}

/**
 * Report the real execution outcome back to the bridge so the audit entry
 * written at decision time can be corrected from `Pending`/`Escalated` to
 * `Success`/`Failed` (MOMO-056). Best-effort: audit reporting must never block
 * or fail the action itself.
 */
export async function reportActionResult(sessionId: string, actionHash: string | null, success: boolean, error?: string): Promise<void> {
  if (!actionHash) return;
  try {
    const wsClient = getWsClient();
    await wsClient.send('ACTION_RESULT', {
      session_id: sessionId,
      action_hash: actionHash,
      outcome: success ? 'success' : 'failed',
      error: error ?? null,
    });
  } catch (e) {
    console.warn('[ToolRegistry] Report action result failed:', e);
  }
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Local token accounting for the read-only tools (scroll/extract/wait/observe),
 * which are not gated by the bridge. Write actions (navigate/click/type/
 * human_click/human_type) are budgeted exclusively by the Rust PolicyEngine —
 * the single authoritative ledger — which deducts only after an `allowed`
 * decision (MOMO-079/082). Keeping the two ledgers disjoint avoids
 * double-charging any single action.
 */
export function deductTokens(budget: { max: number; used: number }, cost: number): void {
  budget.used += cost;
  if (budget.used > budget.max) {
    throw new Error(`Token budget exceeded: ${budget.used}/${budget.max}`);
  }
}

/**
 * Wait for a tab to finish loading, honoring the requested waitUntil level.
 * Resolves on `status === 'complete'` (plus a short settle for `networkidle`),
 * or after the timeout — never rejects.
 */
export function waitForNavigation(tabId: number, waitUntil: string, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const listener = (tid: number, info: chrome.tabs.TabChangeInfo) => {
      if (tid !== tabId || info.status !== 'complete') return;
      if (waitUntil === 'networkidle') {
        // Give async requests a short grace period after the load event.
        clearTimeout(timer);
        setTimeout(finish, 500);
      } else {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Strict-resolve an el_XX ref to its clickable center (no CSS fallback),
 * computing destructive detection for the resolved element in-page. */
export async function resolveRefStrict(
  tabId: number,
  ref: string,
): Promise<{ status: 'ok'; x: number; y: number; destructive: boolean } | { status: 'stale_reference' }> {
  let probe;
  try {
    probe = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: (r: string) => {
        const base = window.__perceptionResolveByRefStrict?.(r);
        if (!base || base.status !== 'ok') return { status: 'stale_reference', ref: r };
        const el = document.querySelector(`[data-momo-ref="${r}"]`) as HTMLElement | null;
        const DESTRUCTIVE_KEYWORDS = [
          'pay', 'buy', 'purchase', 'checkout', 'order', 'confirm', 'submit',
          'delete', 'remove', 'cancel', 'logout', 'sign out', 'signout',
          'deactivate', 'close account', 'unsubscribe', 'transfer', 'refund',
        ];
        let destructive = false;
        if (el) {
          const tag = el.tagName.toLowerCase();
          const inputType = (el as HTMLInputElement).type || '';
          const buttonType = (el as HTMLButtonElement).type || 'submit';
          const rawText = (el.textContent || (el as HTMLInputElement).value || el.getAttribute('aria-label') || el.getAttribute('value') || '').toLowerCase();
          const isFormSubmitControl =
            (tag === 'input' && (inputType === 'submit' || inputType === 'image')) ||
            (tag === 'button' && buttonType === 'submit' && el.closest('form') !== null);
          destructive = isFormSubmitControl || DESTRUCTIVE_KEYWORDS.some(k => rawText.includes(k));
        }
        return { status: 'ok', x: base.x, y: base.y, destructive };
      },
      args: [ref],
    });
  } catch {
    return { status: 'stale_reference' };
  }
  const res = probe[0]?.result as
    | { status: 'ok'; x: number; y: number; destructive: boolean }
    | { status: 'stale_reference' }
    | undefined;
  if (res && res.status === 'ok') return { status: 'ok', x: res.x, y: res.y, destructive: res.destructive };
  return { status: 'stale_reference' };
}

/** Strict-resolve an el_XX ref to a focusable input and capture its field descriptor. */
export async function focusRefStrict(
  tabId: number,
  ref: string,
): Promise<
  | { status: 'ok'; field: { type: string; autocomplete: string; name: string; id: string } }
  | { status: 'stale_reference' }
> {
  let probe;
  try {
    probe = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: (r: string) => {
        const el = document.querySelector(`[data-momo-ref="${r}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el || !el.isConnected || !el.checkVisibility()) return { status: 'stale_reference', ref: r };
        el.focus();
        return {
          status: 'ok',
          field: { type: el.type || '', autocomplete: el.autocomplete || '', name: el.name || '', id: el.id || '' },
        };
      },
      args: [ref],
    });
  } catch {
    return { status: 'stale_reference' };
  }
  const res = probe[0]?.result as
    | { status: 'ok'; field: { type: string; autocomplete: string; name: string; id: string } }
    | { status: 'stale_reference' }
    | undefined;
  if (res && res.status === 'ok') return { status: 'ok', field: res.field };
  return { status: 'stale_reference' };
}
