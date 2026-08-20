import type { ToolDefinition } from './types.js';
import { deductTokens } from './shared.js';

// Observe - read operation with perception (Readability+Turndown)
export const observeTool: ToolDefinition = {
  name: 'observe',
  description: 'Get current page state with Markdown content and ref_id mapping',
  parameters: {
    type: 'object',
    properties: {
      includeMarkdown: { type: 'boolean', default: true },
    },
    additionalProperties: false,
  },
  policy: {
    riskClass: 'read',
    requiresConfirmation: false,
    reversible: true,
    idempotent: true,
    tokenCost: 50,
  },
  execute: async (args, context) => {
    deductTokens(context.tokenBudget, 50);
    const includeMarkdown = args.includeMarkdown as boolean ?? true;

    // Run perception in content script
    let perceptionResult;
    try {
      perceptionResult = await chrome.scripting.executeScript({
        target: { tabId: context.tabId, allFrames: false },
        func: (includeMd: boolean) => {
          return window.__perceptionExtract(includeMd);
        },
        args: [includeMarkdown],
      });
    } catch (e) {
      return { success: false, error: String(e), summary: 'Observe failed', navigationOccurred: false };
    }

    const perception = perceptionResult[0]?.result as {
      markdown_content: string;
      ref_id_map: Record<string, string>;
      title: string;
      url: string;
      timestamp: number;
    } | null;

    // Augment the DOM snapshot with perception data
    const augmentedDom = {
      ...context.dom,
      markdown_content: perception?.markdown_content || '',
      ref_id_map: perception?.ref_id_map || {},
    };

    return {
      success: true,
      data: augmentedDom,
      summary: `Observed page: ${context.dom.title}`,
      navigationOccurred: false,
    };
  },
};
