import type { ToolDefinition, PolicyDecision } from './types.js';
import { deductTokens, authorizeViaBridge, originOf, reportActionResult } from './shared.js';

// Scroll - read operation
export const scrollTool: ToolDefinition = {
  name: 'scroll',
  description: 'Scroll page or element',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector (optional, defaults to window)' },
      direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'Scroll direction' },
      amount: { type: 'number', description: 'Pixels or percentage' },
    },
    required: ['direction'],
    additionalProperties: false,
  },
  policy: {
    riskClass: 'read',
    requiresConfirmation: false,
    reversible: true,
    idempotent: true,
    tokenCost: 1,
  },
  execute: async (args, context) => {
    const selector = args.selector as string | undefined;
    const direction = args.direction as string;
    const amount = args.amount as number | undefined;
    const origin = originOf(context.dom.url);

    // Route read operations through bridge PolicyEngine for authorization
    let decision: PolicyDecision | null = null;
    let actionHash: string | null = null;
    if (!context.preAuthorized) {
      const auth = await authorizeViaBridge({
        type: 'POLICY_CHECK',
        payload: {
          session_id: context.sessionId,
          action: 'scroll',
          origin,
          target: selector || 'window',
          arguments: { selector, direction, amount },
          page_revision: context.pageRevision,
        },
      });
      decision = auth.decision;
      actionHash = auth.actionHash;

      if (!decision || !decision.allowed) {
        return {
          success: false,
          error: decision?.reason || 'Bridge unreachable',
          summary: `Scroll blocked: ${decision?.reason || 'bridge unreachable'}`,
          navigationOccurred: false,
          requiresConfirmation: decision?.requires_confirmation,
        };
      }

      if (decision.requires_confirmation && !context.preAuthorized) {
        return {
          success: false,
          error: 'Requires confirmation',
          summary: 'Scroll requires confirmation',
          navigationOccurred: false,
          requiresConfirmation: true,
          confirmationData: {
            origin,
            action: 'scroll',
            target: selector || 'window',
            data: { selector, direction, amount },
            reversible: true,
            riskClass: decision.risk_class,
          },
        };
      }
    }

    // Deduct tokens only after authorization passes
    deductTokens(context.tokenBudget, 1);

    let result;
    try {
      result = await chrome.scripting.executeScript({
        target: { tabId: context.tabId, allFrames: false },
        func: (sel: string | undefined, dir: string, amt: number | undefined) => {
          const target = sel ? document.querySelector(sel) : window;
          if (!target) return { success: false, error: 'Target not found' };

          const scrollAmount = amt || (target === window ? window.innerHeight * 0.8 : (target as Element).clientHeight * 0.8);

          if (target === window) {
            switch (dir) {
              case 'down': window.scrollBy(0, scrollAmount); break;
              case 'up': window.scrollBy(0, -scrollAmount); break;
              case 'top': window.scrollTo(0, 0); break;
              case 'bottom': window.scrollTo(0, document.body.scrollHeight); break;
            }
          } else {
            const el = target as Element;
            switch (dir) {
              case 'down': el.scrollTop += scrollAmount; break;
              case 'up': el.scrollTop -= scrollAmount; break;
              case 'top': el.scrollTop = 0; break;
              case 'bottom': el.scrollTop = el.scrollHeight; break;
            }
          }

          return { success: true };
        },
        args: [selector, direction, amount],
      });
    } catch (e) {
      await reportActionResult(context.sessionId, actionHash, false, String(e));
      return { 
        success: false, 
        error: String(e), 
        summary: 'Scroll failed', 
        navigationOccurred: false 
      };
    }

    const execResult = result[0]?.result;
    if (!execResult || !execResult.success) {
      await reportActionResult(context.sessionId, actionHash, false, execResult?.error || 'Scroll failed');
      return {
        success: false,
        error: execResult?.error || 'Scroll failed',
        summary: `Scroll failed: ${execResult?.error || 'unknown error'}`,
        navigationOccurred: false,
      };
    }

    await reportActionResult(context.sessionId, actionHash, true);

    return {
      success: true,
      summary: `Scrolled ${direction}${selector ? ` in ${selector}` : ''}`,
      navigationOccurred: false,
    };
  },
};
