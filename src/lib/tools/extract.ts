import type { ToolDefinition } from './types.js';
import { deductTokens } from './shared.js';

// Extract - read operation with perception (Readability+Turndown)
export const extractTool: ToolDefinition = {
  name: 'extract',
  description: 'Extract structured data from page with Markdown content and ref_id mapping',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector' },
      schema: { type: 'object', description: 'JSON schema for extraction' },
      multiple: { type: 'boolean', default: false },
      includeMarkdown: { type: 'boolean', default: true },
    },
    required: ['selector', 'schema'],
    additionalProperties: false,
  },
  policy: {
    riskClass: 'read',
    requiresConfirmation: false,
    reversible: true,
    idempotent: true,
    tokenCost: 20,
  },
  execute: async (args, context) => {
    deductTokens(context.tokenBudget, 20);

    const selector = args.selector as string;
    const schema = args.schema as Record<string, { selector?: string; attribute?: string; text?: boolean }>;
    const multiple = args.multiple as boolean ?? false;
    const includeMarkdown = args.includeMarkdown as boolean ?? true;

    // Run both extraction and perception in parallel
    let extractResult;
    let perceptionResult;
    try {
      [extractResult, perceptionResult] = await Promise.all([
      chrome.scripting.executeScript({
        target: { tabId: context.tabId, allFrames: false },
        func: (sel: string, sch: Record<string, { selector?: string; attribute?: string; text?: boolean }>, multi: boolean) => {
          const elements = (multi
            ? Array.from(document.querySelectorAll(sel))
            : [document.querySelector(sel)].filter(Boolean)) as Element[];

          return elements.map(el => {
            const data: Record<string, unknown> = {};
            for (const [key, spec] of Object.entries(sch)) {
              if (spec.selector) {
                const child = el.querySelector(spec.selector);
                data[key] = spec.attribute ? child?.getAttribute(spec.attribute) : child?.textContent?.trim();
              } else if (spec.attribute) {
                data[key] = el.getAttribute(spec.attribute);
              } else if (spec.text) {
                data[key] = el.textContent?.trim();
              }
            }
            return data;
          });
        },
        args: [selector, schema, multiple],
      }),
        chrome.scripting.executeScript({
          target: { tabId: context.tabId, allFrames: false },
          func: (includeMd: boolean) => {
            return window.__perceptionExtract(includeMd);
          },
          args: [includeMarkdown],
        }),
      ]);
    } catch (e) {
      return { success: false, error: String(e), summary: 'Extract failed', navigationOccurred: false };
    }

    const data = extractResult[0]?.result || [];
    const perception = perceptionResult[0]?.result as {
      markdown_content: string;
      ref_id_map: Record<string, string>;
      title: string;
      url: string;
      timestamp: number;
    } | null;

    return {
      success: true,
      data: {
        items: data,
        markdown_content: perception?.markdown_content || '',
        ref_id_map: perception?.ref_id_map || {},
      },
      summary: `Extracted ${data.length} item(s) from ${selector}`,
      navigationOccurred: false,
    };
  },
};
