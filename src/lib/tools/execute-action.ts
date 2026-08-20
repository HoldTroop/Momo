import { cdpAdapter } from '../../sw/cdp-adapter.js';
import { isSensitiveInput } from '../redaction.js';
import type { PolicyDecision, ToolDefinition } from './types.js';
import { authorizeViaBridge, focusRefStrict, originOf, reportActionResult, resolveRefStrict } from './shared.js';
import { navigateTool } from './navigate.js';

// execute_action — the MCP write tool (PHASE9 §5). Targets an el_XX ref
// returned by get_interactive_elements; `ref` is the ONLY targeting key, so
// there is NO raw-CSS-selector fallback. Reuses the click/type executors'
// CDP dispatch (dispatchMouseEvent / insertText) and the navigate executor.
// stale_reference is returned as a structured error for the bridge to map to
// isError:true (M4 wiring).
export const executeActionTool: ToolDefinition = {
  name: 'execute_action',
  description: 'Execute one action against a stable element ref (el_XX) from get_interactive_elements: click, type, scroll, or navigate. ref is the only targeting key; raw CSS selectors are rejected.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['click', 'type', 'scroll', 'navigate'], description: 'The action to perform.' },
      ref: { type: 'string', description: 'Stable el_XX id from get_interactive_elements (required for click/type/scroll).' },
      text: { type: 'string', description: 'Text to type (action=type only).' },
      url: { type: 'string', format: 'uri', description: 'URL to navigate to (action=navigate only).' },
    },
    required: ['action'],
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
    const action = args.action as string;
    const ref = args.ref as string | undefined;
    const text = args.text as string | undefined;
    const url = args.url as string | undefined;

    // Injection defense: ref must match the el_XX format for ref-targeted
    // actions before any content-script or bridge call is made.
    if ((action === 'click' || action === 'scroll' || action === 'type') && ref !== undefined && !/^el_\d+$/.test(ref)) {
      return { success: false, error: 'Invalid ref format', summary: `execute_action ${action}: invalid ref`, navigationOccurred: false };
    }

    switch (action) {
      case 'navigate': {
        if (!url) {
          return { success: false, error: 'Missing url for navigate', summary: 'execute_action navigate: missing url', navigationOccurred: false };
        }
        try {
          const u = new URL(url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            return { success: false, error: 'Only http/https URLs are allowed', summary: 'execute_action navigate: only http/https URLs are allowed', navigationOccurred: false };
          }
        } catch {
          return { success: false, error: 'Invalid URL', summary: 'execute_action navigate: invalid URL', navigationOccurred: false };
        }
        return navigateTool.execute({ url }, context);
      }

      case 'scroll': {
        if (ref !== undefined && !/^el_\d+$/.test(ref)) {
          return { success: false, error: 'Invalid ref format', summary: 'execute_action scroll: invalid ref', navigationOccurred: false };
        }
        const origin = originOf(context.dom.url);

        // The bridge is the authoritative policy gate for write actions.
        // When preAuthorized, the human already approved this exact action:
        // skip the bridge so the token ledger is not double-charged.
        let decision: PolicyDecision | null = null;
        let actionHash: string | null = null;
        if (!context.preAuthorized) {
          const auth = await authorizeViaBridge({
            type: 'POLICY_CHECK',
            payload: {
              session_id: context.sessionId,
              action: 'scroll',
              origin,
              target: ref ?? 'window',
              arguments: { ref },
              page_revision: context.pageRevision,
            },
          });
          decision = auth.decision;
          actionHash = auth.actionHash;

          if (!decision || !decision.allowed) {
            return { success: false, error: decision?.reason || 'Bridge unreachable', summary: `Scroll blocked: ${decision?.reason || 'bridge unreachable'}`, navigationOccurred: false, requiresConfirmation: decision?.requires_confirmation };
          }
          if (decision.requires_confirmation && !context.preAuthorized) {
            return { success: false, error: 'Requires confirmation', summary: 'Scroll requires confirmation', navigationOccurred: false, requiresConfirmation: true, confirmationData: { origin, action: 'scroll', target: ref ?? 'window', data: { ref }, reversible: true, riskClass: decision.risk_class } };
          }
        }

        let result;
        try {
          result = await chrome.scripting.executeScript({
            target: { tabId: context.tabId, allFrames: false },
            func: (r: string | undefined) => {
              if (!r) {
                window.scrollBy(0, window.innerHeight * 0.8);
                return { success: true };
              }
              const el = document.querySelector(`[data-momo-ref="${r}"]`) as HTMLElement | null;
              if (!el || !el.isConnected || !el.checkVisibility()) return { status: 'stale_reference', ref: r };
              el.scrollTop += el.clientHeight * 0.8;
              return { success: true };
            },
            args: [ref],
          });
        } catch (e) {
          await reportActionResult(context.sessionId, actionHash, false, String(e));
          return { success: false, error: String(e), summary: 'execute_action scroll failed', navigationOccurred: false };
        }
        const res = result[0]?.result as { success?: boolean; status?: string } | undefined;
        if (res && res.status === 'stale_reference') {
          await reportActionResult(context.sessionId, actionHash, false, 'stale_reference');
          return { success: false, error: 'stale_reference', summary: `execute_action scroll: stale reference ${ref}`, data: { error: 'stale_reference', ref, hint: 're-fetch get_interactive_elements' }, navigationOccurred: false };
        }
        if (!res || res.success !== true) {
          await reportActionResult(context.sessionId, actionHash, false, 'Scroll failed');
          return { success: false, error: 'Scroll failed', summary: 'execute_action scroll failed', navigationOccurred: false };
        }
        await reportActionResult(context.sessionId, actionHash, true);
        return { success: true, summary: `Scrolled ${ref ? `element ${ref}` : 'window'}`, navigationOccurred: false };
      }

      case 'click': {
        if (!ref) {
          return { success: false, error: 'Missing ref for click', summary: 'execute_action click: missing ref', navigationOccurred: false };
        }
        const origin = originOf(context.dom.url);

        // When preAuthorized, the human already approved this exact action:
        // skip the bridge so the token ledger is not double-charged.
        let decision: PolicyDecision | null = null;
        let actionHash: string | null = null;
        if (!context.preAuthorized) {
          const auth = await authorizeViaBridge({
            type: 'POLICY_CHECK',
            payload: { session_id: context.sessionId, action: 'click', origin, target: ref, arguments: { ref }, page_revision: context.pageRevision },
          });
          decision = auth.decision;
          actionHash = auth.actionHash;
          if (!decision || !decision.allowed) {
            return { success: false, error: decision?.reason || 'Bridge unreachable', summary: `Click blocked: ${decision?.reason || 'bridge unreachable'}`, navigationOccurred: false, requiresConfirmation: decision?.requires_confirmation };
          }
          if (decision.requires_confirmation && !context.preAuthorized) {
            return { success: false, error: 'Requires confirmation', summary: 'Click requires confirmation', navigationOccurred: false, requiresConfirmation: true, confirmationData: { origin, action: 'click', target: ref, data: { ref }, reversible: false, riskClass: decision.risk_class } };
          }
        }

        const resolved = await resolveRefStrict(context.tabId, ref);
        if (resolved.status !== 'ok') {
          await reportActionResult(context.sessionId, actionHash, false, 'stale_reference');
          return { success: false, error: 'stale_reference', summary: `execute_action click: stale reference ${ref}`, data: { error: 'stale_reference', ref, hint: 're-fetch get_interactive_elements' }, navigationOccurred: false };
        }

        // Destructive/sensitive targets require human confirmation before an
        // irreversible write.
        if (resolved.destructive && !context.preAuthorized) {
          return { success: false, error: 'Destructive or sensitive target - requires human confirmation', summary: `Click blocked: potentially destructive target "${ref}"`, navigationOccurred: false, requiresConfirmation: true, confirmationData: { origin, action: 'click', target: ref, data: { ref }, reversible: false, riskClass: 'write' } };
        }

        const sessionId = await context.getCdpSession();
        if (!sessionId) {
          await reportActionResult(context.sessionId, actionHash, false, 'CDP session unavailable');
          return { success: false, error: 'CDP session unavailable', summary: 'execute_action click: no CDP session', navigationOccurred: false };
        }
        try {
          await cdpAdapter.dispatchMouseEvent(sessionId, 'mouseMoved', resolved.x, resolved.y);
          await cdpAdapter.dispatchMouseEvent(sessionId, 'mousePressed', resolved.x, resolved.y);
          await cdpAdapter.dispatchMouseEvent(sessionId, 'mouseReleased', resolved.x, resolved.y);
        } catch (e) {
          await reportActionResult(context.sessionId, actionHash, false, String(e));
          return { success: false, error: String(e), summary: 'execute_action click failed', navigationOccurred: false };
        }
        await reportActionResult(context.sessionId, actionHash, true);
        return { success: true, data: { ref, x: resolved.x, y: resolved.y }, summary: `Clicked ref ${ref}`, navigationOccurred: false };
      }

      case 'type': {
        if (!ref) {
          return { success: false, error: 'Missing ref for type', summary: 'execute_action type: missing ref', navigationOccurred: false };
        }
        if (text === undefined) {
          return { success: false, error: 'Missing text for type', summary: 'execute_action type: missing text', navigationOccurred: false };
        }
        const origin = originOf(context.dom.url);

        const focused = await focusRefStrict(context.tabId, ref);
        if (focused.status !== 'ok') {
          return { success: false, error: 'stale_reference', summary: `execute_action type: stale reference ${ref}`, data: { error: 'stale_reference', ref, hint: 're-fetch get_interactive_elements' }, navigationOccurred: false };
        }
        const fieldIsSensitive = isSensitiveInput(focused.field);

        // When preAuthorized, the human already approved this exact action:
        // skip the bridge so the token ledger is not double-charged.
        let decision: PolicyDecision | null = null;
        let actionHash: string | null = null;
        if (!context.preAuthorized) {
          const auth = await authorizeViaBridge({
            type: 'POLICY_CHECK',
            payload: { session_id: context.sessionId, action: 'type', origin, target: ref, arguments: { ref, text_length: text.length, field_is_sensitive: fieldIsSensitive }, page_revision: context.pageRevision },
          });
          decision = auth.decision;
          actionHash = auth.actionHash;
          if (!decision || !decision.allowed) {
            return { success: false, error: decision?.reason || 'Bridge unreachable', summary: `Type blocked: ${decision?.reason || 'bridge unreachable'}`, navigationOccurred: false, requiresConfirmation: decision?.requires_confirmation };
          }
          if (decision.requires_confirmation && !context.preAuthorized) {
            return { success: false, error: 'Requires confirmation', summary: 'Type requires confirmation', navigationOccurred: false, requiresConfirmation: true, confirmationData: { origin, action: 'type', target: ref, data: { ref, text: '[REDACTED]' }, reversible: false, riskClass: decision.risk_class } };
          }
        }
        if (fieldIsSensitive && !context.preAuthorized) {
          return { success: false, error: 'Sensitive field detected - requires human confirmation', summary: 'Type blocked: sensitive field', navigationOccurred: false, requiresConfirmation: true, confirmationData: { origin, action: 'type', target: ref, data: { ref, text: '[REDACTED]' }, reversible: false, riskClass: 'auth' } };
        }

        const sessionId = await context.getCdpSession();
        if (!sessionId) {
          await reportActionResult(context.sessionId, actionHash, false, 'CDP session unavailable');
          return { success: false, error: 'CDP session unavailable', summary: 'execute_action type: no CDP session', navigationOccurred: false };
        }
        try {
          await cdpAdapter.insertText(sessionId, text);
        } catch (e) {
          await reportActionResult(context.sessionId, actionHash, false, String(e));
          return { success: false, error: String(e), summary: 'execute_action type failed', navigationOccurred: false };
        }
        await reportActionResult(context.sessionId, actionHash, true);
        return { success: true, summary: `Typed into ref ${ref}`, navigationOccurred: false };
      }

      default:
        return { success: false, error: `Unsupported action: ${action}`, summary: `Unsupported action: ${action}`, navigationOccurred: false };
    }
  },
};
