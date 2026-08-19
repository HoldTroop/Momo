import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

// perception.ts touches `window` at module scope (the __perception* exports)
// and `document`/`location`/`NodeFilter` at call time. Stub `window` before the
// dynamic import; the individual tests stub the per-call globals.

interface RefResolution {
  status: 'ok' | 'stale_reference';
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  ref?: string;
  hint?: string;
}

interface InteractiveElement {
  ref: string;
  role: string;
  label: string;
  state: string[];
  tag: string;
  bounds: { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number };
}

interface PerceptionModule {
  resolveByRefStrict: (ref: string) => RefResolution;
  getInteractiveElements: () => { url: string; elements: InteractiveElement[] };
}

let mod: PerceptionModule;

beforeAll(async () => {
  vi.stubGlobal('window', {});
  mod = await import('./perception.js');
  vi.unstubAllGlobals(); // window is only needed at module load, not call time
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A minimal fake HTMLElement satisfying isActionable + resolveByRefStrict. */
function makeEl(tag: string, overrides: Record<string, unknown> = {}) {
  return {
    tagName: tag.toUpperCase(),
    type: '',
    getAttribute: () => null,
    hasAttribute: () => false,
    tabIndex: -1,
    onclick: null,
    onkeydown: null,
    isConnected: true,
    checkVisibility: () => true,
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 50, top: 20, right: 110, bottom: 70, left:10 }),
    setAttribute: () => {},
    textContent: '',
    value: '',
    placeholder: '',
    disabled: false,
    checked: false,
    ...overrides,
  } as unknown as HTMLElement;
}

describe('resolveByRefStrict', () => {
  it('resolves an existing actionable ref to its center (ok + coords)', () => {
    vi.stubGlobal('document', { querySelector: () => makeEl('button') });

    const res = mod.resolveByRefStrict('el_1');

    expect(res.status).toBe('ok');
    expect(res.x).toBe(60); // 10 + 100/2
    expect(res.y).toBe(45); // 20 + 50/2
    expect(res.width).toBe(100);
    expect(res.height).toBe(50);
  });

  it('returns stale_reference when the ref is absent (removed)', () => {
    vi.stubGlobal('document', { querySelector: () => null });

    const res = mod.resolveByRefStrict('el_9');

    expect(res.status).toBe('stale_reference');
    expect(res.ref).toBe('el_9');
    expect(res.hint).toBe('re-fetch get_interactive_elements');
  });

  it('returns stale_reference when the element is hidden', () => {
    vi.stubGlobal('document', { querySelector: () => makeEl('button', { checkVisibility: () => false }) });

    expect(mod.resolveByRefStrict('el_1').status).toBe('stale_reference');
  });

  it('returns stale_reference when the element is detached', () => {
    vi.stubGlobal('document', { querySelector: () => makeEl('button', { isConnected: false }) });

    expect(mod.resolveByRefStrict('el_1').status).toBe('stale_reference');
  });

  it('returns stale_reference when the element is not actionable', () => {
    // A bare <div> has no interactive role, no tabindex, no handlers.
    vi.stubGlobal('document', { querySelector: () => makeEl('div') });

    expect(mod.resolveByRefStrict('el_1').status).toBe('stale_reference');
  });

  it('returns stale_reference when the element has zero size', () => {
    const zeroRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 });
    vi.stubGlobal('document', { querySelector: () => makeEl('button', { getBoundingClientRect: zeroRect }) });

    expect(mod.resolveByRefStrict('el_1').status).toBe('stale_reference');
  });
});

describe('getInteractiveElements', () => {
  it('enumerates actionable elements, injects data-momo-ref el_XX, and skips non-actionable', () => {
    const button = makeEl('button', { textContent: '  Save  ' });
    const input = makeEl('input', { type: 'text', placeholder: 'Search' });
    const div = makeEl('div', { textContent: 'ignore me' }); // not actionable → skipped

    const setAttr: Array<[string, string]> = [];
    (button as unknown as { setAttribute: (n: string, v: string) => void }).setAttribute = (n, v) => setAttr.push([n, v]);
    (input as unknown as { setAttribute: (n: string, v: string) => void }).setAttribute = (n, v) => setAttr.push([n, v]);

    const nodes = [button, input, div];
    let idx = 0;
    const walker = {
      currentNode: null as unknown,
      nextNode: () => {
        const node = idx < nodes.length ? nodes[idx] : null;
        walker.currentNode = node;
        idx += 1;
        return node;
      },
    };

    vi.stubGlobal('NodeFilter', { SHOW_ELEMENT: 1 });
    vi.stubGlobal('location', { href: 'https://example.com/page' });
    vi.stubGlobal('document', {
      body: {},
      activeElement: input, // focused → input.state should include 'focused'
      createTreeWalker: () => walker,
      querySelectorAll: () => [], // H35 cleanup finds no stale refs on first run
    });

    const result = mod.getInteractiveElements();

    expect(result.url).toBe('https://example.com/page');
    expect(result.elements).toHaveLength(2); // button + input; div skipped

    const first = result.elements[0]!;
    const second = result.elements[1]!;
    expect(first.ref).toBe('el_1');
    expect(first.role).toBe('button');
    expect(first.label).toBe('Save');
    expect(first.tag).toBe('button');
    expect(first.state).toEqual([]);
    expect(first.bounds.width).toBe(100);

    expect(second.ref).toBe('el_2');
    expect(second.role).toBe('textbox');
    expect(second.label).toBe('Search'); // placeholder fallback (empty text/value)
    expect(second.state).toContain('focused');

    expect(setAttr).toEqual([
      ['data-momo-ref', 'el_1'],
      ['data-momo-ref', 'el_2'],
    ]);
  });

  it('strips stale data-momo-ref tags from prior enumerations and re-tags correctly (H35)', () => {
    // Simulates a re-rendered page: `stale` kept its data-momo-ref="el_9"
    // from a previous enumeration but is no longer enumerated.
    const stale = makeEl('button', { textContent: 'Old' });
    const staleAttrs: Record<string, string> = { 'data-momo-ref': 'el_9', 'data-momo-ref-id': 'momo-9' };
    const staleRemoved: string[] = [];
    (stale as unknown as { setAttribute: (n: string, v: string) => void }).setAttribute = (n, v) => { staleAttrs[n] = v; };
    (stale as unknown as { removeAttribute: (n: string) => void }).removeAttribute = (n) => { staleRemoved.push(n); delete staleAttrs[n]; };

    const fresh = makeEl('button', { textContent: 'New' });
    const freshAttrs: Record<string, string> = {};
    const setAttr: Array<[string, string]> = [];
    (fresh as unknown as { setAttribute: (n: string, v: string) => void }).setAttribute = (n, v) => { freshAttrs[n] = v; setAttr.push([n, v]); };
    (fresh as unknown as { removeAttribute: (n: string) => void }).removeAttribute = (n) => { delete freshAttrs[n]; };

    const nodes = [fresh];
    let idx = 0;
    const walker = {
      currentNode: null as unknown,
      nextNode: () => {
        const node = idx < nodes.length ? nodes[idx] : null;
        walker.currentNode = node;
        idx += 1;
        return node;
      },
    };

    const querySelector = (sel: string): unknown => {
      const m = sel.match(/^\[data-momo-ref="([^"]+)"\]$/);
      if (!m) return null;
      const ref = m[1];
      if (freshAttrs['data-momo-ref'] === ref) return fresh;
      if (staleAttrs['data-momo-ref'] === ref) return stale;
      return null;
    };

    vi.stubGlobal('NodeFilter', { SHOW_ELEMENT: 1 });
    vi.stubGlobal('location', { href: 'https://example.com/page' });
    vi.stubGlobal('document', {
      body: {},
      activeElement: {},
      createTreeWalker: () => walker,
      querySelectorAll: () => [stale],
      querySelector,
    });

    // el_1 was never issued → stale_reference.
    expect(mod.resolveByRefStrict('el_1').status).toBe('stale_reference');
    // Pre-strip, the leftover el_9 tag still (wrongly) resolves. This is the
    // bug the strip fixes.
    expect(mod.resolveByRefStrict('el_9').status).toBe('ok');

    const first = mod.getInteractiveElements();
    expect(first.elements).toHaveLength(1);
    expect(first.elements[0]!.ref).toBe('el_1');
    // Both marker attributes were stripped from the leftover element.
    expect(staleRemoved).toContain('data-momo-ref');
    expect(staleRemoved).toContain('data-momo-ref-id');
    expect(staleAttrs['data-momo-ref']).toBeUndefined();
    expect(staleAttrs['data-momo-ref-id']).toBeUndefined();
    // The fresh element got the counter's first ref.
    expect(freshAttrs['data-momo-ref']).toBe('el_1');

    // Second call: counter resets, element re-tagged, and its ref resolves.
    idx = 0;
    const second = mod.getInteractiveElements();
    expect(second.elements).toHaveLength(1);
    expect(second.elements[0]!.ref).toBe('el_1');
    expect(setAttr).toEqual([
      ['data-momo-ref', 'el_1'],
      ['data-momo-ref', 'el_1'],
    ]);
    expect(mod.resolveByRefStrict('el_1').status).toBe('ok');

    // After stripping, the old el_9 ref no longer resolves to the stale
    // element (would have been the WRONG element before the fix).
    expect(mod.resolveByRefStrict('el_9').status).toBe('stale_reference');
  });
});
