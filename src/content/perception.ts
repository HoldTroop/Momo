// Perception module using Readability.js + Turndown.js
// Produces Markdown with stable ref_id anchors for element targeting.

import Readability from '@mozilla/readability';
import TurndownService from 'turndown';
import { generateSelector, isActionable } from '../lib/selector.js';

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
    // 1. Clone document to avoid mutating the page
    const clone = document.cloneNode(true) as Document;

    // 2. Readability
    const reader = new Readability(clone);
    const article = reader.parse();

    if (!article) {
      return emptyResult();
    }

    // 3. Annotate interactive elements with stable ref_ids
    const refIdMap: Record<string, string> = {};
    let counter = 0;

    // Walk the original document (not the clone) to attach ref_ids
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

    // 4. Turndown → Markdown (if requested)
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

// Initialize perception on load
console.log('[Perception] Module loaded');

// Expose globally for tool-registry to call
declare global {
  interface Window {
    __perceptionExtract: (includeMarkdown: boolean) => PerceptionResult;
    __perceptionFindByRefId: (refId: string) => HTMLElement | null;
    __perceptionResolveSelector: (selector: string) => { x: number; y: number; element: HTMLElement } | null;
    __perceptionResolveTarget: (refId: string | undefined, selector: string | undefined) => { x: number; y: number; element: HTMLElement } | null;
  }
}

window.__perceptionExtract = extractPerception;
window.__perceptionFindByRefId = findByRefId;
window.__perceptionResolveSelector = resolveSelector;
window.__perceptionResolveTarget = resolveTarget;