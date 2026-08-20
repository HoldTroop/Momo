import type { PolicyDecision, ToolDefinition } from './types.js';
import { authorizeViaBridge, originOf, reportActionResult, waitForNavigation } from './shared.js';

// Navigation - high risk, requires allowlist match
export const navigateTool: ToolDefinition = {
  name: 'navigate',
  description: 'Navigate to a URL (requires allowlist match)',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri', description: 'URL to navigate to' },
      waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], default: 'networkidle' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  policy: {
    riskClass: 'navigation',
    requiresConfirmation: false, // allowlist check is the gate
    allowedOrigins: [], // populated from context
    reversible: true, // can navigate back
    idempotent: true,
    tokenCost: 100,
  },
  execute: async (args, context) => {
    const url = args.url as string;
    const waitUntil = args.waitUntil as string || 'networkidle';
    const origin = originOf(context.dom.url);

    // Only http/https URLs may be navigated to (scheme hardening).
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { success: false, error: 'Invalid URL', summary: 'Navigation blocked: invalid URL', navigationOccurred: false };
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { success: false, error: 'Only http/https URLs are allowed', summary: 'Navigation blocked: only http/https URLs are allowed', navigationOccurred: false };
    }

    // The bridge is the authoritative policy boundary for navigation. When
    // preAuthorized, the human already approved this exact action: skip the
    // bridge so the token ledger is not double-charged.
    let decision: PolicyDecision | null = null;
    let actionHash: string | null = null;
    if (!context.preAuthorized) {
      const auth = await authorizeViaBridge({
        type: 'POLICY_CHECK',
        payload: {
          session_id: context.sessionId,
          action: 'navigate',
          origin,
          target: url,
          arguments: { url },
          page_revision: context.pageRevision,
        },
      });
      decision = auth.decision;
      actionHash = auth.actionHash;

      if (!decision || !decision.allowed) {
        return {
          success: false,
          error: decision?.reason || 'Bridge unreachable',
          summary: `Navigation blocked: ${decision?.reason || 'bridge unreachable'}`,
          navigationOccurred: false,
          requiresConfirmation: decision?.requires_confirmation,
        };
      }

      // Honor the bridge's confirmation requirement (MOMO-022/023).
      if (decision.requires_confirmation && !context.preAuthorized) {
        return {
          success: false,
          error: 'Requires confirmation',
          summary: 'Navigation requires confirmation',
          navigationOccurred: false,
          requiresConfirmation: true,
          confirmationData: {
            origin,
            action: 'navigate',
            target: url,
            data: { url },
            reversible: true,
            riskClass: decision.risk_class,
          },
        };
      }
    }

    // Navigate the *active* tab — a tabId is required (MOMO-119).
    const navigationComplete = waitForNavigation(context.tabId, waitUntil);
    try {
      await chrome.tabs.update(context.tabId, { url });
    } catch (e) {
      await reportActionResult(context.sessionId, actionHash, false, String(e));
      return {
        success: false,
        error: String(e),
        summary: `Navigation failed: ${e}`,
        navigationOccurred: false,
      };
    }
    await navigationComplete;

    // Re-validate the *final* URL in case the navigation redirected to a
    // different (possibly disallowed) origin (MOMO-085/089).
    let finalUrl = url;
    try {
      const finalTab = await chrome.tabs.get(context.tabId);
      finalUrl = finalTab?.url || url;
    } catch {
      // Tab gone; fall back to the requested URL.
    }

    if (originOf(finalUrl) !== origin) {
      const { decision: redirectCheck } = await authorizeViaBridge({
        type: 'POLICY_CHECK',
        payload: {
          session_id: context.sessionId,
          action: 'navigate',
          origin,
          target: finalUrl,
          arguments: { url: finalUrl },
          page_revision: context.pageRevision,
        },
      });
      if (!redirectCheck || !redirectCheck.allowed) {
        await reportActionResult(context.sessionId, actionHash, false, redirectCheck?.reason || 'Redirected to disallowed origin');
        return {
          success: false,
          error: redirectCheck?.reason || 'Redirected to disallowed origin',
          summary: `Navigation redirected to a blocked URL: ${finalUrl}`,
          navigationOccurred: true,
          requiresConfirmation: false,
        };
      }
    }

    await reportActionResult(context.sessionId, actionHash, true);

    return {
      success: true,
      summary: `Navigated to ${finalUrl}`,
      navigationOccurred: true,
      requiresConfirmation: false,
    };
  },
};
