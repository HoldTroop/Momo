import { describe, it, expect } from 'vitest';
import { DomCompressor } from './dom-compressor.js';

// BUG 3 (second half): CDP AX nodes carry no bounding rect, and isVisible()
// treated a missing rect as "invisible", so every actionable element was
// silently dropped. These tests pin the corrected contract: a missing rect is
// "geometry unknown" (kept), while explicit hidden signals still filter.

// Node's runtime (vitest default env) has no CSS namespace; provide a minimal
// CSS.escape so the selector generation under test can run here. Browsers
// (content scripts and service worker) ship the real CSS.escape.
if (typeof (globalThis as { CSS?: unknown }).CSS === 'undefined') {
  (globalThis as { CSS: { escape: (value: string) => string } }).CSS = {
    escape(value: string): string {
      return value.replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => '\\' + ch);
    },
  };
}

interface AxNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  states: string[];
  attributes: Record<string, string>;
  childIds: number[];
  backendDOMNodeId: number;
  rect?: { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number };
}

function node(overrides: Partial<AxNode> = {}): AxNode {
  return {
    role: 'button',
    name: 'Save',
    value: '',
    description: '',
    states: [],
    attributes: { id: 'btn' },
    childIds: [],
    backendDOMNodeId: 1,
    ...overrides,
  };
}

function rect(width: number, height: number) {
  return { x: 0, y: 0, width, height, top: 0, right: width, bottom: height, left: 0 };
}

describe('DomCompressor.isVisible (missing-rect fix)', () => {
  it('keeps a CDP AX node with no rect (unknown geometry is not hidden)', () => {
    const dom = new DomCompressor().compress({ nodes: [node()] }, 'http://x.test/', 'T');
    expect(dom.actions).toHaveLength(1);
  });

  it('filters a node explicitly marked invisible even with a rect', () => {
    const dom = new DomCompressor().compress(
      { nodes: [node({ states: ['invisible'], rect: rect(100, 40) })] },
      'http://x.test/',
      'T',
    );
    expect(dom.actions).toHaveLength(0);
  });

  it('filters a zero-size rect node', () => {
    const dom = new DomCompressor().compress(
      { nodes: [node({ rect: rect(0, 0) })] },
      'http://x.test/',
      'T',
    );
    expect(dom.actions).toHaveLength(0);
  });

  it('filters a node with display:none', () => {
    const dom = new DomCompressor().compress(
      { nodes: [node({ attributes: { id: 'btn', display: 'none' }, rect: rect(100, 40) })] },
      'http://x.test/',
      'T',
    );
    expect(dom.actions).toHaveLength(0);
  });
});

describe('DomCompressor selector generation (role-to-tag + CSS escaping)', () => {
  it('uses role-to-tag mapping instead of emitting raw roles in the selector path', () => {
    const parent = node({
      role: 'generic',
      name: 'Root',
      backendDOMNodeId: 1,
      childIds: [2],
      attributes: {},
    });
    const textbox = node({
      role: 'textbox',
      name: 'Search',
      backendDOMNodeId: 2,
      childIds: [],
      attributes: {},
    });

    const dom = new DomCompressor().compress({ nodes: [parent, textbox] }, 'http://x.test/', 'T');

    expect(dom.actions).toHaveLength(1);
    const selector = dom.actions[0]!.selector;
    expect(selector).toContain('input');
    expect(selector).not.toContain('textbox >');
    expect(selector).not.toContain('generic');
  });

  it('CSS-escapes special characters in class names', () => {
    const el = node({ attributes: { class: 'md:flex w-1/2' } });

    const dom = new DomCompressor().compress({ nodes: [el] }, 'http://x.test/', 'T');

    expect(dom.actions).toHaveLength(1);
    expect(dom.actions[0]!.selector).toContain('.md\\:flex');
  });
});
