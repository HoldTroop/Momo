import { ToolCall, ToolResult, CompressedDom, BridgeRequest } from '../sw/orchestrator.js';
import { cdpAdapter } from '../sw/cdp-adapter.js';
import { isSensitiveInput } from './redaction.js';
import { getWsClient } from '../sw/ws-client.js';

export type RiskClass = 'read' | 'write' | 'navigation' | 'payment' | 'auth' | 'dangerous';

export interface ToolPolicy {
  riskClass: RiskClass;
  requiresConfirmation: boolean;
  allowedOrigins?: string[];
  reversible: boolean;
  idempotent: boolean;
  tokenCost: number;
}

export interface ToolContext {
  dom: CompressedDom;
  variables: Record<string, unknown>;
  step: ToolCall;
  allowlist: string[];
  /** Read-only-tool token budget; write actions are budgeted by the Rust bridge. */
  tokenBudget: { max: number; used: number };
  pageRevision: number;
  sessionId: string;
  tabId: number;
  getCdpSession: () => Promise<string | null>;
  /**
   * One-shot human-confirmation grant. When true, the tool still runs the
   * bridge's allow/deny check but skips the `requires_confirmation` early
   * return — the human has already approved this exact action. Set only by the
   * orchestrator's confirmation re-execution path.
   */
  preAuthorized?: boolean;
}

export type ToolExecutor = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  policy: ToolPolicy;
  execute: ToolExecutor;
}

/** Bridge policy decision, mirroring the Rust `PolicyDecision` serialization. */
interface PolicyDecision {
  allowed: boolean;
  requires_confirmation: boolean;
  reason: string | null;
  risk_class: string;
  confirmation_data: { origin: string; action: string; target: string; data: unknown; reversible: boolean; risk_class: string } | null;
}

/** Bridge authorize response: the decision plus the `action_hash` for result reporting. */
interface AuthResult {
  decision: PolicyDecision | null;
  actionHash: string | null;
}

/** Send an authorization request to the bridge via WebSocket and return its policy decision. */
async function authorizeViaBridge(request: Record<string, unknown>): Promise<AuthResult> {
  try {
    const wsClient = getWsClient();
    const data = await wsClient.send<{ decision?: PolicyDecision; action_hash?: string } | null>('POLICY_CHECK', request);
    return {
      decision: data?.decision ?? null,
      actionHash: data?.action_hash ?? null,
    };
  } catch (e) {
    console.warn('[ToolRegistry] Bridge authorize failed:', e);
    return { decision: null, actionHash: null };
  }
}

/**
 * Report the real execution outcome back to the bridge so the audit entry
 * written at decision time can be corrected from `Pending`/`Escalated` to
 * `Success`/`Failed` (MOMO-056). Best-effort: audit reporting must never block
 * or fail the action itself.
 */
async function reportActionResult(sessionId: string, actionHash: string | null, success: boolean, error?: string): Promise<void> {
  if (!actionHash) return;
  try {
    const wsClient = getWsClient();
    await wsClient.send('ACTION_RESULT', {
      session_id: sessionId,
      action_hash: actionHash,
      outcome: success ? 'success' : 'failed',
      error: error ?? null,
    });
  } catch (e) {
    console.warn('[ToolRegistry] Report action result failed:', e);
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Local token accounting for the read-only tools (scroll/extract/wait/observe),
 * which are not gated by the bridge. Write actions (navigate/click/type/
 * human_click/human_type) are budgeted exclusively by the Rust PolicyEngine —
 * the single authoritative ledger — which deducts only after an `allowed`
 * decision (MOMO-079/082). Keeping the two ledgers disjoint avoids
 * double-charging any single action.
 */
function deductTokens(budget: { max: number; used: number }, cost: number): void {
  budget.used += cost;
  if (budget.used > budget.max) {
    throw new Error(`Token budget exceeded: ${budget.used}/${budget.max}`);
  }
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    this.registerCoreTools();
  }

  private registerCoreTools() {
    // Navigation - high risk, requires allowlist match
    this.register({
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
        const navigationComplete = this.waitForNavigation(context.tabId, waitUntil);
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
    });

    // Click - write operation
    this.register({
      name: 'click',
      description: 'Click an element',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector' },
          xpath: { type: 'string', description: 'XPath selector (alternative)' },
          text: { type: 'string', description: 'Visible text for disambiguation' },
          ref_id: { type: 'string', description: 'Stable ref_id from perception for targeting' },
        },
        required: ['selector'],
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
        const selector = args.selector as string;
        const xpath = args.xpath as string | undefined;
        const textHint = args.text as string | undefined;
        const refId = args.ref_id as string | undefined;
        const origin = originOf(context.dom.url);

        // Injection defense: ref_id must match the perception format before it
        // is handed to the bridge or the content script.
        if (refId !== undefined && !/^momo-\d+$/.test(refId)) {
          return { success: false, error: 'Invalid ref_id format', summary: 'Click failed: invalid ref_id format', navigationOccurred: false };
        }

        // The bridge is the authoritative policy gate for write actions.
        // Include ref_id in arguments for audit trail. When preAuthorized, the
        // human already approved this exact action: skip the bridge so the
        // token ledger is not double-charged.
        let decision: PolicyDecision | null = null;
        let actionHash: string | null = null;
        if (!context.preAuthorized) {
          const auth = await authorizeViaBridge({
            type: 'POLICY_CHECK',
            payload: {
              session_id: context.sessionId,
              action: 'click',
              origin,
              target: refId || selector,
              arguments: { selector, ref_id: refId },
              page_revision: context.pageRevision,
            },
          });
          decision = auth.decision;
          actionHash = auth.actionHash;

          if (!decision || !decision.allowed) {
            return {
              success: false,
              error: decision?.reason || 'Bridge unreachable',
              summary: `Click blocked: ${decision?.reason || 'bridge unreachable'}`,
              navigationOccurred: false,
              requiresConfirmation: decision?.requires_confirmation,
            };
          }

          if (decision.requires_confirmation && !context.preAuthorized) {
            return {
              success: false,
              error: 'Requires confirmation',
              summary: 'Click requires confirmation',
              navigationOccurred: false,
              requiresConfirmation: true,
              confirmationData: {
                origin,
                action: 'click',
                target: refId || selector,
                data: { selector, ref_id: refId },
                reversible: false,
                riskClass: decision.risk_class,
              },
            };
          }
        }

        // Resolve the element's clickable center via the content script (read-only),
        // honoring the optional xpath/text disambiguation params (MOMO-077) and ref_id,
        // then dispatch a trusted CDP mouse click at those coordinates instead of a
        // synthetic el.click() (MOMO-019/080).
        let probe;
        try {
          probe = await chrome.scripting.executeScript({
            target: { tabId: context.tabId, allFrames: false },
            func: (sel: string, xp: string | undefined, hint: string | undefined, rId: string | undefined) => {
              // Detect destructive/sensitive click targets (submit/delete/payment
              // controls) so an irreversible write can be surfaced for human
              // confirmation (MOMO-020). Defined once up top and shared by both
              // the ref_id fast-path and the selector fallback.
              const DESTRUCTIVE_KEYWORDS = [
                'pay', 'buy', 'purchase', 'checkout', 'order', 'confirm', 'submit',
                'delete', 'remove', 'cancel', 'logout', 'sign out', 'signout',
                'deactivate', 'close account', 'unsubscribe', 'transfer', 'refund',
              ];
              const rawTextOf = (el: HTMLElement): string =>
                (el.textContent || (el as HTMLInputElement).value || el.getAttribute('aria-label') || el.getAttribute('value') || '').toLowerCase();
              const isFormSubmitControlOf = (el: HTMLElement): boolean => {
                const tag = el.tagName.toLowerCase();
                const inputType = (el as HTMLInputElement).type || '';
                const buttonType = (el as HTMLButtonElement).type || 'submit';
                return (tag === 'input' && (inputType === 'submit' || inputType === 'image')) ||
                  (tag === 'button' && buttonType === 'submit' && el.closest('form') !== null);
              };
              const destructiveOf = (el: HTMLElement): boolean =>
                isFormSubmitControlOf(el) || DESTRUCTIVE_KEYWORDS.some(k => rawTextOf(el).includes(k));

              // Try ref_id first for stable targeting
              let el: HTMLElement | null = null;
              if (rId) {
                // @ts-ignore - perception module injected globally
                el = window.__perceptionFindByRefId?.(rId) || null;
                if (el && el.checkVisibility()) {
                  const rect = el.getBoundingClientRect();
                  return {
                    success: true,
                    x: rect.x + rect.width / 2,
                    y: rect.y + rect.height / 2,
                    text: el.textContent?.slice(0, 100) || '',
                    tag: el.tagName.toLowerCase(),
                    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    destructive: destructiveOf(el),
                    label: (el.textContent || '').slice(0, 50),
                  };
                }
              }

              // Fall back to XPath/selector
              let candidates: Element[] = [];
              if (xp) {
                try {
                  const snapshot = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                  for (let i = 0; i < snapshot.snapshotLength; i++) {
                    const node = snapshot.snapshotItem(i);
                    if (node) candidates.push(node as Element);
                  }
                } catch {
                  return { success: false, error: 'Invalid XPath' };
                }
              } else {
                try {
                  candidates = Array.from(document.querySelectorAll(sel));
                } catch {
                  return { success: false, error: 'Invalid selector' };
                }
              }

              // Disambiguate among matches by visible text when a hint is supplied.
              el = (hint
                ? candidates.find(c => (c.textContent || '').toLowerCase().includes(hint.toLowerCase()))
                : candidates[0]) as HTMLElement | null;

              if (!el) return { success: false, error: 'Element not found' };
              if (!el.checkVisibility()) return { success: false, error: 'Element not visible' };

              const rect = el.getBoundingClientRect();
              const tag = el.tagName.toLowerCase();
              const rawText = rawTextOf(el);
              const destructive = destructiveOf(el);

              return {
                success: true,
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
                text: el.textContent?.slice(0, 100) || '',
                tag,
                bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                destructive,
                label: rawText.slice(0, 50),
              };
            },
            args: [selector, xpath, textHint, refId],
          });
        } catch (e) {
          await reportActionResult(context.sessionId, actionHash, false, String(e));
          return { success: false, error: String(e), summary: 'Click failed', navigationOccurred: false };
        }

        const res = probe[0]?.result;
        if (!res || !res.success) {
          await reportActionResult(context.sessionId, actionHash, false, res?.error || 'Click failed');
          return { success: false, error: res?.error || 'Click failed', summary: `Click failed: ${res?.error}`, navigationOccurred: false };
        }

        // Destructive/sensitive click targets require human confirmation before
        // an irreversible write (MOMO-020).
        if (res.destructive && !context.preAuthorized) {
          return {
            success: false,
            error: 'Destructive or sensitive target - requires human confirmation',
            summary: `Click blocked: potentially destructive target "${res.label}"`,
            navigationOccurred: false,
            requiresConfirmation: true,
            confirmationData: {
              origin,
              action: 'click',
              target: selector,
              data: { selector, text: res.text, tag: res.tag },
              reversible: false,
              riskClass: 'dangerous',
            },
          };
        }

        const x = res.x as number;
        const y = res.y as number;

        const sessionId = await context.getCdpSession();
        if (!sessionId) {
          await reportActionResult(context.sessionId, actionHash, false, 'CDP session unavailable');
          return { success: false, error: 'CDP session unavailable', summary: 'Click failed: no CDP session', navigationOccurred: false };
        }

        try {
          // Trusted input via CDP, not a synthetic el.click() (MOMO-019/080).
          await cdpAdapter.dispatchMouseEvent(sessionId, 'mouseMoved', x, y);
          await cdpAdapter.dispatchMouseEvent(sessionId, 'mousePressed', x, y);
          await cdpAdapter.dispatchMouseEvent(sessionId, 'mouseReleased', x, y);
        } catch (e) {
          await reportActionResult(context.sessionId, actionHash, false, String(e));
          return { success: false, error: String(e), summary: 'Click failed', navigationOccurred: false };
        }

        await reportActionResult(context.sessionId, actionHash, true);

        return {
          success: true,
          data: { text: res.text, tag: res.tag, bounds: res.bounds },
          summary: `Clicked "${res.text}" (${res.tag})`,
          navigationOccurred: false,
        };
      },
    });

    // Type - write operation, may be sensitive
    this.register({
      name: 'type',
      description: 'Type text into an input field',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector' },
          text: { type: 'string', description: 'Text to type' },
          clearFirst: { type: 'boolean', default: true },
          pressEnter: { type: 'boolean', default: false },
          ref_id: { type: 'string', description: 'Stable ref_id from perception for targeting' },
        },
        required: ['selector', 'text'],
        additionalProperties: false,
      },
      policy: {
        riskClass: 'write',
        requiresConfirmation: false,
        reversible: false,
        idempotent: false,
        tokenCost: 5,
      },
      execute: async (args, context) => {
        const selector = args.selector as string;
        const text = args.text as string;
        const clearFirst = args.clearFirst as boolean ?? true;
        const pressEnter = args.pressEnter as boolean ?? false;
        const refId = args.ref_id as string | undefined;
        const origin = originOf(context.dom.url);

        // The bridge is the authoritative policy gate for write actions. The
        // typed text is redacted to its length so the secret never reaches the
        // audit log (mirroring the bridge's own SimulateType handling).
        // Include ref_id in arguments for audit trail. When preAuthorized, the
        // human already approved this exact action: skip the bridge so the
        // token ledger is not double-charged.
        let decision: PolicyDecision | null = null;
        let actionHash: string | null = null;
        if (!context.preAuthorized) {
          const auth = await authorizeViaBridge({
            type: 'POLICY_CHECK',
            payload: {
              session_id: context.sessionId,
              action: 'type',
              origin,
              target: refId || selector,
              arguments: { selector, ref_id: refId, text_length: text.length },
              page_revision: context.pageRevision,
            },
          });
          decision = auth.decision;
          actionHash = auth.actionHash;

          if (!decision || !decision.allowed) {
            return {
              success: false,
              error: decision?.reason || 'Bridge unreachable',
              summary: `Type blocked: ${decision?.reason || 'bridge unreachable'}`,
              navigationOccurred: false,
              requiresConfirmation: decision?.requires_confirmation,
            };
          }

          if (decision.requires_confirmation && !context.preAuthorized) {
            return {
              success: false,
              error: 'Requires confirmation',
              summary: 'Type requires confirmation',
              navigationOccurred: false,
              requiresConfirmation: true,
              confirmationData: {
                origin,
                action: 'type',
                target: refId || selector,
                data: { selector, ref_id: refId, text: '[REDACTED]', clearFirst, pressEnter },
                reversible: false,
                riskClass: decision.risk_class,
              },
            };
          }
        }

        // Resolve the field descriptor, verify visibility, and focus it in a
        // single content-script injection (MOMO-118): the sensitive check and the
        // focus happen atomically on the same element so the target cannot be
        // swapped to a sensitive input between the check and the write. The field
        // is NEVER cleared here — clearing happens only after the sensitive gate
        // passes, so a sensitive field's existing value survives a denied attempt.
        // Try ref_id first for stable targeting.
        let probe;
        try {
          probe = await chrome.scripting.executeScript({
            target: { tabId: context.tabId, allFrames: false },
            func: (sel: string, rId: string | undefined) => {
              // Try ref_id first
              let el: HTMLInputElement | HTMLTextAreaElement | null = null;
              if (rId) {
                // @ts-ignore - perception module injected globally
                el = window.__perceptionFindByRefId?.(rId) as HTMLInputElement | HTMLTextAreaElement | null;
              }
              if (!el) {
                el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
              }
              if (!el) return { success: false, error: 'Element not found' };
              if (!el.checkVisibility()) return { success: false, error: 'Element not visible' };

              el.focus();

              return {
                success: true,
                field: {
                  type: el.type || '',
                  autocomplete: el.autocomplete || '',
                  name: el.name || '',
                  id: el.id || '',
                },
              };
            },
            args: [selector, refId],
          });
        } catch (e) {
          await reportActionResult(context.sessionId, actionHash, false, String(e));
          return { success: false, error: String(e), summary: 'Type failed', navigationOccurred: false };
        }

        const res = probe[0]?.result;
        if (!res || !res.success) {
          await reportActionResult(context.sessionId, actionHash, false, res?.error || 'Type failed');
          return { success: false, error: res?.error || 'Type failed', summary: `Type failed: ${res?.error}`, navigationOccurred: false };
        }

        // Sensitive-field gate uses the shared detector (isSensitiveInput) rather
        // than a weaker inline duplicate (MOMO-021/087/088). Only the actual
        // typing (insertText below) and the post-gate clear are gated; nothing
        // mutates the field before this check passes.
        const isSensitive = res.field ? isSensitiveInput(res.field) : true;
        if (isSensitive && !context.preAuthorized) {
          return {
            success: false,
            error: 'Sensitive field detected - requires human confirmation',
            summary: `Type blocked: sensitive field (${res.field?.type})`,
            navigationOccurred: false,
            requiresConfirmation: true,
            confirmationData: {
              origin,
              action: 'type',
              target: selector,
              data: { selector, text: '[REDACTED]', clearFirst, pressEnter },
              reversible: false,
              riskClass: 'auth',
            },
          };
        }

        // The gate passed: now it is safe to clear the field (MOMO-118). A
        // second injection re-resolves the same element (ref-first, then
        // selector), re-checks visibility, then clears it.
        if (clearFirst) {
          let clearProbe;
          try {
            clearProbe = await chrome.scripting.executeScript({
              target: { tabId: context.tabId, allFrames: false },
              func: (sel: string, rId: string | undefined) => {
                let el: HTMLInputElement | HTMLTextAreaElement | null = null;
                if (rId) {
                  // @ts-ignore - perception module injected globally
                  el = window.__perceptionFindByRefId?.(rId) as HTMLInputElement | HTMLTextAreaElement | null;
                }
                if (!el) {
                  el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
                }
                if (!el) return { success: false, error: 'Element not found' };
                if (!el.checkVisibility()) return { success: false, error: 'Element not visible' };
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return { success: true };
              },
              args: [selector, refId],
            });
          } catch (e) {
            await reportActionResult(context.sessionId, actionHash, false, String(e));
            return { success: false, error: String(e), summary: 'Type failed', navigationOccurred: false };
          }
          const clearRes = clearProbe[0]?.result;
          if (!clearRes || !clearRes.success) {
            await reportActionResult(context.sessionId, actionHash, false, clearRes?.error || 'Clear failed');
            return { success: false, error: clearRes?.error || 'Clear failed', summary: `Type failed: ${clearRes?.error || 'clear failed'}`, navigationOccurred: false };
          }
        }

        const sessionId = await context.getCdpSession();
        if (!sessionId) {
          await reportActionResult(context.sessionId, actionHash, false, 'CDP session unavailable');
          return { success: false, error: 'CDP session unavailable', summary: 'Type failed: no CDP session', navigationOccurred: false };
        }

        try {
          // Trusted typing via CDP Input.insertText, not el.value += / synthetic
          // KeyboardEvent (MOMO-080/083).
          await cdpAdapter.insertText(sessionId, text);
          if (pressEnter) {
            await cdpAdapter.dispatchKeyEvent(sessionId, 'Enter', 'keyDown');
            await cdpAdapter.dispatchKeyEvent(sessionId, 'Enter', 'keyUp');
          }
          await reportActionResult(context.sessionId, actionHash, true);
          // Never echo the typed text into the summary (it flows into history/persistence).
          return { success: true, summary: `Typed into ${selector}`, navigationOccurred: false };
        } catch (e) {
          await reportActionResult(context.sessionId, actionHash, false, String(e));
          return { success: false, error: String(e), summary: 'Type failed', navigationOccurred: false };
        }
      },
    });

    // Scroll - read operation
    this.register({
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
    });

    // Extract - read operation with perception (Readability+Turndown)
    this.register({
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
                // @ts-ignore - perception module is injected via content script
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
    });

    // Wait - read operation
    this.register({
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
    });

    // Observe - read operation with perception (Readability+Turndown)
    this.register({
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
              // @ts-ignore - perception module is injected via content script
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
    });

    // Human click - write operation via bridge (trusted events)
    this.register({
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
                // @ts-ignore - perception module injected globally
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
    });

    // Human type - write operation via bridge (trusted events)
    this.register({
      name: 'human_type',
      description: 'Perform human-like typing via CDP Input API (supports ref_id for targeting)',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          ref_id: { type: 'string', description: 'Stable ref_id from perception for targeting' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      policy: {
        riskClass: 'write',
        requiresConfirmation: false,
        reversible: false,
        idempotent: false,
        tokenCost: 5,
      },
      execute: async (args, context) => {
        const text = args.text as string;
        const refId = args.ref_id as string | undefined;
        const origin = originOf(context.dom.url);
        let target = 'focused-element';

        // If ref_id provided, focus that element first
        if (refId) {
          let focusRes;
          try {
            focusRes = await chrome.scripting.executeScript({
              target: { tabId: context.tabId, allFrames: false },
              func: (rId: string) => {
                // @ts-ignore - perception module injected globally
                const el = window.__perceptionFindByRefId?.(rId) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
                if (!el || !el.checkVisibility()) return { success: false, error: 'Element not found or not visible' };
                el.focus();
                return {
                  success: true,
                  type: (el as HTMLInputElement).type || '',
                  autocomplete: (el as HTMLInputElement).autocomplete || '',
                  name: (el as HTMLInputElement).name || '',
                  id: (el as HTMLInputElement).id || '',
                };
              },
              args: [refId],
            });
          } catch (e) {
            return { success: false, error: String(e), summary: 'Human type failed', navigationOccurred: false };
          }
          const res = focusRes[0]?.result;
          if (!res || !res.success) {
            return { success: false, error: res?.error || 'Failed to resolve ref_id', summary: `Human type failed: ${res?.error}`, navigationOccurred: false };
          }
          target = `ref_id(${refId})`;
          const fieldIsSensitive = isSensitiveInput(res);
        }

        // Resolve the currently-focused element so the bridge can make an
        // informed sensitive-field decision for selector-less (focused-element)
        // typing. Fail closed if the active element cannot be inspected.
        let focusedCheck;
        try {
          focusedCheck = await chrome.scripting.executeScript({
            target: { tabId: context.tabId, allFrames: false },
            func: () => {
              const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
              if (!el) return null;
              return {
                type: (el as HTMLInputElement).type || '',
                autocomplete: (el as HTMLInputElement).autocomplete || '',
                name: (el as HTMLInputElement).name || '',
                id: (el as HTMLInputElement).id || '',
              };
            },
          });
        } catch (e) {
          return { success: false, error: String(e), summary: 'Human type failed', navigationOccurred: false };
        }

        const focusedField = focusedCheck[0]?.result;
        const fieldIsSensitive = focusedField ? isSensitiveInput(focusedField) : true;

        // When preAuthorized, the human already approved this exact action:
        // skip the bridge so the token ledger is not double-charged.
        let decision: PolicyDecision | null = null;
        let actionHash: string | null = null;
        if (!context.preAuthorized) {
          const auth = await authorizeViaBridge({
            type: 'SIMULATE_TYPE',
            payload: { session_id: context.sessionId, origin, target, selector: null, text, field_is_sensitive: fieldIsSensitive, page_revision: context.pageRevision },
          });
          decision = auth.decision;
          actionHash = auth.actionHash;

          if (!decision || !decision.allowed) {
            return {
              success: false,
              error: decision?.reason || 'Bridge unreachable',
              summary: `Human type blocked: ${decision?.reason || 'bridge unreachable'}`,
              navigationOccurred: false,
              requiresConfirmation: decision?.requires_confirmation,
            };
          }

          if (decision.requires_confirmation && !context.preAuthorized) {
            return {
              success: false,
              error: 'Requires confirmation',
              summary: 'Human type requires confirmation',
              navigationOccurred: false,
              requiresConfirmation: true,
              confirmationData: { origin, action: 'human_type', target, data: { text: '[REDACTED]' }, reversible: false, riskClass: decision.risk_class },
            };
          }
        }

        const sessionId = await context.getCdpSession();
        if (!sessionId) {
          await reportActionResult(context.sessionId, actionHash, false, 'CDP session unavailable');
          return { success: false, error: 'CDP session unavailable', summary: 'Human type failed: no CDP session', navigationOccurred: false };
        }

        try {
          await cdpAdapter.insertText(sessionId, text);
          await reportActionResult(context.sessionId, actionHash, true);
          // Never echo the typed text into the summary (it flows into history/persistence).
          return { success: true, summary: 'Human typed into focused element', navigationOccurred: false };
        } catch (e) {
          await reportActionResult(context.sessionId, actionHash, false, String(e));
          return { success: false, error: String(e), summary: 'Human type failed', navigationOccurred: false };
        }
      },
    });

    // execute_action — the MCP write tool (PHASE9 §5). Targets an el_XX ref
    // returned by get_interactive_elements; `ref` is the ONLY targeting key, so
    // there is NO raw-CSS-selector fallback. Reuses the click/type executors'
    // CDP dispatch (dispatchMouseEvent / insertText) and the navigate executor.
    // stale_reference is returned as a structured error for the bridge to map to
    // isError:true (M4 wiring).
    this.register({
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
            const navigateTool = this.tools.get('navigate');
            if (!navigateTool) {
              return { success: false, error: 'navigate unavailable', summary: 'execute_action navigate: unavailable', navigationOccurred: false };
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

            const resolved = await this.resolveRefStrict(context.tabId, ref);
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

            const focused = await this.focusRefStrict(context.tabId, ref);
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
    });
  }

  /**
   * Wait for a tab to finish loading, honoring the requested waitUntil level.
   * Resolves on `status === 'complete'` (plus a short settle for `networkidle`),
   * or after the timeout — never rejects.
   */
  private waitForNavigation(tabId: number, waitUntil: string, timeoutMs = 20000): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const listener = (tid: number, info: chrome.tabs.TabChangeInfo) => {
        if (tid !== tabId || info.status !== 'complete') return;
        if (waitUntil === 'networkidle') {
          // Give async requests a short grace period after the load event.
          clearTimeout(timer);
          setTimeout(finish, 500);
        } else {
          finish();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  /** Strict-resolve an el_XX ref to its clickable center (no CSS fallback),
   * computing destructive detection for the resolved element in-page. */
  private async resolveRefStrict(
    tabId: number,
    ref: string,
  ): Promise<{ status: 'ok'; x: number; y: number; destructive: boolean } | { status: 'stale_reference' }> {
    let probe;
    try {
      probe = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: (r: string) => {
          // @ts-ignore - perception module injected globally
          const base = window.__perceptionResolveByRefStrict?.(r);
          if (!base || base.status !== 'ok') return { status: 'stale_reference', ref: r };
          const el = document.querySelector(`[data-momo-ref="${r}"]`) as HTMLElement | null;
          const DESTRUCTIVE_KEYWORDS = [
            'pay', 'buy', 'purchase', 'checkout', 'order', 'confirm', 'submit',
            'delete', 'remove', 'cancel', 'logout', 'sign out', 'signout',
            'deactivate', 'close account', 'unsubscribe', 'transfer', 'refund',
          ];
          let destructive = false;
          if (el) {
            const tag = el.tagName.toLowerCase();
            const inputType = (el as HTMLInputElement).type || '';
            const buttonType = (el as HTMLButtonElement).type || 'submit';
            const rawText = (el.textContent || (el as HTMLInputElement).value || el.getAttribute('aria-label') || el.getAttribute('value') || '').toLowerCase();
            const isFormSubmitControl =
              (tag === 'input' && (inputType === 'submit' || inputType === 'image')) ||
              (tag === 'button' && buttonType === 'submit' && el.closest('form') !== null);
            destructive = isFormSubmitControl || DESTRUCTIVE_KEYWORDS.some(k => rawText.includes(k));
          }
          return { status: 'ok', x: base.x, y: base.y, destructive };
        },
        args: [ref],
      });
    } catch {
      return { status: 'stale_reference' };
    }
    const res = probe[0]?.result as
      | { status: 'ok'; x: number; y: number; destructive: boolean }
      | { status: 'stale_reference' }
      | undefined;
    if (res && res.status === 'ok') return { status: 'ok', x: res.x, y: res.y, destructive: res.destructive };
    return { status: 'stale_reference' };
  }

  /** Strict-resolve an el_XX ref to a focusable input and capture its field descriptor. */
  private async focusRefStrict(
    tabId: number,
    ref: string,
  ): Promise<
    | { status: 'ok'; field: { type: string; autocomplete: string; name: string; id: string } }
    | { status: 'stale_reference' }
  > {
    let probe;
    try {
      probe = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: (r: string) => {
          const el = document.querySelector(`[data-momo-ref="${r}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
          if (!el || !el.isConnected || !el.checkVisibility()) return { status: 'stale_reference', ref: r };
          el.focus();
          return {
            status: 'ok',
            field: { type: el.type || '', autocomplete: el.autocomplete || '', name: el.name || '', id: el.id || '' },
          };
        },
        args: [ref],
      });
    } catch {
      return { status: 'stale_reference' };
    }
    const res = probe[0]?.result as
      | { status: 'ok'; field: { type: string; autocomplete: string; name: string; id: string } }
      | { status: 'stale_reference' }
      | undefined;
    if (res && res.status === 'ok') return { status: 'ok', field: res.field };
    return { status: 'stale_reference' };
  }

  register(definition: ToolDefinition) {
    if (this.tools.has(definition.name)) throw new Error(`Tool already registered: ${definition.name}`);
    this.tools.set(definition.name, definition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getSchemas(): Record<string, unknown>[] {
    return this.getAll().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      policy: t.policy,
    }));
  }

  /**
   * Validate an inbound tool call against its declared JSON-schema parameters
   * (required keys, enums, and primitive types). Returns an error string on
   * failure, or null when the call is well-formed. This is the external-agent
   * ingress gate: untrusted arguments never reach a tool executor.
   */
  validateArguments(toolCall: ToolCall): string | null {
    const tool = this.tools.get(toolCall.name);
    if (!tool) return `Unknown tool: ${toolCall.name}`;

    const schema = tool.parameters as {
      properties?: Record<string, { type?: string; enum?: unknown[] }>;
      required?: string[];
      additionalProperties?: boolean;
    };
    const args = toolCall.arguments ?? {};
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];

    for (const key of required) {
      if (!(key in args) || args[key] === undefined) return `Missing required argument: ${key}`;
    }

    for (const [key, value] of Object.entries(args)) {
      const prop = properties[key];
      if (!prop) {
        if (schema.additionalProperties === false) return `Unexpected argument: ${key}`;
        continue;
      }
      if (value === undefined) continue;

      if (prop.enum && !prop.enum.includes(value)) {
        return `Invalid value for ${key}: expected one of ${JSON.stringify(prop.enum)}`;
      }

      switch (prop.type) {
        case 'string':
          if (typeof value !== 'string') return `Argument ${key} must be a string`;
          break;
        case 'number':
          if (typeof value !== 'number' || !Number.isFinite(value)) return `Argument ${key} must be a finite number`;
          break;
        case 'boolean':
          if (typeof value !== 'boolean') return `Argument ${key} must be a boolean`;
          break;
        case 'object':
          if (typeof value !== 'object' || value === null) return `Argument ${key} must be an object`;
          break;
      }
    }

    return null;
  }
}