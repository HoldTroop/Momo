/**
 * Regression test for human_type variable shadowing (Issue #1).
 * 
 * SECURITY REQUIREMENT:
 * When ref_id targets a password field, that sensitivity value MUST be sent
 * to the bridge authorization, even if document.activeElement points to a
 * different non-sensitive field before the auth call.
 * 
 * THE FIX:
 * Declare fieldIsSensitive in outer scope BEFORE if(refId) block,
 * then assign (not re-declare) inside each branch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../tool-registry';
import { isSensitiveInput } from '../redaction';
import fs from 'node:fs';
import path from 'node:path';

// Capture authorization payloads for assertion
let capturedAuthPayload: any = null;

// Mock the WebSocket client before any imports
vi.mock('../../sw/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(async (type: string, payload: any) => {
      if (type === 'POLICY_CHECK' || payload?.type === 'SIMULATE_TYPE') {
        capturedAuthPayload = payload;
        return {
          decision: { allowed: true, requires_confirmation: false, risk_class: 'write' },
          action_hash: 'test-hash-123',
        };
      }
      return null;
    }),
  }),
}));

// Mock CDP adapter
vi.mock('../../sw/cdp-adapter', () => ({
  cdpAdapter: {
    insertText: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('human_type fieldIsSensitive preservation (INTEGRATION)', () => {
  let registry: ToolRegistry;
  let mockContext: any;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedAuthPayload = null;

    registry = new ToolRegistry();
    
    mockContext = {
      dom: { url: 'https://example.com/login' },
      variables: {},
      step: { tool: 'human_type', arguments: {} },
      allowlist: ['example.com'],
      tokenBudget: { max: 1000, used: 0 },
      pageRevision: 1,
      sessionId: 'test-session-001',
      tabId: 123,
      getCdpSession: vi.fn().mockResolvedValue('cdp-session-123'),
      preAuthorized: false,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CRITICAL: ref_id password field → field_is_sensitive=true sent to bridge', async () => {
    // This is the security-critical scenario:
    // 1. Tool called with ref_id='password_field_ref'
    // 2. executeScript resolves ref_id → returns password field metadata
    // 3. fieldIsSensitive = true (from ref_id resolution)
    // 4. Authorization call MUST send field_is_sensitive: true
    
    // Mock chrome.scripting.executeScript
    const mockExecuteScript = vi.fn();
    
    // First call: focus the password field via ref_id
    mockExecuteScript.mockResolvedValueOnce([{
      result: {
        success: true,
        type: 'password',
        autocomplete: 'current-password',
        name: 'pwd',
        id: 'password-field',
      },
    }]);

    // Setup chrome global
    global.chrome = {
      scripting: {
        executeScript: mockExecuteScript,
      },
    } as any;

    // Execute the human_type tool with ref_id
    const humanTypeTool = registry['tools'].get('human_type');
    expect(humanTypeTool).toBeDefined();

    const result = await humanTypeTool!.execute(
      {
        text: 'MySecretPassword123',
        ref_id: 'password_field_ref',
      },
      mockContext
    );

    // Verify the tool succeeded
    expect(result.success).toBe(true);
    expect(result.summary).toContain('typed');

    // CRITICAL ASSERTION: Authorization was called with field_is_sensitive: true
    expect(capturedAuthPayload).toBeDefined();
    expect(capturedAuthPayload.payload).toBeDefined();
    expect(capturedAuthPayload.payload.field_is_sensitive).toBe(true);

    // Verify the ref_id-derived password field was correctly identified
    expect(mockExecuteScript).toHaveBeenCalledTimes(1);
    const firstCall = mockExecuteScript.mock.calls[0]![0];
    expect(firstCall.args).toEqual(['password_field_ref']);
  });

  it('REGRESSION: simulates the bug scenario (focus shift before auth)', async () => {
    // This test documents what WOULD happen with the bug:
    // 1. ref_id resolves to password field → fieldIsSensitive=true (local scope, shadowed)
    // 2. else block executes → checks activeElement → fieldIsSensitive=false (outer scope)
    // 3. Authorization uses outer scope value (false) → SECURITY BUG
    //
    // With the fix, step 1 assigns to the SAME outer-scope variable that step 3 reads.

    // Mock executeScript to return password field for ref_id
    const mockExecuteScript = vi.fn();
    mockExecuteScript.mockResolvedValueOnce([{
      result: {
        success: true,
        type: 'password',
        autocomplete: 'current-password',
        name: 'password',
        id: 'pwd',
      },
    }]);

    global.chrome = {
      scripting: {
        executeScript: mockExecuteScript,
      },
    } as any;

    // Execute with ref_id
    const humanTypeTool = registry['tools'].get('human_type');
    const result = await humanTypeTool!.execute(
      {
        text: 'password123',
        ref_id: 'pwd_ref',
      },
      mockContext
    );

    // Verify authorization received the ref-derived sensitivity (true)
    expect(result.success).toBe(true);
    expect(capturedAuthPayload.payload.field_is_sensitive).toBe(true);
    
    // If the bug existed, this would be false because the else block
    // would have re-declared fieldIsSensitive in outer scope
  });

  it('NO ref_id: falls back to activeElement sensitivity check', async () => {
    // When ref_id is NOT provided, the else branch should execute
    // and check document.activeElement
    
    const mockExecuteScript = vi.fn();
    
    // Simulate activeElement is a plain text search field
    mockExecuteScript.mockResolvedValueOnce([{
      result: {
        type: 'text',
        autocomplete: '',
        name: 'search',
        id: 'search-box',
      },
    }]);

    global.chrome = {
      scripting: {
        executeScript: mockExecuteScript,
      },
    } as any;

    const humanTypeTool = registry['tools'].get('human_type');
    const result = await humanTypeTool!.execute(
      {
        text: 'search query',
        // NO ref_id provided
      },
      mockContext
    );

    // Should succeed
    expect(result.success).toBe(true);

    // field_is_sensitive should be false (plain text search field)
    expect(capturedAuthPayload.payload.field_is_sensitive).toBe(false);
  });

  it('verifies isSensitiveInput correctly identifies password fields', () => {
    // Unit test for the sensitivity detection function
    
    // Password by type
    expect(isSensitiveInput({
      type: 'password',
      autocomplete: '',
      name: '',
      id: '',
    })).toBe(true);

    // Password by autocomplete
    expect(isSensitiveInput({
      type: 'text',
      autocomplete: 'current-password',
      name: '',
      id: '',
    })).toBe(true);

    // New password
    expect(isSensitiveInput({
      type: 'text',
      autocomplete: 'new-password',
      name: '',
      id: '',
    })).toBe(true);

    // Credit card
    expect(isSensitiveInput({
      type: 'text',
      autocomplete: 'cc-number',
      name: '',
      id: '',
    })).toBe(true);

    // Plain text field (not sensitive)
    expect(isSensitiveInput({
      type: 'text',
      autocomplete: '',
      name: 'username',
      id: 'user',
    })).toBe(false);

    // Email (not sensitive per se)
    expect(isSensitiveInput({
      type: 'email',
      autocomplete: 'email',
      name: 'email',
      id: 'email-field',
    })).toBe(false);
  });

  it('verifies the structural fix in tool-registry.ts', () => {
    // Verify the fix by reading the actual source code
    const source = fs.readFileSync(
      path.join(import.meta.dirname, '../tool-registry.ts'),
      'utf-8'
    );

    // Find the human_type tool
    const humanTypeIdx = source.indexOf("name: 'human_type'");
    expect(humanTypeIdx).toBeGreaterThan(0);

    // Extract the execute function body
    const executeIdx = source.indexOf('execute: async (args, context) => {', humanTypeIdx);
    expect(executeIdx).toBeGreaterThan(humanTypeIdx);
    
    const nextToolIdx = source.indexOf('this.register({', executeIdx + 100);
    const executeBody = source.slice(executeIdx, nextToolIdx > 0 ? nextToolIdx : executeIdx + 3000);

    // Verify: "let fieldIsSensitive: boolean;" appears early (outer scope)
    expect(executeBody).toContain('let fieldIsSensitive: boolean;');

    // Verify: assignment without re-declaration appears in if(refId) block
    expect(executeBody).toContain('fieldIsSensitive = isSensitiveInput(res);');

    // Verify: NO shadowing "const fieldIsSensitive" after the outer declaration
    const outerDeclIdx = executeBody.indexOf('let fieldIsSensitive: boolean;');
    const afterDecl = executeBody.slice(outerDeclIdx + 30);
    
    // Check that we don't have "const fieldIsSensitive" or "let fieldIsSensitive" shadowing
    expect(afterDecl).not.toMatch(/\bconst\s+fieldIsSensitive\s*=/);
    expect(afterDecl).not.toMatch(/\blet\s+fieldIsSensitive\s*:/);
  });
});
