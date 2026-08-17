import { describe, it, expect } from 'vitest';
import {
  isSensitiveInput,
  redactText,
  redactInputValue,
  redactValue,
  isSensitiveAttribute,
  redactAttributeValue,
} from './redaction.js';

describe('isSensitiveInput', () => {
  it('flags password inputs by type', () => {
    expect(isSensitiveInput({ type: 'password' })).toBe(true);
    expect(isSensitiveInput({ type: 'Password' })).toBe(true);
  });

  it('flags autocomplete secret tokens', () => {
    expect(isSensitiveInput({ autocomplete: 'current-password' })).toBe(true);
    expect(isSensitiveInput({ autocomplete: 'cc-number' })).toBe(true);
    expect(isSensitiveInput({ autocomplete: 'one-time-code' })).toBe(true);
  });

  it('flags secret name/id fragments', () => {
    expect(isSensitiveInput({ name: 'password' })).toBe(true);
    expect(isSensitiveInput({ id: 'api_key' })).toBe(true);
    expect(isSensitiveInput({ name: 'creditCardNumber' })).toBe(true);
  });

  it('does not flag ordinary fields', () => {
    expect(isSensitiveInput({ type: 'text', name: 'username' })).toBe(false);
    expect(isSensitiveInput({})).toBe(false);
  });
});

describe('redactText', () => {
  it('redacts credit-card numbers', () => {
    expect(redactText('card 4111 1111 1111 1111 ok')).not.toContain('4111');
    expect(redactText('card 4111 1111 1111 1111 ok')).toContain('[REDACTED]');
  });

  it('redacts emails and phone numbers', () => {
    expect(redactText('mail alice@example.com now')).not.toContain('alice@example.com');
    expect(redactText('call 555-123-4567 now')).not.toContain('555-123-4567');
  });

  it('redacts API-key style secrets', () => {
    expect(redactText('key sk-abcdefghijklmnopqrstuvwxyz123456 end')).not.toContain('sk-');
    expect(redactText('ghp_abcdefghijklmnopqrstuvwxyz123456 end')).not.toContain('ghp_');
    expect(redactText('github_pat_abcdefghijklmnopqrstuvwxyz123456 end')).not.toContain(
      'github_pat_'
    );
  });

  it('redacts key: value assignments', () => {
    expect(redactText('password: hunter2')).not.toContain('hunter2');
    expect(redactText('authorization: Bearer abc123')).not.toContain('Bearer abc123');
  });

  it('leaves benign text intact', () => {
    expect(redactText('hello world')).toBe('hello world');
  });
});

describe('redactInputValue', () => {
  it('drops the value entirely for sensitive fields', () => {
    expect(redactInputValue({ type: 'password' }, 'hunter2')).toBe('');
    expect(redactInputValue({ name: 'token' }, 'abc123')).toBe('');
  });

  it('strips embedded secrets from ordinary field values', () => {
    const value = 'notes with sk-abcdefghijklmnopqrstuvwxyz123456 inside';
    expect(redactInputValue({ type: 'text' }, value)).not.toContain('sk-');
  });

  it('passes through ordinary values untouched', () => {
    expect(redactInputValue({ type: 'text' }, 'hello world')).toBe('hello world');
  });
});

describe('redactValue', () => {
  it('redacts strings inside nested objects and arrays', () => {
    const input = {
      a: 'sk-abcdefghijklmnopqrstuvwxyz123456',
      b: ['mail alice@example.com now', 42, true],
      c: { d: 'card 4111 1111 1111 1111' },
    };
    const out = redactValue(input) as typeof input;
    expect(out.a).not.toContain('sk-');
    expect(out.b[0]).not.toContain('alice@example.com');
    expect(out.c.d).not.toContain('4111');
  });

  it('does not mutate the input', () => {
    const input = { a: 'sk-abcdefghijklmnopqrstuvwxyz123456' };
    redactValue(input);
    expect(input.a).toContain('sk-');
  });

  it('passes through primitives and non-plain objects unchanged', () => {
    const date = new Date();
    const map = new Map([['x', 'sk-abcdefghijklmnopqrstuvwxyz123456']]);
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBe(null);
    expect(redactValue(date)).toBe(date);
    expect(redactValue(map)).toBe(map);
  });
});

describe('isSensitiveAttribute', () => {
  it('flags data-* and value attributes', () => {
    expect(isSensitiveAttribute('data-token')).toBe(true);
    expect(isSensitiveAttribute('DATA-FOO')).toBe(true);
    expect(isSensitiveAttribute('value')).toBe(true);
    expect(isSensitiveAttribute('VALUE')).toBe(true);
  });

  it('does not flag ordinary attributes', () => {
    expect(isSensitiveAttribute('class')).toBe(false);
    expect(isSensitiveAttribute('href')).toBe(false);
    expect(isSensitiveAttribute('')).toBe(false);
  });
});

describe('redactAttributeValue', () => {
  it('drops data-* and value entirely', () => {
    expect(redactAttributeValue('data-token', 'sk-abcdefghijklmnopqrstuvwxyz123456')).toBe('');
    expect(redactAttributeValue('value', 'hunter2')).toBe('');
  });

  it('redacts data: and javascript: urls', () => {
    expect(redactAttributeValue('href', 'javascript:alert(1)')).toBe('[REDACTED]');
    expect(redactAttributeValue('src', 'data:text/html,<script>bad</script>')).toBe('[REDACTED]');
  });

  it('strips query and fragment from ordinary urls', () => {
    expect(redactAttributeValue('href', 'https://example.com/path?token=sk-abcdefghijklmnopqrstuvwxyz123456#frag')).toBe(
      'https://example.com/path'
    );
  });

  it('scrubs secrets embedded in non-url attributes', () => {
    expect(redactAttributeValue('title', 'mail alice@example.com now')).not.toContain('alice@example.com');
  });
});
