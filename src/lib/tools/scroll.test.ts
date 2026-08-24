import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scrollTool } from './scroll.js';
import type { ToolContext } from './types.js';

// Mock the shared utilities
vi.mock('./shared.js', () => ({
  authorizeViaBridge: vi.fn(),
  reportActionResult: vi.fn(),
  deductTokens: vi.fn(),
  originOf: vi.fn(),
}));

// Mock chrome APIs
vi.mock('chrome', () => ({
  scripting: {
    executeScript: vi.fn(),
  },
}), { virtual: true });

describe('C-01: Scroll Tool PolicyEngine Integration', () => {
  let mockContext: ToolContext;
  let mockAuthorizeViaBridge: any;
  let mockReportActionResult: any;
  let mockDeductTokens: any;
  let mockOriginOf: any;
  let mockExecuteScript: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Get the mocked functions
    const sharedModule = await import('./shared.js');
    mockAuthorizeViaBridge = sharedModule.authorizeViaBridge;
    mockReportActionResult = sharedModule.reportActionResult;
    mockDeductTokens = sharedModule.deductTokens;
    mockOriginOf = sharedModule.originOf;
    
    const chromeModule = await import('chrome');
    mockExecuteScript = chromeModule.scripting.executeScript;
    
    mockOriginOf.mockReturnValue('https://example.com');
    mockExecuteScript.mockResolvedValue([{ result: { success: true } }]);

    mockContext = {
      tabId: 123,
      sessionId: 'test-session',
      dom: { url: 'https://example.com', title: 'Test Page' },
      tokenBudget: { max: 100, used: 0 },
      pageRevision: 1,
      preAuthorized: false,
      getCdpSession: vi.fn(() => Promise.resolve('session-123')),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call authorizeViaBridge for policy check', async () => {
    // Set up bridge to allow the action
    mockAuthorizeViaBridge.mockResolvedValue({
      decision: { allowed: true, risk_class: 'read' },
      actionHash: 'test-hash-123',
    });

    await scrollTool.execute({ direction: 'down' }, mockContext);

    // Verify bridge authorization was called
    expect(mockAuthorizeViaBridge).toHaveBeenCalledWith({
      type: 'POLICY_CHECK',
      payload: {
        session_id: 'test-session',
        action: 'scroll',
        origin: 'https://example.com',
        target: 'window',
        arguments: { selector: undefined, direction: 'down', amount: undefined },
        page_revision: 1,
      },
    });
  });

  it('should block scroll when policy denies access', async () => {
    // Set up bridge to deny the action
    mockAuthorizeViaBridge.mockResolvedValue({
      decision: { 
        allowed: false, 
        reason: 'Origin not in allowlist',
        requires_confirmation: false 
      },
      actionHash: 'denied-hash',
    });

    const result = await scrollTool.execute({ direction: 'down' }, mockContext);

    // Verify scroll was blocked
    expect(result.success).toBe(false);
    expect(result.error).toBe('Origin not in allowlist');
    expect(result.summary).toBe('Scroll blocked: Origin not in allowlist');
    
    // Verify chrome script was not executed
    expect(mockExecuteScript).not.toHaveBeenCalled();
    
    // Verify tokens were not deducted
    expect(mockDeductTokens).not.toHaveBeenCalled();
  });

  it('should handle confirmation requirement', async () => {
    // Set up bridge to require confirmation
    mockAuthorizeViaBridge.mockResolvedValue({
      decision: { 
        allowed: true, 
        requires_confirmation: true,
        risk_class: 'read'
      },
      actionHash: 'confirm-hash',
    });

    const result = await scrollTool.execute({ direction: 'down' }, mockContext);

    // Verify confirmation is required
    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationData).toEqual({
      origin: 'https://example.com',
      action: 'scroll',
      target: 'window',
      data: { selector: undefined, direction: 'down', amount: undefined },
      reversible: true,
      riskClass: 'read',
    });
    
    // Verify execution was blocked
    expect(mockExecuteScript).not.toHaveBeenCalled();
  });

  it('should report action results to bridge', async () => {
    // Set up successful authorization
    mockAuthorizeViaBridge.mockResolvedValue({
      decision: { allowed: true, risk_class: 'read' },
      actionHash: 'success-hash',
    });

    await scrollTool.execute({ direction: 'down' }, mockContext);

    // Verify success was reported to bridge
    expect(mockReportActionResult).toHaveBeenCalledWith(
      'test-session',
      'success-hash',
      true
    );
  });

  it('should skip authorization when preAuthorized', async () => {
    mockContext.preAuthorized = true;

    const result = await scrollTool.execute({ direction: 'down' }, mockContext);

    // Should succeed without calling bridge
    expect(result.success).toBe(true);
    expect(mockAuthorizeViaBridge).not.toHaveBeenCalled();
    expect(mockDeductTokens).toHaveBeenCalledWith(mockContext.tokenBudget, 1);
  });

  it('should handle bridge unreachable scenario', async () => {
    // Simulate bridge being unreachable
    mockAuthorizeViaBridge.mockResolvedValue({
      decision: null,
      actionHash: null,
    });

    const result = await scrollTool.execute({ direction: 'down' }, mockContext);

    // Should be blocked when bridge is unreachable
    expect(result.success).toBe(false);
    expect(result.error).toBe('Bridge unreachable');
    expect(result.summary).toBe('Scroll blocked: bridge unreachable');
  });
});