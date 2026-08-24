import { describe, it, expect, vi } from 'vitest';
import {
  validateIncomingMessage,
  validatePortMessage,
  validateBridgeEvent,
  validateBridgeCommand,
  hasPayload,
  validateStateUpdatePayload,
  validateTaskStartedPayload,
  validatePlanCreatedPayload,
  validateStepStartedPayload,
  validateTaskAbortedPayload,
  validateHumanInterventionPayload,
  validateLlmStreamChunkPayload,
} from './message-validator.js';

describe('message-validator', () => {
  describe('validateIncomingMessage', () => {
    it('accepts valid message', () => {
      const result = validateIncomingMessage({ type: 'TEST', payload: { foo: 'bar' } });
      expect(result).toEqual({ type: 'TEST', payload: { foo: 'bar' } });
    });

    it('throws on null', () => {
      expect(() => validateIncomingMessage(null)).toThrow('Message is null or undefined');
    });

    it('throws on undefined', () => {
      expect(() => validateIncomingMessage(undefined)).toThrow('Message is null or undefined');
    });

    it('throws on non-object', () => {
      expect(() => validateIncomingMessage('string')).toThrow('Message is not an object: string');
    });

    it('throws on missing type', () => {
      expect(() => validateIncomingMessage({ payload: {} })).toThrow('Message missing string type field');
    });

    it('throws on non-string type', () => {
      expect(() => validateIncomingMessage({ type: 123 })).toThrow('Message missing string type field');
    });
  });

  describe('validatePortMessage', () => {
    it('accepts valid port message with requestId', () => {
      const result = validatePortMessage({ type: 'TEST', payload: {}, requestId: 'req-123' });
      expect(result).toEqual({ type: 'TEST', payload: {}, requestId: 'req-123' });
    });

    it('accepts valid port message without requestId', () => {
      const result = validatePortMessage({ type: 'TEST', payload: {} });
      expect(result).toEqual({ type: 'TEST', payload: {}, requestId: undefined });
    });
  });

  describe('validateBridgeEvent', () => {
    it('accepts valid bridge event', () => {
      const result = validateBridgeEvent({ type: 'event', payload: { data: 'test' } });
      expect(result).toEqual({ type: 'event', payload: { data: 'test' } });
    });

    it('accepts bridge event without payload', () => {
      const result = validateBridgeEvent({ type: 'event' });
      expect(result).toEqual({ type: 'event', payload: {} });
    });

    it('throws on null', () => {
      expect(() => validateBridgeEvent(null)).toThrow('Bridge event is null or undefined');
    });
  });

  describe('validateBridgeCommand', () => {
    it('accepts valid bridge command', () => {
      const result = validateBridgeCommand({ command: 'get_status', params: {}, request_id: 'req-123' });
      expect(result).toEqual({ command: 'get_status', params: {}, request_id: 'req-123' });
    });

    it('throws on missing command', () => {
      expect(() => validateBridgeCommand({ request_id: 'req-123' })).toThrow('Bridge command missing string command field');
    });

    it('throws on missing request_id', () => {
      expect(() => validateBridgeCommand({ command: 'get_status' })).toThrow('Bridge command missing string request_id field');
    });
  });

  describe('hasPayload', () => {
    it('returns true for present payload', () => {
      expect(hasPayload({ payload: { foo: 'bar' } })).toBe(true);
    });

    it('returns false for undefined payload', () => {
      expect(hasPayload({ payload: undefined })).toBe(false);
    });

    it('returns false for null payload', () => {
      expect(hasPayload({ payload: null })).toBe(false);
    });
  });

  describe('validateStateUpdatePayload', () => {
    it('accepts valid state update', () => {
      expect(validateStateUpdatePayload({ state: { isRunning: true } })).toBe(true);
    });

    it('rejects missing state', () => {
      expect(validateStateUpdatePayload({})).toBe(false);
    });

    it('rejects null', () => {
      expect(validateStateUpdatePayload(null)).toBe(false);
    });
  });

  describe('validateTaskStartedPayload', () => {
    it('accepts valid task started', () => {
      expect(validateTaskStartedPayload({ goal: 'test goal' })).toBe(true);
    });

    it('rejects missing goal', () => {
      expect(validateTaskStartedPayload({})).toBe(false);
    });
  });

  describe('validatePlanCreatedPayload', () => {
    it('accepts valid plan created', () => {
      expect(validatePlanCreatedPayload({ plan: [] })).toBe(true);
    });

    it('accepts empty object', () => {
      expect(validatePlanCreatedPayload({})).toBe(true);
    });
  });

  describe('validateStepStartedPayload', () => {
    it('accepts valid step started', () => {
      expect(validateStepStartedPayload({ stepIndex: 0, action: { name: 'click' } })).toBe(true);
    });

    it('accepts stepIndex without action', () => {
      expect(validateStepStartedPayload({ stepIndex: 1 })).toBe(true);
    });

    it('rejects missing stepIndex', () => {
      expect(validateStepStartedPayload({})).toBe(false);
    });

    it('rejects non-number stepIndex', () => {
      expect(validateStepStartedPayload({ stepIndex: '0' })).toBe(false);
    });
  });

  describe('validateTaskAbortedPayload', () => {
    it('accepts valid task aborted', () => {
      expect(validateTaskAbortedPayload({ reason: 'user cancelled' })).toBe(true);
    });

    it('rejects missing reason', () => {
      expect(validateTaskAbortedPayload({})).toBe(false);
    });
  });

  describe('validateHumanInterventionPayload', () => {
    it('accepts valid human intervention', () => {
      expect(validateHumanInterventionPayload({
        stepId: 'step-1',
        actionHash: 'hash',
        pageRevision: 1,
        origin: 'test',
        action: 'click',
        target: 'button',
        reversible: true,
        riskClass: 'low',
      })).toBe(true);
    });

    it('accepts minimal valid payload', () => {
      expect(validateHumanInterventionPayload({ stepId: 'step-1' })).toBe(true);
    });

    it('rejects missing stepId', () => {
      expect(validateHumanInterventionPayload({})).toBe(false);
    });
  });

  describe('validateLlmStreamChunkPayload', () => {
    it('accepts valid stream chunk', () => {
      expect(validateLlmStreamChunkPayload({ content: 'hello' })).toBe(true);
    });

    it('rejects missing content', () => {
      expect(validateLlmStreamChunkPayload({})).toBe(false);
    });

    it('rejects non-string content', () => {
      expect(validateLlmStreamChunkPayload({ content: 123 })).toBe(false);
    });
  });
});

describe('Boundary message handling integration', () => {
  it('validates sidepanel message flow with malformed message', () => {
    // This simulates the sidepanel's handlePortMessage validation
    const malformedMsg = { type: 'TASK_STARTED' }; // missing payload
    const validated = validatePortMessage(malformedMsg);
    expect(hasPayload(validated)).toBe(false);
  });

  it('validates port manager message flow with invalid message', () => {
    const invalidMsg = 'not an object';
    expect(() => validatePortMessage(invalidMsg)).toThrow('Message is not an object');
  });

  it('validates message router boundary validation', () => {
    const malformedMsg = { type: 123 }; // non-string type
    expect(() => validateIncomingMessage(malformedMsg)).toThrow('Message missing string type field');
  });

  it('validates ax-extractor message flow', () => {
    const validMsg = { type: 'GET_AX_TREE' };
    const validated = validateIncomingMessage(validMsg);
    expect(validated.type).toBe('GET_AX_TREE');
  });

  it('validates bridge WebSocket event boundary', () => {
    const validEvent = { type: 'policy_changed', payload: { key: 'value' } };
    const validated = validateBridgeEvent(validEvent);
    expect(validated.type).toBe('policy_changed');
    expect(validated.payload).toEqual({ key: 'value' });
  });

  it('validates bridge WebSocket command boundary', () => {
    const validCmd = { command: 'get_status', params: {}, request_id: 'req-123' };
    const validated = validateBridgeCommand(validCmd);
    expect(validated.command).toBe('get_status');
    expect(validated.request_id).toBe('req-123');
  });

  it('handles malformed bridge command gracefully', () => {
    const malformedCmd = { command: 'get_status' }; // missing request_id
    expect(() => validateBridgeCommand(malformedCmd)).toThrow('Bridge command missing string request_id field');
  });
});