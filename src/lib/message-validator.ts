/**
 * Runtime validation for messages arriving at process/network boundaries.
 * These are plain functions - no schema library dependency.
 */

export interface ValidatedMessage {
  type: string;
  payload: unknown;
}

export interface ValidatedPortMessage {
  type: string;
  payload?: unknown;
  requestId?: string;
}

export interface ValidatedBridgeEvent {
  type: string;
  payload: unknown;
}

export interface ValidatedBridgeCommand {
  command: string;
  params: unknown;
  request_id: string;
}

/**
 * Validates a message from chrome.runtime.onMessage or port.onMessage
 * Returns validated message or throws with descriptive error
 */
export function validateIncomingMessage(message: unknown): ValidatedMessage {
  if (message === null || message === undefined) {
    throw new Error('Message is null or undefined');
  }
  if (typeof message !== 'object') {
    throw new Error(`Message is not an object: ${typeof message}`);
  }
  const msg = message as Record<string, unknown>;
  if (typeof msg.type !== 'string') {
    throw new Error(`Message missing string type field: ${JSON.stringify(msg)}`);
  }
  return {
    type: msg.type,
    payload: msg.payload,
  };
}

/**
 * Validates a port message (has optional requestId for request-response)
 */
export function validatePortMessage(message: unknown): ValidatedPortMessage {
  const base = validateIncomingMessage(message);
  const msg = message as Record<string, unknown>;
  return {
    ...base,
    requestId: typeof msg.requestId === 'string' ? msg.requestId : undefined,
  };
}

/**
 * Validates a bridge event from WebSocket
 */
export function validateBridgeEvent(event: unknown): ValidatedBridgeEvent {
  if (event === null || event === undefined) {
    throw new Error('Bridge event is null or undefined');
  }
  if (typeof event !== 'object') {
    throw new Error(`Bridge event is not an object: ${typeof event}`);
  }
  const evt = event as Record<string, unknown>;
  if (typeof evt.type !== 'string') {
    throw new Error(`Bridge event missing string type field: ${JSON.stringify(evt)}`);
  }
  return {
    type: evt.type,
    payload: evt.payload ?? {},
  };
}

/**
 * Validates a bridge command from WebSocket
 */
export function validateBridgeCommand(cmd: unknown): ValidatedBridgeCommand {
  if (cmd === null || cmd === undefined) {
    throw new Error('Bridge command is null or undefined');
  }
  if (typeof cmd !== 'object') {
    throw new Error(`Bridge command is not an object: ${typeof cmd}`);
  }
  const c = cmd as Record<string, unknown>;
  if (typeof c.command !== 'string') {
    throw new Error(`Bridge command missing string command field: ${JSON.stringify(c)}`);
  }
  if (typeof c.request_id !== 'string') {
    throw new Error(`Bridge command missing string request_id field: ${JSON.stringify(c)}`);
  }
  return {
    command: c.command,
    params: c.params ?? {},
    request_id: c.request_id,
  };
}

/**
 * Type guards for specific payload shapes used in sidepanel
 */
export function hasPayload<T>(msg: { payload?: T }): msg is { payload: T } {
  return msg.payload !== undefined && msg.payload !== null;
}

export function validateStateUpdatePayload(payload: unknown): payload is { state: Record<string, unknown> } {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'state' in payload &&
    typeof (payload as Record<string, unknown>).state === 'object'
  );
}

export function validateTaskStartedPayload(payload: unknown): payload is { goal: string } {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'goal' in payload &&
    typeof (payload as Record<string, unknown>).goal === 'string'
  );
}

export function validatePlanCreatedPayload(payload: unknown): payload is { plan?: unknown[] } {
  return (
    payload !== null &&
    typeof payload === 'object'
  );
}

export function validateStepStartedPayload(payload: unknown): payload is { stepIndex: number; action?: { name: string } } {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'stepIndex' in payload &&
    typeof (payload as Record<string, unknown>).stepIndex === 'number'
  );
}

export function validateTaskAbortedPayload(payload: unknown): payload is { reason: string } {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'reason' in payload &&
    typeof (payload as Record<string, unknown>).reason === 'string'
  );
}

export function validateHumanInterventionPayload(payload: unknown): payload is {
  stepId: string;
  error?: string;
  actionHash?: string;
  pageRevision?: number;
  origin?: string;
  action?: string | { name: string };
  target?: string;
  reversible?: boolean;
  riskClass?: string;
} {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'stepId' in payload &&
    typeof (payload as Record<string, unknown>).stepId === 'string'
  );
}

export function validateLlmStreamChunkPayload(payload: unknown): payload is { content: string } {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'content' in payload &&
    typeof (payload as Record<string, unknown>).content === 'string'
  );
}