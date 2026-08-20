import type { ToolDefinition } from './types.js';
import { deductTokens } from './shared.js';

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
    deductTokens(context.tokenBudget, 5);

    const selector = args.selector as string;
    const condition = args.condition as string || 'visible';
    const timeoutMs = Math.min(typeof args.timeout === 'number' && Number.isFinite(args.timeout) ? args.timeout : 5000, 60_000);

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
        return { success: false, error: String(e), summary: 'Wait failed', navigationOccurred: false };
      }

      if (result[0]?.result === true) {
        return { success: true, summary: `Condition "${condition}" met for ${selector}`, navigationOccurred: false };
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return { success: false, error: `Timeout waiting for ${condition} on ${selector}`, summary: `Wait timeout`, navigationOccurred: false };
  },
};
