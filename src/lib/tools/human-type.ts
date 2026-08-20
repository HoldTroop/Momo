import { cdpAdapter } from '../../sw/cdp-adapter.js';
import { isSensitiveInput } from '../redaction.js';
import type { PolicyDecision, ToolDefinition } from './types.js';
import { authorizeViaBridge, originOf, reportActionResult } from './shared.js';

// Human type - write operation via bridge (trusted events)
export const humanTypeTool: ToolDefinition = {
  name: 'human_type',
  description: 'Perform human-like typing via CDP Input API (supports ref_id for targeting)',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      ref_id: { type: 'string', description: 'Stable ref_id from perception for targeting' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  policy: {
    riskClass: 'write',
    requiresConfirmation: false,
    reversible: false,
    idempotent: false,
    tokenCost: 5,
  },
  execute: async (args, context) => {
    const text = args.text as string;
    const refId = args.ref_id as string | undefined;
    const origin = originOf(context.dom.url);
    let target = 'focused-element';
    let fieldIsSensitive: boolean;

    // If ref_id provided, focus that element first
    if (refId) {
      let focusRes;
      try {
        focusRes = await chrome.scripting.executeScript({
          target: { tabId: context.tabId, allFrames: false },
          func: (rId: string) => {
            const el = window.__perceptionFindByRefId?.(rId) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
            if (!el || !el.checkVisibility()) return { success: false, error: 'Element not found or not visible' };
            el.focus();
            return {
              success: true,
              type: (el as HTMLInputElement).type || '',
              autocomplete: (el as HTMLInputElement).autocomplete || '',
              name: (el as HTMLInputElement).name || '',
              id: (el as HTMLInputElement).id || '',
            };
          },
          args: [refId],
        });
      } catch (e) {
        return { success: false, error: String(e), summary: 'Human type failed', navigationOccurred: false };
      }
      const res = focusRes[0]?.result;
      if (!res || !res.success) {
        return { success: false, error: res?.error || 'Failed to resolve ref_id', summary: `Human type failed: ${res?.error}`, navigationOccurred: false };
      }
      target = `ref_id(${refId})`;
      fieldIsSensitive = isSensitiveInput(res);
    } else {
      // Resolve the currently-focused element so the bridge can make an
      // informed sensitive-field decision for selector-less (focused-element)
      // typing. Fail closed if the active element cannot be inspected.
      let focusedCheck;
      try {
        focusedCheck = await chrome.scripting.executeScript({
          target: { tabId: context.tabId, allFrames: false },
          func: () => {
            const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
            if (!el) return null;
            return {
              type: (el as HTMLInputElement).type || '',
              autocomplete: (el as HTMLInputElement).autocomplete || '',
              name: (el as HTMLInputElement).name || '',
              id: (el as HTMLInputElement).id || '',
            };
          },
        });
      } catch (e) {
        return { success: false, error: String(e), summary: 'Human type failed', navigationOccurred: false };
      }

      const focusedField = focusedCheck[0]?.result;
      fieldIsSensitive = focusedField ? isSensitiveInput(focusedField) : true;
    }

    // When preAuthorized, the human already approved this exact action:
    // skip the bridge so the token ledger is not double-charged.
    let decision: PolicyDecision | null = null;
    let actionHash: string | null = null;
    if (!context.preAuthorized) {
      const auth = await authorizeViaBridge({
        type: 'SIMULATE_TYPE',
        payload: { session_id: context.sessionId, origin, target, selector: null, text, field_is_sensitive: fieldIsSensitive, page_revision: context.pageRevision },
      });
      decision = auth.decision;
      actionHash = auth.actionHash;

      if (!decision || !decision.allowed) {
        return {
          success: false,
          error: decision?.reason || 'Bridge unreachable',
          summary: `Human type blocked: ${decision?.reason || 'bridge unreachable'}`,
          navigationOccurred: false,
          requiresConfirmation: decision?.requires_confirmation,
        };
      }

      if (decision.requires_confirmation && !context.preAuthorized) {
        return {
          success: false,
          error: 'Requires confirmation',
          summary: 'Human type requires confirmation',
          navigationOccurred: false,
          requiresConfirmation: true,
          confirmationData: { origin, action: 'human_type', target, data: { text: '[REDACTED]' }, reversible: false, riskClass: decision.risk_class },
        };
      }
    }

    const sessionId = await context.getCdpSession();
    if (!sessionId) {
      await reportActionResult(context.sessionId, actionHash, false, 'CDP session unavailable');
      return { success: false, error: 'CDP session unavailable', summary: 'Human type failed: no CDP session', navigationOccurred: false };
    }

    try {
      await cdpAdapter.insertText(sessionId, text);
      await reportActionResult(context.sessionId, actionHash, true);
      // Never echo the typed text into the summary (it flows into history/persistence).
      return { success: true, summary: 'Human typed into focused element', navigationOccurred: false };
    } catch (e) {
      await reportActionResult(context.sessionId, actionHash, false, String(e));
      return { success: false, error: String(e), summary: 'Human type failed', navigationOccurred: false };
    }
  },
};
