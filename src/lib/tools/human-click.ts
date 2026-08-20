import { cdpAdapter } from '../../sw/cdp-adapter.js';
import type { PolicyDecision, ToolDefinition } from './types.js';
import { authorizeViaBridge, originOf, reportActionResult } from './shared.js';

// Human click - write operation via bridge (trusted events)
export const humanClickTool: ToolDefinition = {
  name: 'human_click',
  description: 'Perform human-like click at coordinates or by ref_id via CDP Input API',
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'number' },
      y: { type: 'number' },
      ref_id: { type: 'string', description: 'Stable ref_id from perception for targeting' },
    },
    required: [],
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
    const refId = args.ref_id as string | undefined;
    let x = args.x as number | undefined;
    let y = args.y as number | undefined;
    const origin = originOf(context.dom.url);

    // If ref_id provided, resolve to coordinates first
    if (refId && (x === undefined || y === undefined)) {
      let probe;
      try {
        probe = await chrome.scripting.executeScript({
          target: { tabId: context.tabId, allFrames: false },
          func: (rId: string) => {
            const el = window.__perceptionFindByRefId?.(rId) as HTMLElement | null;
            if (!el || !el.checkVisibility()) return { success: false, error: 'Element not found or not visible' };
            const rect = el.getBoundingClientRect();
            return { success: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          },
          args: [refId],
        });
      } catch (e) {
        return { success: false, error: String(e), summary: 'Human click failed', navigationOccurred: false };
      }
      const res = probe[0]?.result;
      if (!res || !res.success) {
        return { success: false, error: res?.error || 'Failed to resolve ref_id', summary: `Human click failed: ${res?.error}`, navigationOccurred: false };
      }
      x = res.x;
      y = res.y;
    }

    if (x === undefined || y === undefined) {
      return { success: false, error: 'Either (x, y) or ref_id must be provided', summary: 'Human click failed: missing coordinates', navigationOccurred: false };
    }

    const target = `coords(${x},${y})`;

    // The bridge is the authoritative policy gate: never dispatch a trusted
    // input without an explicit `allowed` decision. When preAuthorized, the
    // human already approved this exact action: skip the bridge so the
    // token ledger is not double-charged.
    let decision: PolicyDecision | null = null;
    let actionHash: string | null = null;
    if (!context.preAuthorized) {
      const auth = await authorizeViaBridge({
        type: 'SIMULATE_CLICK',
        payload: { session_id: context.sessionId, origin, target, x, y, page_revision: context.pageRevision },
      });
      decision = auth.decision;
      actionHash = auth.actionHash;

      if (!decision || !decision.allowed) {
        return {
          success: false,
          error: decision?.reason || 'Bridge unreachable',
          summary: `Human click blocked: ${decision?.reason || 'bridge unreachable'}`,
          navigationOccurred: false,
          requiresConfirmation: decision?.requires_confirmation,
        };
      }

      if (decision.requires_confirmation && !context.preAuthorized) {
        return {
          success: false,
          error: 'Requires confirmation',
          summary: 'Human click requires confirmation',
          navigationOccurred: false,
          requiresConfirmation: true,
          confirmationData: { origin, action: 'human_click', target, data: { x, y }, reversible: false, riskClass: decision.risk_class },
        };
      }
    }

    const sessionId = await context.getCdpSession();
    if (!sessionId) {
      await reportActionResult(context.sessionId, actionHash, false, 'CDP session unavailable');
      return { success: false, error: 'CDP session unavailable', summary: 'Human click failed: no CDP session', navigationOccurred: false };
    }

    try {
      await cdpAdapter.dispatchMouseEvent(sessionId, 'mousePressed', x, y);
      await cdpAdapter.dispatchMouseEvent(sessionId, 'mouseReleased', x, y);
      await reportActionResult(context.sessionId, actionHash, true);
      return { success: true, summary: `Human click at (${x}, ${y})`, navigationOccurred: false };
    } catch (e) {
      await reportActionResult(context.sessionId, actionHash, false, String(e));
      return { success: false, error: String(e), summary: 'Human click failed', navigationOccurred: false };
    }
  },
};
