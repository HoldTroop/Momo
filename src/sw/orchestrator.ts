import { PersistenceManager } from '../lib/persistence.js';
import { ToolRegistry, ToolContext } from '../lib/tool-registry.js';
import { DomCompressor } from '../lib/dom-compressor.js';
import { redactText, redactValue } from '../lib/redaction.js';
import { TaskQueue } from '../lib/task-queue.js';
import { cdpAdapter } from './cdp-adapter.js';
import { getWsClient } from './ws-client.js';
import { ensureHostPermission } from '../lib/permissions.js';
import * as confirmation from './confirmation.js';
import * as cdpLifecycle from './cdp-lifecycle.js';
import { CHECKPOINT_INTERVAL, createCheckpoint } from './checkpoint.js';

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_MAX_MS = 10_000;

export interface AgentState {
  sessionId: string;
  goal: string;
  plan: Plan | null;
  currentStep: number;
  history: ExecutionStep[];
  variables: Record<string, unknown>;
  checkpoints: Checkpoint[];
  // New fields for policy compliance
  paused: boolean;
  pageRevision: number;
  allowlist: string[];
  tokenBudget: { max: number; used: number };
  pendingHumanIntervention: HumanInterventionState | null;
  status: SessionStatus;
  error: string | null;
}

export interface HumanInterventionState {
  resolve: (decision: 'confirm' | 'deny' | 'takeover') => void;
  reject: (error: Error) => void;
  stepId: string;
  actionHash: string;
  pageRevision: number;
  timerId?: ReturnType<typeof setTimeout>;
}

export interface HumanResponse {
  action: 'confirm' | 'deny' | 'takeover';
  actionHash: string;
  pageRevision: number;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  contingencies: Map<string, PlanStep[]>;
}

export interface PlanStep {
  id: string;
  action: ToolCall;
  expectedOutcome: string;
  verification: VerificationRule;
  onFailure: FailureAction;
}

export type VerificationRule =
  | { type: 'elementVisible'; selector: string }
  | { type: 'elementHidden'; selector: string }
  | { type: 'textContains'; selector: string; text: string }
  | { type: 'urlMatches'; pattern: string };

export type FailureAction = 'retry' | { type: 'fallback'; stepId: string } | 'escalate' | 'abort';

export interface ExecutionStep {
  stepId: string;
  action: ToolCall;
  result: ToolResult;
  timestamp: number;
  durationMs: number;
  idempotencyKey: string;
  pageRevision: number;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /// Optional ref_id for stable element targeting (perception upgrade)
  ref_id?: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  summary: string;
  navigationOccurred: boolean;
  requiresConfirmation?: boolean;
  confirmationData?: ConfirmationData;
}

export interface ConfirmationData {
  origin: string;
  action: string;
  target: string;
  data: Record<string, unknown>;
  reversible: boolean;
  riskClass: string;
}

export interface Checkpoint {
  stepIndex: number;
  stateSnapshot: unknown;
  walPosition: number;
  timestamp: number;
}

export interface CompressedDom {
  url: string;
  title: string;
  actions: ActionableElement[];
  summary: string;
  layout: LayoutNode;
  timestamp: number;
  /// Optional Markdown content from Readability+Turndown (perception upgrade)
  markdown_content?: string;
  /// Optional selector → ref_id mapping for stable element targeting
  ref_id_map?: Record<string, string>;
}

export interface ActionableElement {
  selector: string;
  tag: string;
  role: string;
  label: string;
  bounds: DomRect;
  actionabilityScore: number;
  backendNodeId?: number;
}

export interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface LayoutNode {
  role: string;
  bounds: DomRect;
  children: LayoutNode[];
}

export type SessionStatus = 'idle' | 'running' | 'completed' | 'error';

export interface SessionSummary {
  sessionId: string;
  goal: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  stepCount: number;
}

export class AgentOrchestrator {
  private persistence: PersistenceManager;
  private toolRegistry: ToolRegistry;
  private domCompressor: DomCompressor;
  private taskQueue: TaskQueue;

  private state: AgentState | null = null;
  private activeSessionId: string | null = null;
  private isRunning = false;
  private runToken = 0;
  private abortController: AbortController | null = null;
  private cdpBindings: cdpLifecycle.CdpBindings = cdpLifecycle.createCdpBindings();
  private inPersistBroadcast = false;

  constructor(persistence: PersistenceManager) {
    this.persistence = persistence;
    this.toolRegistry = new ToolRegistry();
    this.domCompressor = new DomCompressor();
    this.taskQueue = new TaskQueue(persistence);

    // When a CDP session detaches (tab close, navigation, external debugger),
    // drop the cached session id so the next use re-attaches instead of reusing
    // a stale session (MOMO-038/050).
    cdpAdapter.onSessionDetached((sessionId) => {
      if (this.cdpBindings.sessionId === sessionId) {
        this.cdpBindings.sessionId = null;
      }
    });
  }

  async init() {
    await this.persistence.init();
    await this.loadLatestSession();
    // Start task queue processing
    if (this.activeSessionId) {
      this.taskQueue.startProcessing(this.activeSessionId, this.taskProcessor.bind(this));
    }
  }

  private async loadLatestSession() {
    const sessions = await this.persistence.getAllSessions();
    const latest = sessions[0];
    if (latest) {
      this.state = latest.state;
      this.activeSessionId = latest.state.sessionId;
      // A session persisted in 'running' was interrupted by SW suspension or a
      // crash and cannot be safely resumed — mark it errored (D1).
      if (this.state.status === 'running') {
        this.state.status = 'error';
        this.state.error = 'Interrupted by service worker restart';
        await this.persistState();
      }
      console.log('[Orchestrator] Resumed session:', this.activeSessionId);
    }
  }

  async startTask(goal: string, options?: { sessionId?: string; plan?: Plan; policy?: TaskPolicy }) {
    if (this.isRunning) {
      throw new Error('Agent already running');
    }
    // An explicitly supplied but empty plan is a caller error, not a task that
    // silently "completes" with zero steps (MOMO-097).
    if (options?.plan && (!options.plan.steps || options.plan.steps.length === 0)) {
      throw new Error('Plan has no steps');
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    const sessionId = options?.sessionId || crypto.randomUUID();
    this.activeSessionId = sessionId;

    const policy = options?.policy || {
      allowlist: [],
      permittedActions: [],
      confirmationPolicy: 'sensitive' as const,
      dataRetention: 'session' as const,
    };

    this.state = {
      sessionId,
      goal,
      plan: options?.plan ? this.normalizePlan(options.plan) : null,
      currentStep: 0,
      history: [],
      variables: {},
      checkpoints: [],
      paused: false,
      pageRevision: 0,
      allowlist: policy.allowlist,
      tokenBudget: { max: 100000, used: 0 },
      pendingHumanIntervention: null,
      status: 'running' as const,
      error: null,
    };

    try {
      await this.persistState();
      this.broadcastUi('TASK_STARTED', { sessionId, goal });
      if (this.state?.plan) {
        this.broadcastUi('PLAN_CREATED', {
          sessionId,
          plan: {
            goal: this.state!.plan!.goal,
            steps: this.state!.plan!.steps.map(s => ({ id: s.id, action: s.action, expectedOutcome: s.expectedOutcome })),
          },
        });
      }
      this.broadcastUi('STATE_UPDATE', { state: this.sanitizeStateForUi() });
    } catch (error) {
      this.isRunning = false;
      this.abortController?.abort();
      throw error;
    }

    // Start task queue for this session
    this.taskQueue.startProcessing(sessionId, this.taskProcessor.bind(this));

    const token = ++this.runToken;
    void this.runLoop(token).catch(e => {
      console.error('[Orchestrator] runLoop crashed:', e);
      this.isRunning = false;
    });
  }

  /** C9: Normalize a plan at ingest so the runtime always sees a Plan with an
   *  array of steps and a real Map of contingencies, whether it arrived as a
   *  typed Plan or a plain JSON object from an external agent. */
  private normalizePlan(plan: any): Plan {
    const steps: PlanStep[] = Array.isArray(plan.steps) ? plan.steps : [];
    let contingencies: Map<string, PlanStep[]>;
    if (plan.contingencies instanceof Map) {
      contingencies = plan.contingencies;
    } else if (plan.contingencies && typeof plan.contingencies === 'object') {
      contingencies = new Map<string, PlanStep[]>(Object.entries(plan.contingencies));
    } else {
      contingencies = new Map<string, PlanStep[]>();
    }
    return {
      goal: plan.goal ?? '',
      steps,
      contingencies,
    };
  }

  private async runLoop(token: number) {
    try {
      while (this.isRunning && this.runToken === token && this.state && !this.abortController?.signal.aborted) {
        // Check paused state
        if (this.state.paused) {
          await this.sleep(1000);
          continue;
        }

        // C11a: plan-less sessions are driven externally via EXECUTE_TOOL
        // against the persisted session; the loop just idles until STOP_TASK.
        if (!this.state.plan) {
          await this.sleep(1000);
          continue;
        }

        if (this.state.currentStep >= this.state.plan.steps.length) {
          await this.completeTask();
          break;
        }

        const step = this.state.plan.steps[this.state.currentStep];
        if (!step) {
          await this.completeTask();
          break;
        }
        const startTime = Date.now();
        const idempotencyKey = crypto.randomUUID();

        try {
          this.broadcastUi('STEP_STARTED', { stepIndex: this.state!.currentStep, action: step.action });
          const result = await this.executeStep(step, idempotencyKey);
          // H9: post-abort short-circuit — if the task was aborted while the
          // step awaited, record nothing and run no failure handling.
          if (!this.isRunning || this.runToken !== token) break;
          const durationMs = Date.now() - startTime;

          this.state.history.push({
            stepId: step.id,
            action: step.action,
            result,
            timestamp: Date.now(),
            durationMs,
            idempotencyKey,
            pageRevision: this.state.pageRevision,
          });

          const verified = await this.verifyStep(step, result);
          if (!verified) {
            await this.handleStepFailure(step, result, idempotencyKey);
            continue;
          }

          this.broadcastUi('STEP_COMPLETED', { stepIndex: this.state!.currentStep, result: this.redactResult(result) });
          this.state.currentStep++;
          // Checkpoint isolation: a checkpoint failure must not re-enter the
          // step failure path.
          try {
            await this.maybeCheckpoint();
          } catch (e) {
            console.error('[Orchestrator] Checkpoint failed:', e);
          }

        } catch (error) {
          const result: ToolResult = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            summary: `Step failed: ${error}`,
            navigationOccurred: false,
          };
          await this.handleStepFailure(step, result, idempotencyKey);
        }
      }
    } finally {
      // H8: guaranteed reset — no matter how the loop exits, the agent is not
      // left marked running.
      this.isRunning = false;
      await this.persistState().catch(e => console.error('[Orchestrator] persist after run loop failed:', e));
    }
  }

  private async executeStep(step: PlanStep, idempotencyKey: string): Promise<ToolResult> {
    return this.executeToolCall(step.action, idempotencyKey, step.id);
  }

  /**
   * Execute a single tool call against the active session. This is the shared
   * ingress for both the internal run loop (START_TASK-with-plan) and external
   * agents driving the bridge via EXECUTE_TOOL. Arguments are schema-validated
   * before any executor runs.
   */
  async executeToolCall(toolCall: ToolCall, idempotencyKey: string, stepId = idempotencyKey): Promise<ToolResult> {
    const tool = this.toolRegistry.get(toolCall.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolCall.name}`);
    }

    const validationError = this.toolRegistry.validateArguments(toolCall);
    if (validationError) {
      throw new Error(validationError);
    }

    const domSnapshot = await this.captureDomSnapshot();
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (!tabId) throw new Error('No active tab');

    const context: ToolContext = {
      dom: domSnapshot,
      variables: this.state!.variables,
      step: toolCall,
      allowlist: this.state!.allowlist,
      tokenBudget: this.state!.tokenBudget,
      pageRevision: this.state!.pageRevision,
      sessionId: this.activeSessionId!,
      tabId,
      getCdpSession: () => this.getOrCreateCdpSession(),
    };

    let result: ToolResult;
    try {
      result = await tool.execute(toolCall.arguments, context);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Orchestrator] Tool executor threw:', toolCall.name, msg);
      result = { success: false, error: msg, summary: `${toolCall.name} failed: ${msg}`, navigationOccurred: false };
    }

    // A tool that navigated (e.g. navigate) advances the page revision so any
    // in-flight confirmation or staleness check observes the change (MOMO-129).
    if (result.navigationOccurred && this.state) {
      this.state.pageRevision++;
    }

    // Check if tool requires confirmation
    if (result.requiresConfirmation && result.confirmationData) {
      const decision = await this.awaitConfirmation(toolCall, stepId, result);
      if (decision === 'confirm') {
        // Re-execute the exact confirmed action with a one-shot pre-auth grant.
        try {
          result = await tool.execute(toolCall.arguments, { ...context, preAuthorized: true });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('[Orchestrator] Tool executor threw:', toolCall.name, msg);
          result = { success: false, error: msg, summary: `${toolCall.name} failed: ${msg}`, navigationOccurred: false };
        }
      } else if (decision === 'deny') {
        await this.abortTask('User denied confirmation');
        result = { success: false, error: 'User denied confirmation', summary: 'Confirmation denied', navigationOccurred: false };
      } else {
        await this.abortTask('User took over');
        result = { success: false, error: 'User took over', summary: 'Task taken over by user', navigationOccurred: false };
      }
    }

    return this.redactResult(result);
  }

  /** Redact any sensitive values before a tool result leaves the extension. */
  private redactResult(result: ToolResult): ToolResult {
    return {
      ...result,
      data: result.data !== undefined ? redactValue(result.data) : undefined,
      summary: redactText(result.summary),
      error: result.error ? redactText(result.error) : undefined,
      confirmationData: result.confirmationData ? {
        ...result.confirmationData,
        target: redactText(result.confirmationData.target),
        data: redactValue(result.confirmationData.data) as Record<string, unknown>,
      } : undefined,
    };
  }

  /** Attach (once) to the active tab via chrome.debugger and reuse the session. */
  async getOrCreateCdpSession(): Promise<string | null> {
    if (this.cdpBindings.sessionId) return this.cdpBindings.sessionId;
    this.cdpBindings.sessionId = await cdpLifecycle.attachCdpToActiveTab(this.cdpBindings);
    return this.cdpBindings.sessionId;
  }

  /**
   * Open a human-intervention prompt and await the decision. Both the
   * confirmation flow (awaitConfirmation) and failure escalation (escalateToHuman)
   * use this; a single pending intervention is held at a time.
   */
  private requestIntervention(
    stepId: string,
    action: ToolCall,
    payload: Record<string, unknown>,
  ): Promise<'confirm' | 'deny' | 'takeover'> {
    return confirmation.requestIntervention(this.state, stepId, action, payload);
  }

  private awaitConfirmation(action: ToolCall, stepId: string, result: ToolResult): Promise<'confirm' | 'deny' | 'takeover'> {
    return confirmation.awaitConfirmation(this.state, action, stepId, result);
  }

  private async getCurrentOrigin(): Promise<string> {
    return confirmation.getCurrentOrigin();
  }

  async handleHumanResponse(response: HumanResponse): Promise<void> {
    confirmation.handleHumanResponse(this.state, response);
  }

  private async verifyStep(step: PlanStep, result: ToolResult): Promise<boolean> {
    if (!result.success) return false;

    switch (step.verification.type) {
      case 'elementVisible':
        return await this.checkElementVisible(step.verification.selector);
      case 'elementHidden':
        return await this.checkElementHidden(step.verification.selector);
      case 'textContains':
        return await this.checkTextContains(step.verification.selector, step.verification.text);
      case 'urlMatches':
        return await this.checkUrlMatches(step.verification.pattern);
      default:
        // Unknown verification types (e.g. an LLM-emitted `custom` expression) are
        // deliberately rejected rather than evaluated — no arbitrary JS execution.
        console.warn('[Orchestrator] Unsupported verification type:', (step.verification as any).type);
        return false;
    }
  }

  private async checkElementVisible(selector: string): Promise<boolean> {
    try {
      const tabId = await this.getActiveTabId();
      if (!tabId) return false;
      let tabUrl: string | undefined;
      try {
        tabUrl = (await chrome.tabs.get(tabId)).url;
      } catch {
        return false;
      }
      if (!(await ensureHostPermission(tabUrl))) return false;
      const result = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: (sel: string) => !!document.querySelector(sel)?.checkVisibility(),
        args: [selector],
      });
      return result[0]?.result === true;
    } catch {
      return false;
    }
  }

  private async checkElementHidden(selector: string): Promise<boolean> {
    try {
      const tabId = await this.getActiveTabId();
      if (!tabId) return false;
      let tabUrl: string | undefined;
      try {
        tabUrl = (await chrome.tabs.get(tabId)).url;
      } catch {
        return false;
      }
      if (!(await ensureHostPermission(tabUrl))) return false;
      const result = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: (sel: string) => !document.querySelector(sel)?.checkVisibility(),
        args: [selector],
      });
      return result[0]?.result === true;
    } catch {
      return false;
    }
  }

  private async checkTextContains(selector: string, text: string): Promise<boolean> {
    try {
      const tabId = await this.getActiveTabId();
      if (!tabId) return false;
      let tabUrl: string | undefined;
      try {
        tabUrl = (await chrome.tabs.get(tabId)).url;
      } catch {
        return false;
      }
      if (!(await ensureHostPermission(tabUrl))) return false;
      const result = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: (sel: string, txt: string) => document.querySelector(sel)?.textContent?.includes(txt) ?? false,
        args: [selector, text],
      });
      return result[0]?.result === true;
    } catch {
      return false;
    }
  }

  private async getActiveTabId(): Promise<number | null> {
    return cdpLifecycle.getActiveTabId();
  }

  private async checkUrlMatches(pattern: string): Promise<boolean> {
    // Validate and bound the regex: a malformed pattern must fail closed (not
    // throw), and the length cap bounds ReDoS exposure against a short tab URL.
    if (!pattern || pattern.length > 200) return false;
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      return false;
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs.some(tab => regex.test(tab.url || ''));
  }

  private async handleStepFailure(step: PlanStep, result: ToolResult, idempotencyKey: string) {
    if (typeof step.onFailure === 'object' && step.onFailure.type === 'fallback') {
      const fallbackStepId = step.onFailure.stepId;
      const fallbackSteps = this.state?.plan?.contingencies.get(fallbackStepId);
      if (!fallbackSteps || !this.state?.plan) {
        // C7: a fallback action without the referenced contingency is an
        // authoring error — surface it instead of silently continuing.
        console.warn('[Orchestrator] Fallback steps missing for:', fallbackStepId);
        return;
      }
      this.state.plan.steps.splice(this.state.currentStep, 1, ...fallbackSteps);
      return;
    }

    switch (step.onFailure) {
      case 'retry': {
        // Bounded retry with exponential backoff (D5): after MAX_RETRY_ATTEMPTS
        // failed attempts for this step, escalate instead of looping forever.
        const attempts = this.state?.history.filter(h => h.stepId === step.id).length ?? 0;
        if (attempts >= MAX_RETRY_ATTEMPTS) {
          await this.escalateAndResolve(step, result);
          break;
        }
        await this.sleep(Math.min(RETRY_BACKOFF_BASE_MS * 2 ** attempts, RETRY_BACKOFF_MAX_MS));
        break;
      }
      case 'escalate':
        await this.escalateAndResolve(step, result);
        break;
      case 'abort':
        await this.abortTask(result.error || 'Aborted by failure action', true);
        break;
      default:
        // C7: unknown or missing failure actions fail closed — abort.
        await this.abortTask('Unknown failure action', true);
        break;
    }
  }

  private async escalateToHuman(step: PlanStep, result: ToolResult): Promise<'confirm' | 'deny' | 'takeover'> {
    // A failed step is escalated to the human, who decides retry / skip / abort.
    // The action arguments are redacted before they reach the side panel.
    return this.requestIntervention(step.id, step.action, {
      error: result.error ? redactText(result.error) : undefined,
      origin: await this.getCurrentOrigin(),
      action: step.action.name,
      target: this.actionTarget(step.action),
      data: redactValue(step.action.arguments),
      reversible: false,
      riskClass: this.toolRegistry.get(step.action.name)?.policy.riskClass ?? 'write',
    });
  }

  /** Resolve an escalated failure: retry (confirm), skip (deny), or hand over (takeover). */
  private async escalateAndResolve(step: PlanStep, result: ToolResult): Promise<void> {
    const decision = await this.escalateToHuman(step, result);
    if (decision === 'deny') {
      // Skip the failed step.
      if (this.state) this.state.currentStep++;
    } else if (decision === 'takeover') {
      await this.abortTask('User took over');
    }
    // 'confirm' leaves the step in place so the run loop's `continue` retries it.
  }

  private actionTarget(action: ToolCall): string {
    const args = action.arguments as Record<string, unknown>;
    if (typeof args.selector === 'string') return args.selector;
    if (typeof args.url === 'string') return args.url;
    return JSON.stringify(args);
  }

  async abortTask(reason: string, markError = false) {
    // H10: settle any pending human intervention before anything else so its
    // promise never hangs (and its auto-deny timer is cancelled).
    if (this.state?.pendingHumanIntervention) {
      const pending = this.state.pendingHumanIntervention;
      this.state.pendingHumanIntervention = null;
      if (pending.timerId) clearTimeout(pending.timerId);
      pending.reject(new Error('Task aborted'));
    }
    this.isRunning = false;
    this.abortController?.abort();
    if (this.state) {
      this.state.status = markError ? 'error' : 'idle';
      this.state.error = markError ? reason : null;
    }
    await this.detachCdpIfAttached();
    await this.persistState();
    void chrome.runtime.sendMessage({ type: 'TASK_ABORTED', payload: { reason } }).catch((err) => console.warn('[Momo] Handled error:', err));
    this.broadcastUi('STATE_UPDATE', { state: this.sanitizeStateForUi() });
  }

  /**
   * Tear down cleanly when the service worker is suspended. The abort and cache
   * invalidation happen synchronously (before any await) because neither
   * chrome.runtime.onSuspend nor beforeunload offers waitUntil(); the async
   * detach/persist may not finish before the worker is killed.
   */
  async suspend(): Promise<void> {
    // H11: settle any pending human intervention first — its promise can never
    // resolve once the worker is going away.
    if (this.state?.pendingHumanIntervention) {
      const pending = this.state.pendingHumanIntervention;
      this.state.pendingHumanIntervention = null;
      if (pending.timerId) clearTimeout(pending.timerId);
      pending.reject(new Error('Service worker suspended'));
    }
    const wasRunning = this.isRunning;
    this.isRunning = false;
    this.abortController?.abort();

    // D1: a task interrupted by service-worker suspension cannot be safely
    // resumed; mark it errored so the side panel requires an explicit restart.
    if (wasRunning && this.state) {
      this.state.status = 'error';
      this.state.error = 'Service worker suspended mid-task';
    }

    const sessionId = this.cdpBindings.sessionId;
    this.cdpBindings.sessionId = null;

    if (sessionId) {
      try {
        await this.detachCdp(sessionId);
      } catch (e) {
        console.error('[Orchestrator] CDP detach on suspend failed:', e);
      }
    }

    await this.persistState();
  }

  /** List persisted sessions (full shape) for the side panel. */
  async listSessions(): Promise<SessionSummary[]> {
    const sessions = await this.persistence.getAllSessions();
    return sessions.map(s => ({
      sessionId: s.state.sessionId,
      goal: s.state.goal,
      status: this.sessionStatus(s.state),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      stepCount: s.state.history.length,
    }));
  }

  private sessionStatus(state: AgentState): SessionSummary['status'] {
    // The live `isRunning` flag is authoritative for the in-memory active
    // session; otherwise fall back to the persisted lifecycle status.
    if (state.sessionId === this.activeSessionId && this.isRunning) {
      return 'running';
    }
    return state.status ?? 'completed';
  }

  /** Delete a persisted session and clear it from memory if it is active. */
  async deleteSession(sessionId: string): Promise<void> {
    // H11: settle any pending human intervention before touching state.
    if (this.state?.pendingHumanIntervention) {
      const pending = this.state.pendingHumanIntervention;
      this.state.pendingHumanIntervention = null;
      if (pending.timerId) clearTimeout(pending.timerId);
      pending.reject(new Error('Session deleted'));
    }
    // Only an active session owns the queue; deleting a non-active session must
    // not disrupt processing for the live one.
    if (sessionId === this.activeSessionId) {
      this.taskQueue.stopProcessing();
    }
    await this.persistence.deleteSession(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      this.state = null;
      this.isRunning = false;
      this.abortController?.abort();
    }
  }

  private async completeTask() {
    this.isRunning = false;
    if (this.state) {
      this.state.status = 'completed';
      this.state.error = null;
    }
    void chrome.runtime.sendMessage({ type: 'TASK_COMPLETED', payload: { sessionId: this.activeSessionId } }).catch((err) => console.warn('[Momo] Handled error:', err));
    this.broadcastUi('STATE_UPDATE', { state: this.sanitizeStateForUi() });
    await this.detachCdpIfAttached();
    await this.persistState();
  }

  // Public method for message router
  async captureDomSnapshot(): Promise<CompressedDom> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) throw new Error('No active tab');
    this.cdpBindings.drivingTabId = tab.id ?? null;

    if (!(await ensureHostPermission(tab.url))) {
      return this.domCompressor.compress(null, tab.url || '', tab.title || '');
    }

    // Best-effort AX tree acquisition. Both the executeScript injection and the
    // content-script message can fail on restricted pages (chrome://, a missing
    // content script); degrade to an empty DOM rather than throwing so the
    // bridge still returns a coherent (empty) result.
    let axTree: any = null;

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: () => {
          return (window as any).__axTreeSnapshot || null;
        },
      });
      axTree = results?.[0]?.result ?? null;
    } catch {
      axTree = null;
    }

    if (!axTree) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_AX_TREE' }, { frameId: 0 });
        axTree = response?.axTree ?? null;
      } catch {
        axTree = null;
      }
    }

    return this.domCompressor.compress(axTree, tab.url || '', tab.title || '');
  }

  // CDP attachment for AX tree extraction
  async attachCdpToActiveTab(): Promise<string | null> {
    return cdpLifecycle.attachCdpToActiveTab(this.cdpBindings);
  }

  async detachCdp(sessionId: string): Promise<void> {
    await cdpLifecycle.detachCdp(this.cdpBindings, sessionId);
  }

  /** Detach any active CDP session, tolerating failure (e.g. already detached). */
  private async detachCdpIfAttached(): Promise<void> {
    await cdpLifecycle.detachCdpIfAttached(this.cdpBindings);
  }

  private async maybeCheckpoint() {
    if (!this.state) return;
    if (this.state.currentStep % CHECKPOINT_INTERVAL === 0) {
      await createCheckpoint(this.state, this.persistence, this.activeSessionId!);
    }
  }

  /** UI-safe copy: strips closure-bearing fields and caps history size. */
  private sanitizeStateForUi(): Record<string, unknown> | null {
    if (!this.state) return null;
    const { pendingHumanIntervention, history, ...rest } = this.state as AgentState & { pendingHumanIntervention: unknown };
    return { ...rest, pendingHumanIntervention: null, history: history.slice(-50) };
  }
  private broadcastUi(type: string, payload: Record<string, unknown>) {
    void chrome.runtime.sendMessage({ type, payload }).catch((err) => console.warn('[Momo] Handled error:', err));
  }

  async persistState() {
    if (!this.state || !this.activeSessionId) return;
    await this.persistence.saveSession(this.activeSessionId, this.state);
    await this.persistence.saveSessionWorkingCopy(this.activeSessionId, this.state);
    if (!this.inPersistBroadcast) {
      this.inPersistBroadcast = true;
      try {
        this.broadcastUi('STATE_UPDATE', { state: this.sanitizeStateForUi() });
      } finally {
        this.inPersistBroadcast = false;
      }
    }
  }

  handleStorageChange(changes: Record<string, chrome.storage.StorageChange>) {
    // Handle external storage changes (e.g., from other browser windows)
  }

  handleTabUpdate(tabId: number, tab: chrome.tabs.Tab) {
    cdpLifecycle.handleTabUpdate(this.cdpBindings, this.state, tabId, tab);
  }

  /** H13: The user switched to a different tab — drop the CDP session bound to
   *  the previously driven tab so the next use re-attaches to the new one. */
  handleTabActivated(): void {
    cdpLifecycle.handleTabActivated(this.cdpBindings);
  }

  /** H13: The driven (or CDP-bound) tab was closed — clear the bindings and
   *  detach so nothing reuses a stale session. */
  handleTabRemoved(tabId: number): void {
    cdpLifecycle.handleTabRemoved(this.cdpBindings, tabId);
  }

  /** H22: Expose the tab bound to the live CDP session (used by the message
   *  router to correlate CDP traffic with its tab). */
  getCdpSessionTabId(): number | null {
    return cdpLifecycle.getCdpSessionTabId(this.cdpBindings);
  }

  // Pause/resume functionality
  async pause() {
    if (this.state) {
      this.state.paused = true;
      await this.persistState();
      this.broadcastUi('STATE_UPDATE', { state: this.sanitizeStateForUi() });
    }
  }

  /**
   * Load a specific persisted session by id and resume it (clear its pause
   * flag). Unlike the previous in-memory-only `resume()`, this activates the
   * exact session the caller asked for rather than whatever happens to be the
   * current `this.state` (BUG 6).
   */
  async resumeSession(sessionId: string): Promise<void> {
    if (this.isRunning) {
      throw new Error('Agent already running — stop it before resuming another session');
    }
    // Same-lifetime pause → resume: keep the live in-memory state (fresher than
    // any persisted snapshot); never replace it with a stale/redacted copy.
    if (this.activeSessionId === sessionId && this.state) {
      this.state.paused = false;
      await this.persistState();
      this.broadcastUi('STATE_UPDATE', { state: this.sanitizeStateForUi() });
      return;
    }
    const session = await this.persistence.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    // Prefer the unredacted working copy (local resume artifact). If only the
    // redacted public copy exists, refuse to auto-execute redacted arguments.
    const working = await this.persistence.loadSessionWorkingCopy(sessionId);
    const state = (working ?? session) as AgentState;
    state.pendingHumanIntervention = null; // closures never survive persistence
    this.state = state;
    this.activeSessionId = sessionId;
    this.state.paused = false;
    if (this.state.plan && this.state.plan.steps.length > this.state.currentStep) {
      if (!working) {
        this.state.status = 'error';
        this.state.error = 'Resume requires an unredacted working copy, which is unavailable';
        await this.persistState();
        this.broadcastUi('STATE_UPDATE', { state: this.sanitizeStateForUi() });
        return;
      }
      this.state.status = 'running';
      this.state.error = null;
      this.isRunning = true;
      this.abortController = new AbortController();
      this.taskQueue.startProcessing(sessionId, this.taskProcessor.bind(this));
      const token = ++this.runToken;
      void this.runLoop(token).catch(e => { console.error('[Orchestrator] resumed runLoop crashed:', e); this.isRunning = false; });
    } else {
      await this.persistState();
      this.broadcastUi('STATE_UPDATE', { state: this.sanitizeStateForUi() });
    }
  }

  getState(): AgentState | null {
    return this.state;
  }

  isActive(): boolean {
    return this.isRunning;
  }

  /** Expose the full tool catalog (name, description, JSON-schema params, policy). */
  listTools(): Record<string, unknown>[] {
    return this.toolRegistry.getSchemas();
  }

  private async taskProcessor(entry: any) {
    // Background task processor for periodic observations, cleanup, etc.
    switch (entry.type) {
      case 'periodic_observation':
        await this.captureDomSnapshot();
        break;
      case 'sync_state':
        await this.syncWithBridge();
        break;
    }
  }

  private async syncWithBridge() {
    // The retired native-messaging path (`sendNativeMessage('agent.bridge')`)
    // is gone; state sync / liveness now rides the WebSocket client.
    try {
      getWsClient().ping();
    } catch {
      // WS client not yet connected; nothing to sync.
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export interface TaskPolicy {
  allowlist: string[];
  permittedActions: string[];
  confirmationPolicy: 'always' | 'sensitive' | 'never';
  dataRetention: 'session' | 'persistent';
}

// Task Queue Types (moved here to avoid circular imports)
export type TaskType = 'periodic_observation' | 'cleanup' | 'sync_state' | 'custom';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'dead';

export type WalOperation =
  | 'StateUpdate'
  | 'ActionExecuted'
  | 'CheckpointCreated'
  | 'TaskQueued'
  | 'TaskCompleted'
  | 'TaskFailed';

export interface WalEntry {
  id: number;
  timestamp: number;
  operation: WalOperation;
  data: unknown;
}

/** Bridge request/response types for WebSocket protocol. */
export interface BridgeRequest {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface BridgeResponse {
  type: 'Ok' | 'Error' | 'Event' | 'Command' | 'StreamChunk' | 'StreamEnd';
  payload: BridgeResponsePayload;
}

export interface BridgeResponsePayload {
  request_id?: string;
  data?: unknown;
  code?: number;
  message?: string;
  event?: string;
  chunk?: unknown;
  command?: string;
  params?: unknown;
}

/** Bridge → extension command (PHASE9_MCP_PLAN.md §6). The extension answers
 * with a `CommandResult` bridge request carrying the same `request_id`. */
export interface BridgeCommand {
  request_id: string;
  command: string;
  params: unknown;
}

export interface BridgeEvent {
  event: string;
  data: unknown;
}

export interface TaskQueueEntry {
  id: string;
  sessionId: string;
  type: TaskType;
  payload: unknown;
  priority: number;
  deadline: number;
  retryPolicy: RetryPolicy;
  attempts: number;
  status: TaskStatus;
}