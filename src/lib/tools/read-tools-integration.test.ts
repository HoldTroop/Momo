import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scrollTool } from './scroll.js';
import { extractTool } from './extract.js';
import { waitTool } from './wait.js';
import { observeTool } from './observe.js';
import type { ToolContext } from './types.js';

// Mock the shared utilities
vi.mock('./shared.js', () => ({
  authorizeViaBridge: vi.fn(),
  reportActionResult: vi.fn(),
  deductTokens: vi.fn(),
  originOf: vi.fn(() => 'https://example.com'),
}));

// Mock chrome APIs
vi.mock('chrome', () => ({
  scripting: {
    executeScript: vi.fn(() => Promise.resolve([{ result: { success: true } }])),
  },
}), { virtual: true });

describe('C-01: All Read Tools PolicyEngine Integration', () => {
  let mockContext: ToolContext;
  let mockAuthorizeViaBridge: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    const sharedModule = await import('./shared.js');
    mockAuthorizeViaBridge = sharedModule.authorizeViaBridge;

    mockContext = {
      tabId: 123,
      sessionId: 'test-session',
      dom: { url: 'https://example.com', title: 'Test Page' },
      tokenBudget: { max: 1000, used: 0 },
      pageRevision: 1,
      preAuthorized: false,
      getCdpSession: vi.fn(() => Promise.resolve('session-123')),
    };
  });

  it('should enforce policy on all read tools when denied', async () => {
    // Set up bridge to deny all read operations
    mockAuthorizeViaBridge.mockResolvedValue({
      decision: { 
        allowed: false, 
        reason: 'Read operations denied by policy',
        requires_confirmation: false 
      },
      actionHash: 'denied-hash',
    });

    // Test all read tools are blocked by policy
    const scrollResult = await scrollTool.execute({ direction: 'down' }, mockContext);
    const extractResult = await extractTool.execute({ 
      selector: 'body', 
      schema: { text: { text: true } } 
    }, mockContext);
    const waitResult = await waitTool.execute({ selector: '.element' }, mockContext);
    const observeResult = await observeTool.execute({}, mockContext);

    // All should be blocked
    expect(scrollResult.success).toBe(false);
    expect(scrollResult.error).toBe('Read operations denied by policy');
    
    expect(extractResult.success).toBe(false);
    expect(extractResult.error).toBe('Read operations denied by policy');
    
    expect(waitResult.success).toBe(false);
    expect(waitResult.error).toBe('Read operations denied by policy');
    
    expect(observeResult.success).toBe(false);
    expect(observeResult.error).toBe('Read operations denied by policy');

    // Verify all tools called bridge authorization
    expect(mockAuthorizeViaBridge).toHaveBeenCalledTimes(4);
    
    // Verify specific authorization calls
    expect(mockAuthorizeViaBridge).toHaveBeenCalledWith({
      type: 'POLICY_CHECK',
      payload: expect.objectContaining({
        session_id: 'test-session',
        action: 'scroll',
        origin: 'https://example.com',
      }),
    });
    
    expect(mockAuthorizeViaBridge).toHaveBeenCalledWith({
      type: 'POLICY_CHECK',
      payload: expect.objectContaining({
        session_id: 'test-session',
        action: 'extract',
        origin: 'https://example.com',
      }),
    });
    
    expect(mockAuthorizeViaBridge).toHaveBeenCalledWith({
      type: 'POLICY_CHECK',
      payload: expect.objectContaining({
        session_id: 'test-session',
        action: 'wait',
        origin: 'https://example.com',
      }),
    });
    
    expect(mockAuthorizeViaBridge).toHaveBeenCalledWith({
      type: 'POLICY_CHECK',
      payload: expect.objectContaining({
        session_id: 'test-session',
        action: 'observe',
        origin: 'https://example.com',
      }),
    });
  });

  it('demonstrates C-01 fix: read tools now respect PolicyEngine decisions', async () => {
    // Set up policy that allows some actions but denies others
    mockAuthorizeViaBridge
      .mockResolvedValueOnce({
        decision: { allowed: true, risk_class: 'read' },
        actionHash: 'scroll-allowed',
      })
      .mockResolvedValueOnce({
        decision: { 
          allowed: false, 
          reason: 'Extract denied for sensitive site',
          requires_confirmation: false 
        },
        actionHash: 'extract-denied',
      });

    const scrollResult = await scrollTool.execute({ direction: 'down' }, mockContext);
    const extractResult = await extractTool.execute({ 
      selector: 'body', 
      schema: { text: { text: true } } 
    }, mockContext);

    // Allowed action succeeds (after policy check)
    expect(scrollResult.success).toBe(true);
    
    // Denied action is blocked by policy
    expect(extractResult.success).toBe(false);
    expect(extractResult.error).toBe('Extract denied for sensitive site');
    
    // Both tools consulted the bridge
    expect(mockAuthorizeViaBridge).toHaveBeenCalledTimes(2);
  });

  it('validates C-01 security property: no data extraction from denied origins', async () => {
    // Simulate policy denying access to blocked origin
    mockAuthorizeViaBridge.mockResolvedValue({
      decision: { 
        allowed: false, 
        reason: 'Origin https://example.com not in allowlist',
        requires_confirmation: false 
      },
      actionHash: 'blocked-origin',
    });

    // All read tools should be blocked from extracting data
    const results = await Promise.all([
      scrollTool.execute({ direction: 'down' }, mockContext),
      extractTool.execute({ selector: 'body', schema: { content: { text: true } } }, mockContext),
      waitTool.execute({ selector: '.element' }, mockContext),
      observeTool.execute({ includeMarkdown: true }, mockContext),
    ]);

    // No tool should extract data when origin is denied
    results.forEach(result => {
      expect(result.success).toBe(false);
      expect(result.error).toBe('Origin https://example.com not in allowlist');
    });

    // All tools consulted policy engine
    expect(mockAuthorizeViaBridge).toHaveBeenCalledTimes(4);
  });
});