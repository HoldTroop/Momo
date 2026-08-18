import { describe, it, expect } from 'vitest';
import { DomCompressor } from './dom-compressor.js';

// BUG 3 (second half): CDP AX nodes carry no bounding rect, and isVisible()
// treated a missing rect as "invisible", so every actionable element was
// silently dropped. These tests pin the corrected contract: a missing rect is
// "geometry unknown" (kept), while explicit hidden signals still filter.

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
