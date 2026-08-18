// Perception module using Readability.js + Turndown.js
// Produces Markdown with stable ref_id anchors for element targeting.

import Readability from '@mozilla/readability';
import TurndownService from 'turndown';
import { generateSelector, isActionable, getImplicitRole } from '../lib/selector.js';
import { isSensitiveInput } from '../lib/redaction.js';

export interface PerceptionResult {
  markdown_content: string;
  ref_id_map: Record<string, string>;
  title: string;
  url: string;
  timestamp: number;
}

let turndownService: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (!turndownService) {
    turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });
  }
  return turndownService;
}

/**
 * Extract perception from the current page.
 * Clones the document to avoid mutating the page.
 */
export function extractPerception(includeMarkdown: boolean = true): PerceptionResult {
  try {
    // 1. Annotate interactive elements with stable ref_ids on the LIVE DOM
    //    first, so the clone taken below captures the same refs that a later
    //    resolve-by-ref will match (BUG 4). The reading layer deliberately does
    //    NOT render these refs into Markdown — refs are for action targeting.
    const refIdMap: Record<string, string> = {};
    let counter = 0;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT
    );

    while (walker.nextNode()) {
      const el = walker.currentNode as HTMLElement;
      if (isActionable(el)) {
        const refId = `momo-${++counter}`;
        el.dataset.momoRefId = refId;
        const selector = generateSelector(el);
        if (selector) {
          refIdMap[selector] = refId;
        }
      }
    }

    // 2. Clone the (now annotated) document for the reading pass. Readability
    //    mutates its input, so it runs on a clone rather than the live page.
    const clone = document.cloneNode(true) as Document;

    // 3. Readability → Turndown on the clone.
    const reader = new Readability(clone);
    const article = reader.parse();

    if (!article) {
      return emptyResult();
    }

    let markdown = '';
    if (includeMarkdown && article.content) {
      const turndown = getTurndown();
      markdown = turndown.turndown(article.content);
    }

    return {
      markdown_content: markdown,
      ref_id_map: refIdMap,
      title: article.title || document.title || '',
      url: location.href,
      timestamp: Date.now(),
    };
  } catch (e) {
    console.error('[Perception] Extraction failed:', e);
    return emptyResult();
  }
}

function emptyResult(): PerceptionResult {
  return {
    markdown_content: '',
    ref_id_map: {},
    title: document.title || '',
    url: location.href,
    timestamp: Date.now(),
  };
}

/**
 * Find an element by its ref_id.
 */
export function findByRefId(refId: string): HTMLElement | null {
  return document.querySelector(`[data-momo-ref-id="${refId}"]`) as HTMLElement | null;
}

/**
 * Resolve a selector to coordinates for click/type actions.
 * Used by the content script when executing actions.
 */
export function resolveSelector(selector: string): { x: number; y: number; element: HTMLElement } | null {
  try {
    const el = document.querySelector(selector) as HTMLElement;
    if (!el || !el.checkVisibility()) return null;

    const rect = el.getBoundingClientRect();
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      element: el,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve by ref_id first, then fall back to selector.
 */
export function resolveTarget(refId: string | undefined, selector: string | undefined): { x: number; y: number; element: HTMLElement } | null {
  if (refId) {
    const el = findByRefId(refId);
    if (el && el.checkVisibility()) {
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, element: el };
    }
  }
  if (selector) {
    return resolveSelector(selector);
  }
  return null;
}

// --- Hybrid perception layer (Phase 9 M3) ------------------------------------
// A parallel, *additive* element index keyed by `data-momo-ref="el_XX"`. It is
// deliberately distinct from `data-momo-ref-id="momo-N"` (set by
// extractPerception): MCP's execute_action targets el_XX refs via
// resolveByRefStrict, which does NOT fall back to raw CSS selectors.

export interface InteractiveElement {
  ref: string;
  role: string;
  label: string;
  state: string[];
  tag: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

export interface InteractiveElementsResult {
  url: string;
  elements: InteractiveElement[];
}

export type RefResolution =
  | { status: 'ok'; x: number; y: number; width: number; height: number }
  | { status: 'stale_reference'; ref: string; hint: string };

/** aria-label → textContent (≤100 chars) → value → placeholder. */
function computeLabel(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();

  const text = (el.textContent || '').trim();
  if (text) return text.slice(0, 100);

  const input = el as HTMLInputElement;
  // A sensitive field's value must never leak into the label; placeholder is
  // static metadata and is safe (mirrors the AX extractor's isSensitive guard).
  if (
    input.value &&
    !isSensitiveInput({ type: input.type, autocomplete: input.autocomplete, name: input.name, id: input.id })
  ) {
    return input.value.slice(0, 100);
  }
  return (input.placeholder || '').slice(0, 100);
}

function computeState(el: HTMLElement): string[] {
  const state: string[] = [];
  if (el.hasAttribute('disabled') || (el as HTMLInputElement).disabled) state.push('disabled');
  if (el.hasAttribute('required')) state.push('required');
  if (el.hasAttribute('readonly')) state.push('readonly');
  if ((el as HTMLInputElement).checked === true) state.push('checked');
  if (el.getAttribute('aria-invalid') === 'true') state.push('aria-invalid');
  if (el === document.activeElement) state.push('focused');
  return state;
}

/**
 * Enumerate visible, actionable elements and tag each with a fresh
 * `data-momo-ref="el_XX"` attribute (counter resets per call). Returns role,
 * label, state, and bounds so an external agent can decide what to target.
 */
export function getInteractiveElements(): InteractiveElementsResult {
  const elements: InteractiveElement[] = [];
  let counter = 0;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const el = walker.currentNode as HTMLElement;
    if (!isActionable(el) || !el.checkVisibility()) continue;

    const ref = `el_${++counter}`;
    // Additive: inject alongside the existing data-momo-ref-id. Do NOT migrate
    // or touch the old attribute.
    el.setAttribute('data-momo-ref', ref);

    const rect = el.getBoundingClientRect();
    elements.push({
      ref,
      role: el.getAttribute('role') || getImplicitRole(el),
      label: computeLabel(el),
      state: computeState(el),
      tag: el.tagName.toLowerCase(),
      bounds: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      },
    });
  }

  return { url: location.href, elements };
}

/**
 * Resolve an el_XX ref strictly: no CSS-selector fallback. Any of missing,
 * detached, hidden, non-actionable, or zero-sized yields `stale_reference`,
 * telling the caller to re-fetch get_interactive_elements (M4 recovery).
 */
export function resolveByRefStrict(ref: string): RefResolution {
  const stale = (): RefResolution => ({ status: 'stale_reference', ref, hint: 're-fetch get_interactive_elements' });

  const el = document.querySelector(`[data-momo-ref="${ref}"]`) as HTMLElement | null;
  if (!el || !el.isConnected || !el.checkVisibility() || !isActionable(el)) {
    return stale();
  }

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return stale();
  }

  return {
    status: 'ok',
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    width: rect.width,
    height: rect.height,
  };
}

// Initialize perception on load
console.log('[Perception] Module loaded');

// Expose globally for tool-registry to call
declare global {
  interface Window {
    __perceptionExtract: (includeMarkdown: boolean) => PerceptionResult;
    __perceptionFindByRefId: (refId: string) => HTMLElement | null;
    __perceptionResolveSelector: (selector: string) => { x: number; y: number; element: HTMLElement } | null;
    __perceptionResolveTarget: (refId: string | undefined, selector: string | undefined) => { x: number; y: number; element: HTMLElement } | null;
    __perceptionGetInteractiveElements: () => InteractiveElementsResult;
    __perceptionResolveByRefStrict: (ref: string) => RefResolution;
  }
}

window.__perceptionExtract = extractPerception;
window.__perceptionFindByRefId = findByRefId;
window.__perceptionResolveSelector = resolveSelector;
window.__perceptionResolveTarget = resolveTarget;
window.__perceptionGetInteractiveElements = getInteractiveElements;
window.__perceptionResolveByRefStrict = resolveByRefStrict;