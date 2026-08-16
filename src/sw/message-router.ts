import { AgentOrchestrator, ToolCall, ToolResult, HumanResponse } from './orchestrator.js';
import { cdpAdapter } from './cdp-adapter.js';

export class MessageRouter {
  private orchestrator: AgentOrchestrator;
  private handlers: Map<string, (payload: unknown, sender: chrome.runtime.MessageSender) => Promise<unknown>> = new Map();

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
    this.handlers.set('GET_DOM_SNAPSHOT', this.handleGetDomSnapshot.bind(this));
    this.handlers.set('HUMAN_RESPONSE', this.handleHumanResponse.bind(this));
    this.handlers.set('GET_SESSIONS', this.handleGetSessions.bind(this));
    this.handlers.set('DELETE_SESSION', this.handleDeleteSession.bind(this));
    this.handlers.set('CDP_COMMAND', this.handleCdpCommand.bind(this));
    this.handlers.set('CDP_ATTACH_REQUEST', this.handleCdpAttachRequest.bind(this));
    this.handlers.set('CDP_GET_TARGETS', this.handleCdpGetTargets.bind(this));
    this.handlers.set('CDP_DETACH', this.handleCdpDetach.bind(this));
  }

  async handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    const msg = message as { type: string; payload?: unknown };
    const handler = this.handlers.get(msg.type);

    if (!handler) {
      return { error: `Unknown message type: ${msg.type}` };
    }

    try {
      return await handler(msg.payload, sender);
    } catch (error) {
      console.error('[MessageRouter] Error handling', msg.type, error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async handleStartTask(payload: unknown) {
    const { goal, sessionId, plan, policy } = payload as { goal: string; sessionId?: string; plan?: any; policy?: any };
    await this.orchestrator.startTask(goal, { sessionId, plan, policy });
    return { success: true };
  }

  private async handleStopTask() {
    // The orchestrator will handle aborting
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
    const { name, arguments: args } = payload as { name: string; arguments: Record<string, unknown> };
    const toolCall: ToolCall = { name, arguments: args };
    const state = this.orchestrator.getState();
    if (!state) {
      return { error: 'No active session' };
    }
    const domSnapshot = await this.orchestrator.captureDomSnapshot();
    const context = {
      dom: domSnapshot,
      variables: state.variables || {},
      step: toolCall,
    };
    // Tool execution is handled internally by the orchestrator run loop
    // This endpoint is for manual tool invocation from side panel
    return { error: 'Direct tool execution not implemented; use START_TASK with plan' };
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
    // Get all sessions from persistence
    return { sessions: [] };
  }

  private async handleDeleteSession(payload: unknown) {
    const { sessionId } = payload as { sessionId: string };
    // Delete session from persistence
    return { success: true };
  }

  private async handleCdpCommand(payload: unknown) {
    const { domain, command, params, sessionId } = payload as {
      domain: string;
      command: string;
      params: Record<string, unknown>;
      sessionId: string;
    };

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
}