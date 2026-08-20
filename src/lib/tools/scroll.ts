import type { ToolDefinition } from './types.js';
import { deductTokens } from './shared.js';

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
    deductTokens(context.tokenBudget, 1);

    const selector = args.selector as string | undefined;
    const direction = args.direction as string;
    const amount = args.amount as number | undefined;

    const result = await chrome.scripting.executeScript({
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

    return {
      success: true,
      summary: `Scrolled ${direction}${selector ? ` in ${selector}` : ''}`,
      navigationOccurred: false,
    };
  },
};
