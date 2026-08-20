import { cdpAdapter } from '../../sw/cdp-adapter.js';
import type { PolicyDecision, ToolDefinition } from './types.js';
import { authorizeViaBridge, originOf, reportActionResult } from './shared.js';

// Click - write operation
export const clickTool: ToolDefinition = {
  name: 'click',
  description: 'Click an element',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector' },
      xpath: { type: 'string', description: 'XPath selector (alternative)' },
      text: { type: 'string', description: 'Visible text for disambiguation' },
      ref_id: { type: 'string', description: 'Stable ref_id from perception for targeting' },
    },
    required: ['selector'],
    additionalProperties: false,
  },
  policy: {
    riskClass: 'write',
    requiresConfirmation: false,
    reversible: false,
    idempotent: false,
    tokenCost: 10,
  },
  execute: async (args, context) => {
    const selector = args.selector as string;
    const xpath = args.xpath as string | undefined;
    const textHint = args.text as string | undefined;
    const refId = args.ref_id as string | undefined;
    const origin = originOf(context.dom.url);

    // Injection defense: ref_id must match the perception format before it
    // is handed to the bridge or the content script.
    if (refId !== undefined && !/^momo-\d+$/.test(refId)) {
      return { success: false, error: 'Invalid ref_id format', summary: 'Click failed: invalid ref_id format', navigationOccurred: false };
    }

    // The bridge is the authoritative policy gate for write actions.
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
          action: 'click',
          origin,
          target: refId || selector,
          arguments: { selector, ref_id: refId },
          page_revision: context.pageRevision,
        },
      });
      decision = auth.decision;
      actionHash = auth.actionHash;

      if (!decision || !decision.allowed) {
        return {
          success: false,
          error: decision?.reason || 'Bridge unreachable',
          summary: `Click blocked: ${decision?.reason || 'bridge unreachable'}`,
          navigationOccurred: false,
          requiresConfirmation: decision?.requires_confirmation,
        };
      }

      if (decision.requires_confirmation && !context.preAuthorized) {
        return {
          success: false,
          error: 'Requires confirmation',
          summary: 'Click requires confirmation',
          navigationOccurred: false,
          requiresConfirmation: true,
          confirmationData: {
            origin,
            action: 'click',
            target: refId || selector,
            data: { selector, ref_id: refId },
            reversible: false,
            riskClass: decision.risk_class,
          },
        };
      }
    }

    // Resolve the element's clickable center via the content script (read-only),
    // honoring the optional xpath/text disambiguation params (MOMO-077) and ref_id,
    // then dispatch a trusted CDP mouse click at those coordinates instead of a
    // synthetic el.click() (MOMO-019/080).
    let probe;
    try {
      probe = await chrome.scripting.executeScript({
        target: { tabId: context.tabId, allFrames: false },
        func: (sel: string, xp: string | undefined, hint: string | undefined, rId: string | undefined) => {
          // Detect destructive/sensitive click targets (submit/delete/payment
          // controls) so an irreversible write can be surfaced for human
          // confirmation (MOMO-020). Defined once up top and shared by both
          // the ref_id fast-path and the selector fallback.
          const DESTRUCTIVE_KEYWORDS = [
            'pay', 'buy', 'purchase', 'checkout', 'order', 'confirm', 'submit',
            'delete', 'remove', 'cancel', 'logout', 'sign out', 'signout',
            'deactivate', 'close account', 'unsubscribe', 'transfer', 'refund',
          ];
          const rawTextOf = (el: HTMLElement): string =>
            (el.textContent || (el as HTMLInputElement).value || el.getAttribute('aria-label') || el.getAttribute('value') || '').toLowerCase();
          const isFormSubmitControlOf = (el: HTMLElement): boolean => {
            const tag = el.tagName.toLowerCase();
            const inputType = (el as HTMLInputElement).type || '';
            const buttonType = (el as HTMLButtonElement).type || 'submit';
            return (tag === 'input' && (inputType === 'submit' || inputType === 'image')) ||
              (tag === 'button' && buttonType === 'submit' && el.closest('form') !== null);
          };
          const destructiveOf = (el: HTMLElement): boolean =>
            isFormSubmitControlOf(el) || DESTRUCTIVE_KEYWORDS.some(k => rawTextOf(el).includes(k));

          // Try ref_id first for stable targeting
          let el: HTMLElement | null = null;
          if (rId) {
            el = window.__perceptionFindByRefId?.(rId) || null;
            if (el && el.checkVisibility()) {
              const rect = el.getBoundingClientRect();
              return {
                success: true,
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
                text: el.textContent?.slice(0, 100) || '',
                tag: el.tagName.toLowerCase(),
                bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                destructive: destructiveOf(el),
                label: (el.textContent || '').slice(0, 50),
              };
            }
          }

          // Fall back to XPath/selector
          let candidates: Element[] = [];
          if (xp) {
            try {
              const snapshot = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
              for (let i = 0; i < snapshot.snapshotLength; i++) {
                const node = snapshot.snapshotItem(i);
                if (node) candidates.push(node as Element);
              }
            } catch {
              return { success: false, error: 'Invalid XPath' };
            }
          } else {
            try {
              candidates = Array.from(document.querySelectorAll(sel));
            } catch {
              return { success: false, error: 'Invalid selector' };
            }
          }

          // Disambiguate among matches by visible text when a hint is supplied.
          el = (hint
            ? candidates.find(c => (c.textContent || '').toLowerCase().includes(hint.toLowerCase()))
            : candidates[0]) as HTMLElement | null;

          if (!el) return { success: false, error: 'Element not found' };
          if (!el.checkVisibility()) return { success: false, error: 'Element not visible' };

          const rect = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const rawText = rawTextOf(el);
          const destructive = destructiveOf(el);

          return {
            success: true,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            text: el.textContent?.slice(0, 100) || '',
            tag,
            bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            destructive,
            label: rawText.slice(0, 50),
          };
        },
        args: [selector, xpath, textHint, refId],
      });
    } catch (e) {
      await reportActionResult(context.sessionId, actionHash, false, String(e));
      return { success: false, error: String(e), summary: 'Click failed', navigationOccurred: false };
    }

    const res = probe[0]?.result;
    if (!res || !res.success) {
      await reportActionResult(context.sessionId, actionHash, false, res?.error || 'Click failed');
      return { success: false, error: res?.error || 'Click failed', summary: `Click failed: ${res?.error}`, navigationOccurred: false };
    }

    // Destructive/sensitive click targets require human confirmation before
    // an irreversible write (MOMO-020).
    if (res.destructive && !context.preAuthorized) {
      return {
        success: false,
        error: 'Destructive or sensitive target - requires human confirmation',
        summary: `Click blocked: potentially destructive target "${res.label}"`,
        navigationOccurred: false,
        requiresConfirmation: true,
        confirmationData: {
          origin,
          action: 'click',
          target: selector,
          data: { selector, text: res.text, tag: res.tag },
          reversible: false,
          riskClass: 'dangerous',
        },
      };
    }

    const x = res.x as number;
    const y = res.y as number;

    const sessionId = await context.getCdpSession();
    if (!sessionId) {
      await reportActionResult(context.sessionId, actionHash, false, 'CDP session unavailable');
      return { success: false, error: 'CDP session unavailable', summary: 'Click failed: no CDP session', navigationOccurred: false };
    }

    try {
      // Trusted input via CDP, not a synthetic el.click() (MOMO-019/080).
      await cdpAdapter.dispatchMouseEvent(sessionId, 'mouseMoved', x, y);
      await cdpAdapter.dispatchMouseEvent(sessionId, 'mousePressed', x, y);
      await cdpAdapter.dispatchMouseEvent(sessionId, 'mouseReleased', x, y);
    } catch (e) {
      await reportActionResult(context.sessionId, actionHash, false, String(e));
      return { success: false, error: String(e), summary: 'Click failed', navigationOccurred: false };
    }

    await reportActionResult(context.sessionId, actionHash, true);

    return {
      success: true,
      data: { text: res.text, tag: res.tag, bounds: res.bounds },
      summary: `Clicked "${res.text}" (${res.tag})`,
      navigationOccurred: false,
    };
  },
};
