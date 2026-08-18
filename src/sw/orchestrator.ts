import { PersistenceManager } from '../lib/persistence.js';
import { ToolRegistry, ToolContext } from '../lib/tool-registry.js';
import { DomCompressor } from '../lib/dom-compressor.js';
import { redactText, redactValue } from '../lib/redaction.js';
import { TaskQueue } from '../lib/task-queue.js';
import { cdpAdapter } from './cdp-adapter.js';

/** How long to wait for a human confirmation before auto-denying (MOMO-045). */
const CONFIRMATION_TIMEOUT_MS = 60_000;
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
  private abortController: AbortController | null = null;
  private cdpSessionId: string | null = null;

  constructor(persistence: PersistenceManager) {
    this.persistence = persistence;
    this.toolRegistry = new ToolRegistry();
    this.domCompressor = new DomCompressor();
    this.taskQueue = new TaskQueue(persistence);

    // When a CDP session detaches (tab close, navigation, external debugger),
    // drop the cached session id so the next use re-attaches instead of reusing
    // a stale session (MOMO-038/050).
    cdpAdapter.onSessionDetached((sessionId) => {
      if (this.cdpSessionId === sessionId) {
        this.cdpSessionId = null;
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
      plan: options?.plan || null,
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

    await this.persistState();

    // The extension is a pure automation bridge: it does not plan. When no plan
    // is supplied, external agents drive execution via EXECUTE_TOOL against the
    // persisted session. The run loop simply stays idle (no steps to run).
    if (options?.plan) {
      this.state.plan = options.plan;
    }

    // Start task queue for this session
    this.taskQueue.startProcessing(sessionId, this.taskProcessor.bind(this));

    this.runLoop();
  }

  private async runLoop() {
    while (this.isRunning && this.state && !this.abortController?.signal.aborted) {
      // Check paused state
      if (this.state.paused) {
        await this.sleep(1000);
        continue;
      }

      if (!this.state.plan || this.state.currentStep >= this.state.plan.steps.length) {
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
        const result = await this.executeStep(step, idempotencyKey);
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

        this.state.currentStep++;
        await this.maybeCheckpoint();

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

    this.isRunning = false;
    await this.persistState();
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

    let result = await tool.execute(toolCall.arguments, context);

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
        result = await tool.execute(toolCall.arguments, { ...context, preAuthorized: true });
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
    if (this.cdpSessionId) return this.cdpSessionId;
    this.cdpSessionId = await this.attachCdpToActiveTab();
    return this.cdpSessionId;
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
    return new Promise((resolve, reject) => {
      if (!this.state) {
        reject(new Error('No active state'));
        return;
      }

      const actionHash = this.hashAction(action);

      this.state.pendingHumanIntervention = {
        resolve,
        reject,
        stepId,
        actionHash,
        pageRevision: this.state.pageRevision,
      };

      // Auto-deny if the human doesn't respond within the timeout (MOMO-045).
      setTimeout(() => {
        if (this.state?.pendingHumanIntervention?.actionHash === actionHash) {
          this.resolveIntervention('deny');
        }
      }, CONFIRMATION_TIMEOUT_MS);

      chrome.runtime.sendMessage({
        type: 'HUMAN_INTERVENTION_REQUIRED',
        payload: {
          stepId,
          actionHash,
          pageRevision: this.state.pageRevision,
          ...payload,
        },
      });
    });
  }

  private awaitConfirmation(action: ToolCall, stepId: string, result: ToolResult): Promise<'confirm' | 'deny' | 'takeover'> {
    const confirmationData = result.confirmationData;
    if (!confirmationData) {
      throw new Error('Confirmation requested without confirmation data');
    }

    return this.requestIntervention(stepId, action, {
      origin: confirmationData.origin,
      action: action.name,
      target: confirmationData.target,
      // Use the tool's redacted confirmation payload, not the raw arguments
      // (which may include typed text) — MOMO-041.
      data: confirmationData.data,
      reversible: confirmationData.reversible,
      riskClass: confirmationData.riskClass,
    });
  }

  private hashAction(action: ToolCall): string {
    // Simple hash for binding confirmation to specific action
    const str = JSON.stringify(action);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash.toString(16);
  }

  private async getCurrentOrigin(): Promise<string> {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tabs[0]?.url;
      if (!url) return 'unknown';
      const origin = new URL(url).origin;
      // `chrome://`, `about:blank`, etc. report origin `'null'` — treat as unknown.
      return origin && origin !== 'null' ? origin : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async handleHumanResponse(response: HumanResponse) {
    if (!this.state?.pendingHumanIntervention) return;

    const pending = this.state.pendingHumanIntervention;
    // Bind the response to the exact action that requested confirmation (replay).
    if (response.actionHash !== pending.actionHash) {
      pending.reject(new Error('Replayed human response'));
      this.state.pendingHumanIntervention = null;
      return;
    }
    // The page must not have navigated since the confirmation was shown. Compare
    // the echoed revision against the *current* one, not the captured one.
    if (response.pageRevision !== this.state.pageRevision) {
      pending.reject(new Error('Stale human response: page changed'));
      this.state.pendingHumanIntervention = null;
      return;
    }

    this.resolveIntervention(response.action);
  }

  private resolveIntervention(decision: 'confirm' | 'deny' | 'takeover') {
    const state = this.state;
    const pending = state?.pendingHumanIntervention;
    if (!state || !pending) return;
    state.pendingHumanIntervention = null;
    pending.resolve(decision);
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
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? null;
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
      if (fallbackSteps && this.state?.plan) {
        this.state.plan.steps.splice(this.state.currentStep, 1, ...fallbackSteps);
      }
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
    }
  }

  private async escalateToHuman(step: PlanStep, result: ToolResult): Promise<'confirm' | 'deny' | 'takeover'> {
    // A failed step is escalated to the human, who decides retry / skip / abort.
    // The action arguments are redacted before they reach the side panel.
    return this.requestIntervention(step.id, step.action, {
      error: result.error,
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
    this.isRunning = false;
    this.abortController?.abort();
    if (this.state) {
      this.state.status = markError ? 'error' : 'idle';
      this.state.error = markError ? reason : null;
    }
    await this.detachCdpIfAttached();
    await this.persistState();
    chrome.runtime.sendMessage({ type: 'TASK_ABORTED', payload: { reason } });
  }

  /**
   * Tear down cleanly when the service worker is suspended. The abort and cache
   * invalidation happen synchronously (before any await) because neither
   * chrome.runtime.onSuspend nor beforeunload offers waitUntil(); the async
   * detach/persist may not finish before the worker is killed.
   */
  async suspend(): Promise<void> {
    const wasRunning = this.isRunning;
    this.isRunning = false;
    this.abortController?.abort();

    // D1: a task interrupted by service-worker suspension cannot be safely
    // resumed; mark it errored so the side panel requires an explicit restart.
    if (wasRunning && this.state) {
      this.state.status = 'error';
      this.state.error = 'Service worker suspended mid-task';
    }

    const sessionId = this.cdpSessionId;
    this.cdpSessionId = null;

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
    this.taskQueue.stopProcessing();
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
    chrome.runtime.sendMessage({ type: 'TASK_COMPLETED', payload: { sessionId: this.activeSessionId } });
    await this.detachCdpIfAttached();
    await this.persistState();
  }

  // Public method for message router
  async captureDomSnapshot(): Promise<CompressedDom> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) throw new Error('No active tab');

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
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_AX_TREE' });
        axTree = response?.axTree ?? null;
      } catch {
        axTree = null;
      }
    }

    return this.domCompressor.compress(axTree, tab.url || '', tab.title || '');
  }

  // CDP attachment for AX tree extraction
  async attachCdpToActiveTab(): Promise<string | null> {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];
      if (!activeTab?.url) {
        console.log('[Orchestrator] No active tab');
        return null;
      }

      // Attach the debugger target that matches the *active* tab (by URL), not
      // the first unattached page target, which may be a background tab.
      const targets = await cdpAdapter.getTargets();
      const target = targets.find(t => t.type === 'page' && t.url === activeTab.url);
      if (!target) {
        console.log('[Orchestrator] No CDP target for active tab:', activeTab.url);
        return null;
      }

      const sessionId = await cdpAdapter.attach(target.targetId);

      // Notify content script of CDP attachment
      if (activeTab.id) {
        chrome.tabs.sendMessage(activeTab.id, {
          type: 'CDP_ATTACHED',
          payload: { sessionId }
        });
      }

      return sessionId;
    } catch (e) {
      console.error('[Orchestrator] CDP attach failed:', e);
      return null;
    }
  }

  async detachCdp(sessionId: string): Promise<void> {
    await cdpAdapter.detach(sessionId);

    // Invalidate the cached session id so a subsequent getOrCreateCdpSession
    // re-attaches instead of reusing a stale session.
    if (this.cdpSessionId === sessionId) {
      this.cdpSessionId = null;
    }

    // Notify content script
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id!, { type: 'CDP_DETACHED' });
    }
  }

  /** Detach any active CDP session, tolerating failure (e.g. already detached). */
  private async detachCdpIfAttached(): Promise<void> {
    const sessionId = this.cdpSessionId;
    if (!sessionId) return;
    this.cdpSessionId = null;
    try {
      await this.detachCdp(sessionId);
    } catch (e) {
      console.error('[Orchestrator] CDP detach failed:', e);
    }
  }

  private async maybeCheckpoint() {
    if (!this.state) return;

    const CHECKPOINT_INTERVAL = 5;
    if (this.state.currentStep % CHECKPOINT_INTERVAL === 0) {
      await this.createCheckpoint();
    }
  }

  private async createCheckpoint() {
    if (!this.state) return;

    const checkpoint: Checkpoint = {
      stepIndex: this.state.currentStep,
      stateSnapshot: {
        goal: this.state.goal,
        currentStep: this.state.currentStep,
        variables: this.state.variables,
        historyLength: this.state.history.length,
        pageRevision: this.state.pageRevision,
      },
      walPosition: await this.persistence.getWalPosition(),
      timestamp: Date.now(),
    };

    this.state.checkpoints.push(checkpoint);
    await this.persistence.saveCheckpoint(this.activeSessionId!, checkpoint);
  }

  async persistState() {
    if (!this.state || !this.activeSessionId) return;
    await this.persistence.saveSession(this.activeSessionId, this.state);
  }

  handleStorageChange(changes: Record<string, chrome.storage.StorageChange>) {
    // Handle external storage changes (e.g., from other browser windows)
  }

  handleTabUpdate(tabId: number, tab: chrome.tabs.Tab) {
    if (tab.url && this.state) {
      // Only count navigation of the tab the agent is driving, so background
      // tab loads don't falsely invalidate an in-flight human confirmation.
      if (tab.active) {
        this.state.pageRevision++;
        // Navigation may invalidate the CDP target id — drop the cached session
        // so the next use re-attaches to the current target.
        if (this.cdpSessionId) {
          const sid = this.cdpSessionId;
          this.cdpSessionId = null;
          void this.detachCdp(sid).catch(e => {
            console.error('[Orchestrator] CDP detach after navigation failed:', e);
          });
        }
      }
    }
  }

  // Pause/resume functionality
  pause() {
    if (this.state) {
      this.state.paused = true;
      this.persistState();
    }
  }

  resume() {
    if (this.state) {
      this.state.paused = false;
      this.persistState();
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
    try {
      await chrome.runtime.sendNativeMessage('agent.bridge', { type: 'PING' });
    } catch {
      // Bridge not available
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
  type: 'Ok' | 'Error' | 'Event' | 'StreamChunk' | 'StreamEnd';
  payload: BridgeResponsePayload;
}

export interface BridgeResponsePayload {
  request_id?: string;
  data?: unknown;
  code?: number;
  message?: string;
  event?: string;
  chunk?: unknown;
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