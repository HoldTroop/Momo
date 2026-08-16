import { ToolCall, ToolResult, CompressedDom } from '../sw/orchestrator.js';
import { cdpAdapter } from '../sw/cdp-adapter.js';

export type RiskClass = 'read' | 'write' | 'navigation' | 'payment' | 'auth' | 'dangerous';

export interface ToolPolicy {
  riskClass: RiskClass;
  requiresConfirmation: boolean;
  allowedOrigins?: string[];
  dataClassification: 'public' | 'internal' | 'confidential' | 'restricted';
  reversible: boolean;
  idempotent: boolean;
  tokenCost: number;
}

export interface ToolContext {
  dom: CompressedDom;
  variables: Record<string, unknown>;
  step: ToolCall;
  allowlist: string[];
  tokenBudget: { max: number; used: number };
  pageRevision: number;
  sessionId: string;
  tabId: number;
  getCdpSession: () => Promise<string | null>;
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

/** Send an authorization request to the bridge and return its policy decision (null if unreachable). */
async function authorizeViaBridge(request: Record<string, unknown>): Promise<PolicyDecision | null> {
  try {
    const response = await chrome.runtime.sendNativeMessage('agent.bridge', request);
    return (response?.payload?.data as PolicyDecision) ?? null;
  } catch (e) {
    console.warn('[ToolRegistry] Bridge authorize failed:', e);
    return null;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

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
        dataClassification: 'public',
        reversible: true, // can navigate back
        idempotent: true,
        tokenCost: 100,
      },
      execute: async (args, context) => {
        deductTokens(context.tokenBudget, 100);

        const url = args.url as string;
        const waitUntil = args.waitUntil as string || 'networkidle';

        // The bridge is the authoritative policy boundary for navigation.
        const decision = await authorizeViaBridge({
          type: 'POLICY_CHECK',
          payload: {
            session_id: context.sessionId,
            action: 'navigate',
            origin: originOf(context.dom.url),
            target: url,
            arguments: { url },
          },
        });

        if (!decision || !decision.allowed) {
          return {
            success: false,
            error: decision?.reason || 'Bridge unreachable',
            summary: `Navigation blocked: ${decision?.reason || 'bridge unreachable'}`,
            navigationOccurred: false,
            requiresConfirmation: decision?.requires_confirmation,
          };
        }

        await chrome.tabs.update({ url });

        // Wait for navigation
        await new Promise(resolve => setTimeout(resolve, 2000));

        return {
          success: true,
          summary: `Navigated to ${url}`,
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
        },
        required: ['selector'],
        additionalProperties: false,
      },
      policy: {
        riskClass: 'write',
        requiresConfirmation: false,
        dataClassification: 'public',
        reversible: false, // clicks are generally not reversible
        idempotent: false,
        tokenCost: 10,
      },
      execute: async (args, context) => {
        deductTokens(context.tokenBudget, 10);

        const selector = args.selector as string;

        const result = await chrome.scripting.executeScript({
          target: { tabId: context.tabId, allFrames: false },
          func: (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) return { success: false, error: 'Element not found' };
            if (!el.checkVisibility()) return { success: false, error: 'Element not visible' };

            const rect = el.getBoundingClientRect();
            el.click();

            return {
              success: true,
              text: el.textContent?.slice(0, 100) || '',
              tag: el.tagName.toLowerCase(),
              bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
          },
          args: [selector],
        });

        const res = result[0]?.result;
        if (!res?.success) {
          return { success: false, error: res?.error || 'Click failed', summary: `Click failed: ${res?.error}`, navigationOccurred: false };
        }

        return {
          success: true,
          data: res,
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
        },
        required: ['selector', 'text'],
        additionalProperties: false,
      },
      policy: {
        riskClass: 'write',
        requiresConfirmation: false, // content script can detect password fields
        dataClassification: 'confidential', // typed text may be sensitive
        reversible: false,
        idempotent: false,
        tokenCost: 5,
      },
      execute: async (args, context) => {
        deductTokens(context.tokenBudget, 5);

        const selector = args.selector as string;
        const text = args.text as string;
        const clearFirst = args.clearFirst as boolean ?? true;
        const pressEnter = args.pressEnter as boolean ?? false;

        // Check if target is a sensitive field (password, credit card, etc.)
        const sensitiveCheck = await chrome.scripting.executeScript({
          target: { tabId: context.tabId, allFrames: false },
          func: (sel: string) => {
            const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
            if (!el) return { isSensitive: false };
            const type = (el.type || '').toLowerCase();
            const autocomplete = (el.autocomplete || '').toLowerCase();
            return {
              isSensitive: type === 'password' || autocomplete.includes('cc-') || autocomplete.includes('secret'),
              type,
              autocomplete,
            };
          },
          args: [selector],
        });

        const isSensitive = sensitiveCheck[0]?.result?.isSensitive;
        if (isSensitive) {
          return {
            success: false,
            error: 'Sensitive field detected - requires human confirmation',
            summary: `Type blocked: sensitive field (${sensitiveCheck[0]?.result?.type})`,
            navigationOccurred: false,
            requiresConfirmation: true,
            confirmationData: {
              origin: new URL(context.dom.url).origin,
              action: 'type',
              target: selector,
              data: { selector, text: '[REDACTED]', clearFirst, pressEnter },
              reversible: false,
              riskClass: 'auth',
            },
          };
        }

        const result = await chrome.scripting.executeScript({
          target: { tabId: context.tabId, allFrames: false },
          func: (sel: string, txt: string, clear: boolean, enter: boolean) => {
            const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
            if (!el) return { success: false, error: 'Element not found' };
            if (!el.checkVisibility()) return { success: false, error: 'Element not visible' };

            if (clear) el.value = '';
            el.value += txt;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));

            if (enter) {
              el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
            }

            // Do not return the field value: it may contain the just-typed secret
            // and would flow into history/persistence.
            return { success: true };
          },
          args: [selector, text, clearFirst, pressEnter],
        });

        const res = result[0]?.result;
        if (!res?.success) {
          return { success: false, error: res?.error || 'Type failed', summary: `Type failed: ${res?.error}`, navigationOccurred: false };
        }

        return {
          success: true,
          data: res,
          summary: `Typed into ${selector}`,
          navigationOccurred: false,
        };
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
        dataClassification: 'public',
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

    // Extract - read operation
    this.register({
      name: 'extract',
      description: 'Extract structured data from page',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector' },
          schema: { type: 'object', description: 'JSON schema for extraction' },
          multiple: { type: 'boolean', default: false },
        },
        required: ['selector', 'schema'],
        additionalProperties: false,
      },
      policy: {
        riskClass: 'read',
        requiresConfirmation: false,
        dataClassification: 'internal', // extracted data may be private
        reversible: true,
        idempotent: true,
        tokenCost: 20,
      },
      execute: async (args, context) => {
        deductTokens(context.tokenBudget, 20);

        const selector = args.selector as string;
        const schema = args.schema as Record<string, { selector?: string; attribute?: string; text?: boolean }>;
        const multiple = args.multiple as boolean ?? false;

        const result = await chrome.scripting.executeScript({
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
        });

        const data = result[0]?.result || [];

        return {
          success: true,
          data,
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
        dataClassification: 'public',
        reversible: true,
        idempotent: true,
        tokenCost: 5,
      },
      execute: async (args, context) => {
        deductTokens(context.tokenBudget, 5);

        const selector = args.selector as string;
        const condition = args.condition as string || 'visible';
        const timeout = args.timeout as number || 5000;

        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
          const result = await chrome.scripting.executeScript({
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

          if (result[0]?.result === true) {
            return { success: true, summary: `Condition "${condition}" met for ${selector}`, navigationOccurred: false };
          }

          await new Promise(resolve => setTimeout(resolve, 100));
        }

        return { success: false, error: `Timeout waiting for ${condition} on ${selector}`, summary: `Wait timeout`, navigationOccurred: false };
      },
    });

    // Observe - read operation
    this.register({
      name: 'observe',
      description: 'Get current page state',
      parameters: {
        type: 'object',
        properties: {
          includeScreenshot: { type: 'boolean', default: false },
        },
        additionalProperties: false,
      },
      policy: {
        riskClass: 'read',
        requiresConfirmation: false,
        dataClassification: 'public',
        reversible: true,
        idempotent: true,
        tokenCost: 50,
      },
      execute: async (args, context) => {
        deductTokens(context.tokenBudget, 50);
        return {
          success: true,
          data: context.dom,
          summary: `Observed page: ${context.dom.title}`,
          navigationOccurred: false,
        };
      },
    });

    // Human click - write operation via bridge (trusted events)
    this.register({
      name: 'human_click',
      description: 'Perform human-like click at coordinates via CDP Input API',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      policy: {
        riskClass: 'write',
        requiresConfirmation: false,
        dataClassification: 'public',
        reversible: false,
        idempotent: false,
        tokenCost: 10,
      },
      execute: async (args, context) => {
        deductTokens(context.tokenBudget, 10);

        const x = args.x as number;
        const y = args.y as number;
        const origin = originOf(context.dom.url);
        const target = `coords(${x},${y})`;

        // The bridge is the authoritative policy gate: never dispatch a trusted
        // input without an explicit `allowed` decision.
        const decision = await authorizeViaBridge({
          type: 'SIMULATE_CLICK',
          payload: { session_id: context.sessionId, origin, target, x, y },
        });

        if (!decision || !decision.allowed) {
          return {
            success: false,
            error: decision?.reason || 'Bridge unreachable',
            summary: `Human click blocked: ${decision?.reason || 'bridge unreachable'}`,
            navigationOccurred: false,
            requiresConfirmation: decision?.requires_confirmation,
          };
        }

        if (decision.requires_confirmation) {
          return {
            success: false,
            error: 'Requires confirmation',
            summary: 'Human click requires confirmation',
            navigationOccurred: false,
            requiresConfirmation: true,
            confirmationData: { origin, action: 'human_click', target, data: { x, y }, reversible: false, riskClass: decision.risk_class },
          };
        }

        const sessionId = await context.getCdpSession();
        if (!sessionId) {
          return { success: false, error: 'CDP session unavailable', summary: 'Human click failed: no CDP session', navigationOccurred: false };
        }

        try {
          await cdpAdapter.dispatchMouseEvent(sessionId, 'mousePressed', x, y);
          await cdpAdapter.dispatchMouseEvent(sessionId, 'mouseReleased', x, y);
          return { success: true, summary: `Human click at (${x}, ${y})`, navigationOccurred: false };
        } catch (e) {
          return { success: false, error: String(e), summary: 'Human click failed', navigationOccurred: false };
        }
      },
    });

    // Human type - write operation via bridge (trusted events)
    this.register({
      name: 'human_type',
      description: 'Perform human-like typing via CDP Input API',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      policy: {
        riskClass: 'write',
        requiresConfirmation: false,
        dataClassification: 'confidential',
        reversible: false,
        idempotent: false,
        tokenCost: 5,
      },
      execute: async (args, context) => {
        deductTokens(context.tokenBudget, 5);

        const text = args.text as string;
        const origin = originOf(context.dom.url);
        const target = 'focused-element';

        const decision = await authorizeViaBridge({
          type: 'SIMULATE_TYPE',
          payload: { session_id: context.sessionId, origin, target, selector: null, text },
        });

        if (!decision || !decision.allowed) {
          return {
            success: false,
            error: decision?.reason || 'Bridge unreachable',
            summary: `Human type blocked: ${decision?.reason || 'bridge unreachable'}`,
            navigationOccurred: false,
            requiresConfirmation: decision?.requires_confirmation,
          };
        }

        if (decision.requires_confirmation) {
          return {
            success: false,
            error: 'Requires confirmation',
            summary: 'Human type requires confirmation',
            navigationOccurred: false,
            requiresConfirmation: true,
            confirmationData: { origin, action: 'human_type', target, data: { text: '[REDACTED]' }, reversible: false, riskClass: decision.risk_class },
          };
        }

        const sessionId = await context.getCdpSession();
        if (!sessionId) {
          return { success: false, error: 'CDP session unavailable', summary: 'Human type failed: no CDP session', navigationOccurred: false };
        }

        try {
          await cdpAdapter.insertText(sessionId, text);
          // Never echo the typed text into the summary (it flows into history/persistence).
          return { success: true, summary: 'Human typed into focused element', navigationOccurred: false };
        } catch (e) {
          return { success: false, error: String(e), summary: 'Human type failed', navigationOccurred: false };
        }
      },
    });
  }

  register(definition: ToolDefinition) {
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
}