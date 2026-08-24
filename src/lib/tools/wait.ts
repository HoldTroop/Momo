import type { ToolDefinition, PolicyDecision } from './types.js';
import { deductTokens, authorizeViaBridge, originOf, reportActionResult } from './shared.js';

// Wait - read operation
export const waitTool: ToolDefinition = {
  name: 'wait',
  description: 'Wait for condition',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector' },
      condition: { type: 'string', enum: ['visible', 'hidden', 'enabled', 'disabled'], default: 'visible' },
      timeout: { type: 'number', default: 5000 },
    },
    required: ['selector'],
    additionalProperties: false,
  },
  policy: {
    riskClass: 'read',
    requiresConfirmation: false,
    reversible: true,
    idempotent: true,
    tokenCost: 5,
  },
  execute: async (args, context) => {
    const selector = args.selector as string;
    const condition = args.condition as string || 'visible';
    const timeoutMs = Math.min(typeof args.timeout === 'number' && Number.isFinite(args.timeout) ? args.timeout : 5000, 60_000);
    const origin = originOf(context.dom.url);

    // Route read operations through bridge PolicyEngine for authorization
    let decision: PolicyDecision | null = null;
    let actionHash: string | null = null;
    if (!context.preAuthorized) {
      const auth = await authorizeViaBridge({
        type: 'POLICY_CHECK',
        payload: {
          session_id: context.sessionId,
          action: 'wait',
          origin,
          target: selector,
          arguments: { selector, condition, timeout: timeoutMs },
          page_revision: context.pageRevision,
        },
      });
      decision = auth.decision;
      actionHash = auth.actionHash;

      if (!decision || !decision.allowed) {
        return {
          success: false,
          error: decision?.reason || 'Bridge unreachable',
          summary: `Wait blocked: ${decision?.reason || 'bridge unreachable'}`,
          navigationOccurred: false,
          requiresConfirmation: decision?.requires_confirmation,
        };
      }

      if (decision.requires_confirmation && !context.preAuthorized) {
        return {
          success: false,
          error: 'Requires confirmation',
          summary: 'Wait requires confirmation',
          navigationOccurred: false,
          requiresConfirmation: true,
          confirmationData: {
            origin,
            action: 'wait',
            target: selector,
            data: { selector, condition, timeout: timeoutMs },
            reversible: true,
            riskClass: decision.risk_class,
          },
        };
      }
    }

    // Deduct tokens only after authorization passes
    deductTokens(context.tokenBudget, 5);

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      let result;
      try {
        result = await chrome.scripting.executeScript({
          target: { tabId: context.tabId, allFrames: false },
          func: (sel: string, cond: string) => {
            const el = document.querySelector(sel);
            if (!el) return false;

            switch (cond) {
              case 'visible': return el.checkVisibility();
              case 'hidden': return !el.checkVisibility();
              case 'enabled': return !(el as HTMLInputElement).disabled;
              case 'disabled': return !!(el as HTMLInputElement).disabled;
            }
            return false;
          },
          args: [selector, condition],
        });
      } catch (e) {
        await reportActionResult(context.sessionId, actionHash, false, String(e));
        return { success: false, error: String(e), summary: 'Wait failed', navigationOccurred: false };
      }

      if (result[0]?.result === true) {
        await reportActionResult(context.sessionId, actionHash, true);
        return { success: true, summary: `Condition "${condition}" met for ${selector}`, navigationOccurred: false };
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    await reportActionResult(context.sessionId, actionHash, false, `Timeout waiting for ${condition} on ${selector}`);
    return { success: false, error: `Timeout waiting for ${condition} on ${selector}`, summary: `Wait timeout`, navigationOccurred: false };
  },
};
