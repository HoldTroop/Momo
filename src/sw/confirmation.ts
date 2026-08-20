// Human-confirmation channel for the orchestrator. A single pending
// intervention is held on AgentState.pendingHumanIntervention at a time; both
// the tool-confirmation flow (awaitConfirmation) and failure escalation
// (escalateToHuman, which lives on the orchestrator) funnel through
// requestIntervention here. Extracted from the former god file.
import type { AgentState, HumanResponse, ToolCall, ToolResult } from './orchestrator.js';

/** How long to wait for a human confirmation before auto-denying (MOMO-045). */
export const CONFIRMATION_TIMEOUT_MS = 60_000;

/** Simple deterministic hash binding a confirmation to a specific action. */
export function hashAction(action: ToolCall): string {
  const str = JSON.stringify(action);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

export async function getCurrentOrigin(): Promise<string> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tabs[0]?.url;
    if (!url) return 'unknown';
    const origin = new URL(url).origin;
    // `chrome://`, `about:blank`, etc. report origin `'null'` — treat as unknown.
    return origin && origin !== 'null' ? origin : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Resolve (or reject) the pending intervention and clear it from state. */
export function resolveIntervention(state: AgentState | null, decision: 'confirm' | 'deny' | 'takeover'): void {
  const pending = state?.pendingHumanIntervention;
  if (!state || !pending) return;
  if (pending.timerId) clearTimeout(pending.timerId);
  state.pendingHumanIntervention = null;
  pending.resolve(decision);
}

/**
 * Open a human-intervention prompt and await the decision. Both the
 * confirmation flow (awaitConfirmation) and failure escalation (escalateToHuman)
 * use this; a single pending intervention is held at a time.
 */
export function requestIntervention(
  state: AgentState | null,
  stepId: string,
  action: ToolCall,
  payload: Record<string, unknown>,
): Promise<'confirm' | 'deny' | 'takeover'> {
  return new Promise((resolve, reject) => {
    if (!state) {
      reject(new Error('No active state'));
      return;
    }

    const actionHash = hashAction(action);

    // H10: a newer intervention supersedes the older pending one — the old
    // promise can never be resolved by a now-stale panel message.
    const previous = state.pendingHumanIntervention;
    if (previous) {
      if (previous.timerId) clearTimeout(previous.timerId);
      previous.reject(new Error('Superseded by a newer intervention'));
    }

    state.pendingHumanIntervention = {
      resolve,
      reject,
      stepId,
      actionHash,
      pageRevision: state.pageRevision,
    };

    // Auto-deny if the human doesn't respond within the timeout (MOMO-045).
    state.pendingHumanIntervention.timerId = setTimeout(() => {
      if (state.pendingHumanIntervention?.actionHash === actionHash && state.pendingHumanIntervention.stepId === stepId) {
        resolveIntervention(state, 'deny');
      }
    }, CONFIRMATION_TIMEOUT_MS);

    void chrome.runtime.sendMessage({
      type: 'HUMAN_INTERVENTION_REQUIRED',
      payload: {
        stepId,
        actionHash,
        pageRevision: state.pageRevision,
        ...payload,
      },
    }).catch((err) => console.warn('[Momo] Handled error:', err));
  });
}

export function awaitConfirmation(
  state: AgentState | null,
  action: ToolCall,
  stepId: string,
  result: ToolResult,
): Promise<'confirm' | 'deny' | 'takeover'> {
  const confirmationData = result.confirmationData;
  if (!confirmationData) {
    throw new Error('Confirmation requested without confirmation data');
  }

  return requestIntervention(state, stepId, action, {
    origin: confirmationData.origin,
    action: action.name,
    target: confirmationData.target,
    // Use the tool's redacted confirmation payload, not the raw arguments
    // (which may include typed text) — MOMO-041.
    data: confirmationData.data,
    reversible: confirmationData.reversible,
    riskClass: confirmationData.riskClass,
  });
}

export function handleHumanResponse(state: AgentState | null, response: HumanResponse): void {
  if (!state?.pendingHumanIntervention) return;

  const pending = state.pendingHumanIntervention;
  // Bind the response to the exact action that requested confirmation (replay).
  // M6: a mismatched hash is a duplicated/stale panel message — silently
  // ignore it; it must never kill a live confirmation.
  if (response.actionHash !== pending.actionHash) {
    return;
  }
  // The page must not have navigated since the confirmation was shown. Compare
  // the echoed revision against the *current* one, not the captured one.
  if (response.pageRevision !== state.pageRevision) {
    pending.reject(new Error('Stale human response: page changed'));
    state.pendingHumanIntervention = null;
    return;
  }

  resolveIntervention(state, response.action);
}
