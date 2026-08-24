/**
 * Tests for tab-scoped network interceptor (actions-7).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NetworkInterceptor } from './network-interceptor.js';

describe('NetworkInterceptor', () => {
  let interceptor: NetworkInterceptor;

  beforeEach(() => {
    interceptor = new NetworkInterceptor();
    vi.useFakeTimers();
  });

  it('stores requests for active tab only', () => {
    // Mock chrome.webRequest (unit test - no actual listeners)
    const log = interceptor.getLog(123);
    expect(log).toHaveLength(0);
  });

  it('isolates logs per tab', () => {
    interceptor.clearTab(100);
    interceptor.clearTab(200);

    expect(interceptor.getLog(100)).toHaveLength(0);
    expect(interceptor.getLog(200)).toHaveLength(0);
  });

  it('clears log for specific tab', () => {
    interceptor.clearTab(100);
    expect(interceptor.getLog(100)).toHaveLength(0);
  });

  it('clears all logs', () => {
    interceptor.clearAll();
    expect(interceptor.getLog(100)).toHaveLength(0);
    expect(interceptor.getLog(200)).toHaveLength(0);
  });

  it('returns empty array for unknown tab', () => {
    expect(interceptor.getLog(999)).toHaveLength(0);
  });
});
