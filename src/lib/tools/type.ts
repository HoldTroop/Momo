import { cdpAdapter } from '../../sw/cdp-adapter.js';
import { isSensitiveInput } from '../redaction.js';
import type { PolicyDecision, ToolDefinition } from './types.js';
import { authorizeViaBridge, originOf, reportActionResult } from './shared.js';

// Type - write operation, may be sensitive
export const typeTool: ToolDefinition = {
  name: 'type',
  description: 'Type text into an input field',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector' },
      text: { type: 'string', description: 'Text to type' },
      clearFirst: { type: 'boolean', default: true },
      pressEnter: { type: 'boolean', default: false },
      ref_id: { type: 'string', description: 'Stable ref_id from perception for targeting' },
    },
    required: ['selector', 'text'],
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
    const selector = args.selector as string;
    const text = args.text as string;
    const clearFirst = args.clearFirst as boolean ?? true;
    const pressEnter = args.pressEnter as boolean ?? false;
    const refId = args.ref_id as string | undefined;
    const origin = originOf(context.dom.url);

    // The bridge is the authoritative policy gate for write actions. The
    // typed text is redacted to its length so the secret never reaches the
    // audit log (mirroring the bridge's own SimulateType handling).
    // Include ref_id in arguments for audit trail. When preAuthorized, the
    // human already approved this exact action: skip the bridge so the
    // token ledger is not double-charged.
    let decision: PolicyDecision | null = null;
    let actionHash: string | null = null;
    if (!context.preAuthorized) {
      const auth = await authorizeViaBridge({
        type: 'POLICY_CHECK',
        payload: {
          session_id: context.sessionId,
          action: 'type',
          origin,
          target: refId || selector,
          arguments: { selector, ref_id: refId, text_length: text.length },
          page_revision: context.pageRevision,
        },
      });
      decision = auth.decision;
      actionHash = auth.actionHash;

      if (!decision || !decision.allowed) {
        return {
          success: false,
          error: decision?.reason || 'Bridge unreachable',
          summary: `Type blocked: ${decision?.reason || 'bridge unreachable'}`,
          navigationOccurred: false,
          requiresConfirmation: decision?.requires_confirmation,
        };
      }

      if (decision.requires_confirmation && !context.preAuthorized) {
        return {
          success: false,
          error: 'Requires confirmation',
          summary: 'Type requires confirmation',
          navigationOccurred: false,
          requiresConfirmation: true,
          confirmationData: {
            origin,
            action: 'type',
            target: refId || selector,
            data: { selector, ref_id: refId, text: '[REDACTED]', clearFirst, pressEnter },
            reversible: false,
            riskClass: decision.risk_class,
          },
        };
      }
    }

    // Resolve the field descriptor, verify visibility, and focus it in a
    // single content-script injection (MOMO-118): the sensitive check and the
    // focus happen atomically on the same element so the target cannot be
    // swapped to a sensitive input between the check and the write. The field
    // is NEVER cleared here — clearing happens only after the sensitive gate
    // passes, so a sensitive field's existing value survives a denied attempt.
    // Try ref_id first for stable targeting.
    let probe;
    try {
      probe = await chrome.scripting.executeScript({
        target: { tabId: context.tabId, allFrames: false },
        func: (sel: string, rId: string | undefined) => {
          // Try ref_id first
          let el: HTMLInputElement | HTMLTextAreaElement | null = null;
          if (rId) {
            el = window.__perceptionFindByRefId?.(rId) as HTMLInputElement | HTMLTextAreaElement | null;
          }
          if (!el) {
            el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
          }
          if (!el) return { success: false, error: 'Element not found' };
          if (!el.checkVisibility()) return { success: false, error: 'Element not visible' };

          el.focus();

          return {
            success: true,
            field: {
              type: el.type || '',
              autocomplete: el.autocomplete || '',
              name: el.name || '',
              id: el.id || '',
            },
          };
        },
        args: [selector, refId],
      });
    } catch (e) {
      await reportActionResult(context.sessionId, actionHash, false, String(e));
      return { success: false, error: String(e), summary: 'Type failed', navigationOccurred: false };
    }

    const res = probe[0]?.result;
    if (!res || !res.success) {
      await reportActionResult(context.sessionId, actionHash, false, res?.error || 'Type failed');
      return { success: false, error: res?.error || 'Type failed', summary: `Type failed: ${res?.error}`, navigationOccurred: false };
    }

    // Sensitive-field gate uses the shared detector (isSensitiveInput) rather
    // than a weaker inline duplicate (MOMO-021/087/088). Only the actual
    // typing (insertText below) and the post-gate clear are gated; nothing
    // mutates the field before this check passes.
    const isSensitive = res.field ? isSensitiveInput(res.field) : true;
    if (isSensitive && !context.preAuthorized) {
      return {
        success: false,
        error: 'Sensitive field detected - requires human confirmation',
        summary: `Type blocked: sensitive field (${res.field?.type})`,
        navigationOccurred: false,
        requiresConfirmation: true,
        confirmationData: {
          origin,
          action: 'type',
          target: selector,
          data: { selector, text: '[REDACTED]', clearFirst, pressEnter },
          reversible: false,
          riskClass: 'auth',
        },
      };
    }

    // The gate passed: now it is safe to clear the field (MOMO-118). A
    // second injection re-resolves the same element (ref-first, then
    // selector), re-checks visibility, then clears it.
    if (clearFirst) {
      let clearProbe;
      try {
        clearProbe = await chrome.scripting.executeScript({
          target: { tabId: context.tabId, allFrames: false },
          func: (sel: string, rId: string | undefined) => {
            let el: HTMLInputElement | HTMLTextAreaElement | null = null;
            if (rId) {
              el = window.__perceptionFindByRefId?.(rId) as HTMLInputElement | HTMLTextAreaElement | null;
            }
            if (!el) {
              el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
            }
            if (!el) return { success: false, error: 'Element not found' };
            if (!el.checkVisibility()) return { success: false, error: 'Element not visible' };
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return { success: true };
          },
          args: [selector, refId],
        });
      } catch (e) {
        await reportActionResult(context.sessionId, actionHash, false, String(e));
        return { success: false, error: String(e), summary: 'Type failed', navigationOccurred: false };
      }
      const clearRes = clearProbe[0]?.result;
      if (!clearRes || !clearRes.success) {
        await reportActionResult(context.sessionId, actionHash, false, clearRes?.error || 'Clear failed');
        return { success: false, error: clearRes?.error || 'Clear failed', summary: `Type failed: ${clearRes?.error || 'clear failed'}`, navigationOccurred: false };
      }
    }

    const sessionId = await context.getCdpSession();
    if (!sessionId) {
      await reportActionResult(context.sessionId, actionHash, false, 'CDP session unavailable');
      return { success: false, error: 'CDP session unavailable', summary: 'Type failed: no CDP session', navigationOccurred: false };
    }

    try {
      // Trusted typing via CDP Input.insertText, not el.value += / synthetic
      // KeyboardEvent (MOMO-080/083).
      await cdpAdapter.insertText(sessionId, text);
      if (pressEnter) {
        await cdpAdapter.dispatchKeyEvent(sessionId, 'Enter', 'keyDown');
        await cdpAdapter.dispatchKeyEvent(sessionId, 'Enter', 'keyUp');
      }
      await reportActionResult(context.sessionId, actionHash, true);
      // Never echo the typed text into the summary (it flows into history/persistence).
      return { success: true, summary: `Typed into ${selector}`, navigationOccurred: false };
    } catch (e) {
      await reportActionResult(context.sessionId, actionHash, false, String(e));
      return { success: false, error: String(e), summary: 'Type failed', navigationOccurred: false };
    }
  },
};
