// Shared redaction utilities. Applied at the *source* of data collection so
// that sensitive values (passwords, tokens, card numbers, PII) never reach DOM
// snapshots, the persisted session, or the LLM — rather than being scrubbed only
// at the LLM-send boundary.

/** Input `type` values whose contents must never be captured. */
const SENSITIVE_INPUT_TYPES = new Set(['password']);

/** Autocomplete tokens that mark a field as secret even when `type` isn't password. */
const SENSITIVE_AUTOCOMPLETE_TOKENS = [
  'cc-', 'cvc', 'cvv', 'card', 'account-number',
  'one-time-code', 'otp', 'new-password', 'current-password',
];

/** `name`/`id` fragments that mark a field as sensitive. */
const SENSITIVE_FIELD_PATTERN =
  /(password|passwd|pwd|secret|token|api[_-]?key|authorization|credential|credit|card|cvv|cvc|ssn|social)/i;

/** Standalone secret/PII value shapes, independent of field metadata. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(?:\d[ -]*?){13,16}\b/g,                        // credit-card numbers
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // emails
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // US phone numbers
  /\b\d{3}-\d{2}-\d{4}\b/g,                          // US SSN
  /\bsk-[a-zA-Z0-9]{20,}\b/g,                        // OpenAI keys
  /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/g,               // Slack tokens
  /\bgh[pousr]_[a-zA-Z0-9]{20,}\b/g,                 // GitHub personal-access tokens
  /\bgithub_pat_[a-zA-Z0-9_]{20,}\b/g,               // GitHub fine-grained PATs
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,                  // AWS access-key IDs
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWTs
  /\bbearer\s+[A-Za-z0-9._~+/-]+=*\b/gi,             // bearer tokens
];

/** `key: value` assignments where the key itself names a secret. */
const KEY_VALUE_SECRET_PATTERN =
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|credential)\s*[:=]\s*\S+/gi;

export interface SensitiveFieldDescriptor {
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
}

/** True when the field's own metadata marks it as a secret input. */
export function isSensitiveInput(field: SensitiveFieldDescriptor): boolean {
  const type = (field.type || '').toLowerCase();
  if (SENSITIVE_INPUT_TYPES.has(type)) return true;

  const autocomplete = (field.autocomplete || '').toLowerCase();
  if (SENSITIVE_AUTOCOMPLETE_TOKENS.some(t => autocomplete.includes(t))) return true;

  const identifier = `${field.name || ''} ${field.id || ''}`;
  return SENSITIVE_FIELD_PATTERN.test(identifier);
}

/** Redact standalone secret/PII values and `key: value` assignments from free text. */
export function redactText(text: string): string {
  if (!text) return text;
  let result = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result.replace(KEY_VALUE_SECRET_PATTERN, '[REDACTED]');
}

/**
 * Recursively redact strings inside plain objects and arrays (never mutating the
 * input). Non-plain objects (Map, Set, Date, class instances) and primitives are
 * passed through unchanged — they are handled by Dexie/SuperJSON separately.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      result[key] = redactValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

/** Redact an input's value: drop it entirely for sensitive fields, else strip embedded secrets. */
export function redactInputValue(field: SensitiveFieldDescriptor, value: string): string {
  if (isSensitiveInput(field)) return '';
  return redactText(value);
}
