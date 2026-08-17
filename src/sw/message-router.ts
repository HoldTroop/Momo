import { AgentOrchestrator, HumanResponse } from './orchestrator.js';
import { cdpAdapter } from './cdp-adapter.js';

export class MessageRouter {
  private orchestrator: AgentOrchestrator;
  private handlers: Map<string, (payload: unknown, sender: chrome.runtime.MessageSender | undefined) => Promise<unknown>> = new Map();

  /** Message types a content script (tab-attached, self-origin) may originate. */
  private static readonly CONTENT_SCRIPT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
    'CDP_ATTACH_REQUEST',
    'CDP_COMMAND',
  ]);

  /** CDP commands the content script's AX-extraction path is permitted to issue. */
  private static readonly CDP_COMMAND_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = {
    Accessibility: new Set(['getFullAXTree']),
    DOM: new Set(['getDocument', 'querySelector', 'getBoxModel', 'getContentQuads', 'getNodeForLocation', 'getOuterHTML']),
  };

  /** Bridge request types that may be proxied; mutating/destructive ops are excluded. */
  private static readonly BRIDGE_REQUEST_ALLOWLIST: ReadonlySet<string> = new Set([
    'PING',
    'GET_STATUS',
    'POLICY_CHECK',
    'POLICY_GET_CONFIG',
    'POLICY_GET_AUDIT_LOG',
    'SIMULATE_CLICK',
    'SIMULATE_TYPE',
    'SIMULATE_SCROLL',
    'SIMULATE_MOUSE_MOVE',
  ]);

  constructor(orchestrator: AgentOrchestrator) {
    this.orchestrator = orchestrator;
    this.registerHandlers();
  }

  private registerHandlers() {
    this.handlers.set('START_TASK', this.handleStartTask.bind(this));
    this.handlers.set('STOP_TASK', this.handleStopTask.bind(this));
    this.handlers.set('PAUSE_TASK', this.handlePauseTask.bind(this));
    this.handlers.set('RESUME_TASK', this.handleResumeTask.bind(this));
    this.handlers.set('GET_STATE', this.handleGetState.bind(this));
    this.handlers.set('EXECUTE_TOOL', this.handleExecuteTool.bind(this));
    this.handlers.set('LIST_TOOLS', this.handleListTools.bind(this));
    this.handlers.set('GET_DOM_SNAPSHOT', this.handleGetDomSnapshot.bind(this));
    this.handlers.set('HUMAN_RESPONSE', this.handleHumanResponse.bind(this));
    this.handlers.set('GET_SESSIONS', this.handleGetSessions.bind(this));
    this.handlers.set('DELETE_SESSION', this.handleDeleteSession.bind(this));
    this.handlers.set('CDP_COMMAND', this.handleCdpCommand.bind(this));
    this.handlers.set('CDP_ATTACH_REQUEST', this.handleCdpAttachRequest.bind(this));
    this.handlers.set('CDP_GET_TARGETS', this.handleCdpGetTargets.bind(this));
    this.handlers.set('CDP_DETACH', this.handleCdpDetach.bind(this));

    // Offscreen → bridge proxy + offscreen event consumption (H8, H9, M5).
    this.handlers.set('BRIDGE_REQUEST', this.handleBridgeRequest.bind(this));
    this.handlers.set('LLM_COMPLETE', this.handleLlmComplete.bind(this));
    this.handlers.set('LLM_RESPONSE', this.handleLlmResponse.bind(this));
    this.handlers.set('LLM_STREAM_CHUNK', this.handleLlmStreamChunk.bind(this));
    this.handlers.set('SIMULATION_COMPLETE', this.handleSimulationComplete.bind(this));
    this.handlers.set('PERSIST_STATE', this.handlePersistState.bind(this));
    this.handlers.set('OFFSCREEN_KILLED', this.handleOffscreenKilled.bind(this));
  }

  async handle(message: unknown, sender: chrome.runtime.MessageSender | undefined): Promise<unknown> {
    const msg = message as { type: string; payload?: unknown };
    const handler = this.handlers.get(msg.type);

    if (!handler) {
      return { error: `Unknown message type: ${msg.type}` };
    }

    try {
      this.assertSenderAllowed(msg.type, sender);
      return await handler(msg.payload, sender);
    } catch (error) {
      console.error('[MessageRouter] Error handling', msg.type, error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Reject messages from untrusted senders before dispatching to a privileged
   * handler. `sender` is undefined when a message is routed via a trusted
   * extension port (side panel / offscreen), which PortManager only accepts for
   * self-origin, non-tab connections.
   */
  private assertSenderAllowed(type: string, sender: chrome.runtime.MessageSender | undefined): void {
    if (sender === undefined) return;

    // Web pages (externally_connectable) and other extensions are not trusted.
    if (sender.id !== chrome.runtime.id) {
      throw new Error('Unauthorized sender');
    }

    // A content script (tab-attached) may only originate the AX-extraction
    // messages; every other privileged message must come from an extension page.
    if (sender.tab !== undefined && !MessageRouter.CONTENT_SCRIPT_MESSAGE_TYPES.has(type)) {
      throw new Error(`Message type not permitted from content scripts: ${type}`);
    }
  }

  private async handleStartTask(payload: unknown) {
    const { goal, sessionId, plan, policy } = payload as { goal: string; sessionId?: string; plan?: any; policy?: any };
    await this.orchestrator.startTask(goal, { sessionId, plan, policy });
    return { success: true };
  }

  private async handleStopTask() {
    await this.orchestrator.abortTask('Stopped by user');
    return { success: true };
  }

  private async handlePauseTask() {
    this.orchestrator.pause();
    return { success: true };
  }

  private async handleResumeTask(payload: unknown) {
    const { sessionId } = payload as { sessionId: string };
    this.orchestrator.resume();
    return { success: true };
  }

  private async handleGetState() {
    return this.orchestrator.getState();
  }

  private async handleExecuteTool(payload: unknown) {
    const { name, arguments: args } = payload as { name?: string; arguments?: Record<string, unknown> };
    if (!name || typeof name !== 'string') {
      return { error: 'Missing tool name' };
    }
    if (!this.orchestrator.getState()) {
      return { error: 'No active session' };
    }
    // External-agent ingress: schema-validate then execute through the policy
    // gate + confirmation flow. The executor captures its own DOM snapshot.
    return this.orchestrator.executeToolCall({ name, arguments: args ?? {} }, crypto.randomUUID());
  }

  private async handleListTools() {
    return { tools: this.orchestrator.listTools() };
  }

  private async handleGetDomSnapshot() {
    return await this.orchestrator.captureDomSnapshot();
  }

  private async handleHumanResponse(payload: unknown) {
    const response = payload as HumanResponse;
    await this.orchestrator.handleHumanResponse(response);
    return { success: true };
  }

  private async handleGetSessions() {
    const sessions = await this.orchestrator.listSessions();
    return { sessions };
  }

  private async handleDeleteSession(payload: unknown) {
    const { sessionId } = payload as { sessionId: string };
    if (!sessionId) {
      return { success: false, error: 'Missing sessionId' };
    }
    await this.orchestrator.deleteSession(sessionId);
    return { success: true };
  }

  private async handleCdpCommand(payload: unknown) {
    const { domain, command, params, sessionId } = payload as {
      domain: string;
      command: string;
      params: Record<string, unknown>;
      sessionId: string;
    };

    // Only the read-only commands the content-script AX extraction needs may be
    // forwarded; arbitrary debugger commands (e.g. Runtime.evaluate, Input.*,
    // Network.*, Page.*) are rejected so a compromised content script cannot
    // drive the debugger.
    const allowedCommands = MessageRouter.CDP_COMMAND_ALLOWLIST[domain];
    if (!allowedCommands?.has(command)) {
      return { error: `CDP command not allowed: ${domain}.${command}` };
    }

    try {
      // Use chrome.debugger via adapter
      const result = await cdpAdapter.sendCommand(sessionId, domain, command, params);
      return result;
    } catch (e) {
      return { error: String(e) };
    }
  }

  private async handleCdpAttachRequest(payload: unknown) {
    // Extension requests CDP attachment - handled by chrome.debugger
    try {
      const sessionId = await this.orchestrator.attachCdpToActiveTab();
      return { sessionId };
    } catch (e) {
      return { error: String(e) };
    }
  }

  private async handleCdpGetTargets() {
    try {
      const targets = await cdpAdapter.getTargets();
      return { targets };
    } catch (e) {
      return { error: String(e) };
    }
  }

  private async handleCdpDetach(payload: unknown) {
    const { sessionId } = payload as { sessionId: string };
    try {
      await this.orchestrator.detachCdp(sessionId);
      return { success: true };
    } catch (e) {
      return { error: String(e) };
    }
  }

  /** Proxy a request to the native bridge and unwrap its data, surfacing Error envelopes. */
  private async proxyToBridge(payload: unknown): Promise<unknown> {
    try {
      const response = await chrome.runtime.sendNativeMessage('agent.bridge', payload as object);
      if (response?.type === 'Error') {
        return { error: response?.payload?.message ?? 'Native host error' };
      }
      return response?.payload?.data ?? response?.payload ?? response;
    } catch (e) {
      return { error: String(e) };
    }
  }

  private async handleBridgeRequest(payload: unknown) {
    const request = payload as { type?: string } | null;
    const type = request?.type;
    if (!type || !MessageRouter.BRIDGE_REQUEST_ALLOWLIST.has(type)) {
      return { error: `Bridge request type not allowed: ${type ?? 'missing'}` };
    }
    return this.proxyToBridge(payload);
  }

  private async handleLlmComplete(payload: unknown) {
    return this.proxyToBridge(payload);
  }

  private async handleLlmResponse(payload: unknown) {
    // Forward offscreen LLM result to extension pages (side panel).
    this.forwardToUi('LLM_RESPONSE', payload);
    return { success: true };
  }

  private async handleLlmStreamChunk(payload: unknown) {
    this.forwardToUi('LLM_STREAM_CHUNK', payload);
    return { success: true };
  }

  private async handleSimulationComplete(payload: unknown) {
    this.forwardToUi('SIMULATION_COMPLETE', payload);
    return { success: true };
  }

  private async handlePersistState() {
    await this.orchestrator.persistState();
    return { success: true };
  }

  private async handleOffscreenKilled() {
    // Propagate the kill switch: cancel in-flight bridge/LLM work and abort the task.
    try {
      await chrome.runtime.sendNativeMessage('agent.bridge', { type: 'SHUTDOWN' });
    } catch {
      // Bridge may already be gone; best effort.
    }
    await this.orchestrator.abortTask('Offscreen kill switch activated');
    return { success: true };
  }

  private forwardToUi(type: string, payload: unknown) {
    chrome.runtime.sendMessage({ type, payload }).catch(() => {
      // No receiver is fine — the offscreen events are advisory.
    });
  }
}