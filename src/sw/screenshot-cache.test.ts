/**
 * Tests for ephemeral screenshot cache (actions-6).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ScreenshotCache } from './screenshot-cache.js';

describe('ScreenshotCache', () => {
  let cache: ScreenshotCache;

  beforeEach(() => {
    cache = new ScreenshotCache();
  });

  it('stores and retrieves a screenshot', () => {
    const blob = new Blob(['test'], { type: 'image/png' });
    const ref_id = cache.store(blob, 123, 'https://example.com');

    expect(ref_id).toMatch(/^screenshot_\d+_[a-z0-9]+$/);
    expect(cache.get(ref_id)).toBe(blob);
  });

  it('returns null for unknown ref_id', () => {
    expect(cache.get('unknown')).toBeNull();
  });

  it('stores metadata separately from blob', () => {
    const blob = new Blob(['test'], { type: 'image/png' });
    const ref_id = cache.store(blob, 456, 'https://test.com');

    const meta = cache.getMetadata(ref_id);
    expect(meta).toMatchObject({
      ref_id,
      tabId: 456,
      url: 'https://test.com',
    });
    expect(meta?.timestamp).toBeGreaterThan(0);
  });

  it('clears screenshots for a specific tab', () => {
    const blob1 = new Blob(['tab1'], { type: 'image/png' });
    const blob2 = new Blob(['tab2'], { type: 'image/png' });
    const ref1 = cache.store(blob1, 100, 'https://a.com');
    const ref2 = cache.store(blob2, 200, 'https://b.com');

    cache.clearTab(100);

    expect(cache.get(ref1)).toBeNull();
    expect(cache.get(ref2)).toBe(blob2);
  });

  it('clears all screenshots', () => {
    const blob1 = new Blob(['a'], { type: 'image/png' });
    const blob2 = new Blob(['b'], { type: 'image/png' });
    const ref1 = cache.store(blob1, 100, 'https://a.com');
    const ref2 = cache.store(blob2, 200, 'https://b.com');

    cache.clearAll();

    expect(cache.get(ref1)).toBeNull();
    expect(cache.get(ref2)).toBeNull();
    expect(cache.listMetadata()).toHaveLength(0);
  });

  it('lists all metadata', () => {
    cache.store(new Blob(['a'], { type: 'image/png' }), 1, 'https://a.com');
    cache.store(new Blob(['b'], { type: 'image/png' }), 2, 'https://b.com');

    const list = cache.listMetadata();
    expect(list).toHaveLength(2);
    expect(list[0]?.tabId).toBe(1);
    expect(list[1]?.tabId).toBe(2);
  });
});
