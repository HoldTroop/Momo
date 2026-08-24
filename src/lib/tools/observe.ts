import type { ToolDefinition, PolicyDecision } from './types.js';
import { deductTokens, authorizeViaBridge, originOf, reportActionResult } from './shared.js';

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
    const includeMarkdown = args.includeMarkdown as boolean ?? true;
    const origin = originOf(context.dom.url);

    // Route read operations through bridge PolicyEngine for authorization
    let decision: PolicyDecision | null = null;
    let actionHash: string | null = null;
    if (!context.preAuthorized) {
      const auth = await authorizeViaBridge({
        type: 'POLICY_CHECK',
        payload: {
          session_id: context.sessionId,
          action: 'observe',
          origin,
          target: context.dom.url,
          arguments: { includeMarkdown },
          page_revision: context.pageRevision,
        },
      });
      decision = auth.decision;
      actionHash = auth.actionHash;

      if (!decision || !decision.allowed) {
        return {
          success: false,
          error: decision?.reason || 'Bridge unreachable',
          summary: `Observe blocked: ${decision?.reason || 'bridge unreachable'}`,
          navigationOccurred: false,
          requiresConfirmation: decision?.requires_confirmation,
        };
      }

      if (decision.requires_confirmation && !context.preAuthorized) {
        return {
          success: false,
          error: 'Requires confirmation',
          summary: 'Observe requires confirmation',
          navigationOccurred: false,
          requiresConfirmation: true,
          confirmationData: {
            origin,
            action: 'observe',
            target: context.dom.url,
            data: { includeMarkdown },
            reversible: true,
            riskClass: decision.risk_class,
          },
        };
      }
    }

    // Deduct tokens only after authorization passes
    deductTokens(context.tokenBudget, 50);

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
      await reportActionResult(context.sessionId, actionHash, false, String(e));
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

    await reportActionResult(context.sessionId, actionHash, true);

    return {
      success: true,
      data: augmentedDom,
      summary: `Observed page: ${context.dom.title}`,
      navigationOccurred: false,
    };
  },
};
