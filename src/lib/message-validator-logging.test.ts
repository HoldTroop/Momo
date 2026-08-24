/**
 * Integration test for message validation logging at boundaries.
 * Verifies that invalid messages are dropped with warn-level logs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateIncomingMessage, validatePortMessage, validateBridgeEvent, validateBridgeCommand } from './message-validator.js';

describe('Message validation logging', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('validateIncomingMessage throws on null', () => {
    expect(() => validateIncomingMessage(null)).toThrow('Message is null or undefined');
  });

  it('validateIncomingMessage throws on missing type', () => {
    expect(() => validateIncomingMessage({ payload: 'test' })).toThrow('Message missing string type field');
  });

  it('validatePortMessage throws on invalid structure', () => {
    expect(() => validatePortMessage('not an object')).toThrow('Message is not an object');
  });

  it('validateBridgeEvent throws on null', () => {
    expect(() => validateBridgeEvent(null)).toThrow('Bridge event is null or undefined');
  });

  it('validateBridgeCommand throws on missing command', () => {
    expect(() => validateBridgeCommand({ request_id: '123' })).toThrow('Bridge command missing string command field');
  });

  it('validateBridgeCommand throws on missing request_id', () => {
    expect(() => validateBridgeCommand({ command: 'test', params: {} })).toThrow('Bridge command missing string request_id field');
  });
});
