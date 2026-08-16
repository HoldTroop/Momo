import { PersistenceManager } from '../lib/persistence.js';
import { ToolRegistry } from '../lib/tool-registry.js';
import { DomCompressor } from '../lib/dom-compressor.js';
import { LlmClient } from '../lib/llm-client.js';
import { TaskQueue } from '../lib/task-queue.js';
import { cdpAdapter } from './cdp-adapter.js';

export interface AgentState {
  sessionId: string;
  goal: string;
  plan: Plan | null;
  currentStep: number;
  history: ExecutionStep[];
  domCache: Map<string, CompressedDom>;
  variables: Record<string, unknown>;
  checkpoints: Checkpoint[];
  // New fields for policy compliance
  paused: boolean;
  pageRevision: number;
  allowlist: string[];
  tokenBudget: { max: number; used: number };
  pendingHumanIntervention: HumanInterventionState | null;
}

export interface HumanInterventionState {
  resolve: (response: HumanResponse) => void;
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
  | { type: 'urlMatches'; pattern: string }
  | { type: 'custom'; expression: string };

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

export class AgentOrchestrator {
  private persistence: PersistenceManager;
  private toolRegistry: ToolRegistry;
  private domCompressor: DomCompressor;
  private llmClient: LlmClient;
  private taskQueue: TaskQueue;

  private state: AgentState | null = null;
  private activeSessionId: string | null = null;
  private isRunning = false;
  private abortController: AbortController | null = null;

  constructor(persistence: PersistenceManager) {
    this.persistence = persistence;
    this.toolRegistry = new ToolRegistry();
    this.domCompressor = new DomCompressor();
    this.llmClient = new LlmClient();
    this.taskQueue = new TaskQueue(persistence);
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
    if (sessions.length > 0) {
      this.state = sessions[0];
      this.activeSessionId = this.state.sessionId;
      console.log('[Orchestrator] Resumed session:', this.activeSessionId);
    }
  }

  async startTask(goal: string, options?: { sessionId?: string; plan?: Plan; policy?: TaskPolicy }) {
    if (this.isRunning) {
      throw new Error('Agent already running');
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
      domCache: new Map(),
      variables: {},
      checkpoints: [],
      paused: false,
      pageRevision: 0,
      allowlist: policy.allowlist,
      tokenBudget: { max: 100000, used: 0 },
      pendingHumanIntervention: null,
    };

    await this.persistState();

    if (!options?.plan) {
      await this.createPlan(goal);
    }

    // Start task queue for this session
    this.taskQueue.startProcessing(sessionId, this.taskProcessor.bind(this));

    this.runLoop();
  }

  private async createPlan(goal: string) {
    const domSnapshot = await this.captureDomSnapshot();
    const plan = await this.llmClient.createPlan(goal, domSnapshot, this.state!.variables);
    this.state!.plan = plan;
    await this.persistState();
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
    const tool = this.toolRegistry.get(step.action.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${step.action.name}`);
    }

    const domSnapshot = await this.captureDomSnapshot();
    const context = {
      dom: domSnapshot,
      variables: this.state!.variables,
      step: step.action,
    };

    const result = await tool.execute(step.action.arguments, context);

    // Check if tool requires confirmation
    if (result.requiresConfirmation && result.confirmationData) {
      return await this.requestConfirmation(step, result, idempotencyKey);
    }

    return result;
  }

  private async requestConfirmation(step: PlanStep, result: ToolResult, idempotencyKey: string): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      if (!this.state) {
        reject(new Error('No active state'));
        return;
      }

      const actionHash = this.hashAction(step.action);

      this.state.pendingHumanIntervention = {
        resolve: (response: HumanResponse) => {
          if (response.action === 'confirm') {
            resolve({ ...result, success: true });
          } else if (response.action === 'deny') {
            resolve({ ...result, success: false, error: 'User denied confirmation' });
          } else {
            // takeover - abort task
            reject(new Error('User took over'));
          }
        },
        reject,
        stepId: step.id,
        actionHash,
        pageRevision: this.state.pageRevision,
      };

      chrome.runtime.sendMessage({
        type: 'HUMAN_INTERVENTION_REQUIRED',
        payload: {
          stepId: step.id,
          origin: this.getCurrentOrigin(),
          action: step.action.name,
          target: result.confirmationData.target,
          data: step.action.arguments,
          reversible: result.confirmationData.reversible,
          riskClass: result.confirmationData.riskClass,
          actionHash,
          pageRevision: this.state.pageRevision,
        },
      });
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

  private getCurrentOrigin(): string {
    // Would be tracked from active tab
    return 'unknown';
  }

  async handleHumanResponse(response: HumanResponse) {
    if (!this.state?.pendingHumanIntervention) return;

    const pending = this.state.pendingHumanIntervention;
    // Verify action hash and page revision match (prevent replay/stale)
    if (response.actionHash !== pending.actionHash || response.pageRevision !== pending.pageRevision) {
      pending.reject(new Error('Stale or replayed human response'));
      this.state.pendingHumanIntervention = null;
      return;
    }

    pending.resolve(response);
    this.state.pendingHumanIntervention = null;
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
      case 'custom':
        return await this.evalCustomVerification(step.verification.expression);
    }
  }

  private async checkElementVisible(selector: string): Promise<boolean> {
    try {
      const result = await chrome.scripting.executeScript({
        target: { allFrames: true },
        func: (sel) => !!document.querySelector(sel)?.checkVisibility(),
        args: [selector],
      });
      return result[0]?.result === true;
    } catch {
      return false;
    }
  }

  private async checkElementHidden(selector: string): Promise<boolean> {
    try {
      const result = await chrome.scripting.executeScript({
        target: { allFrames: true },
        func: (sel) => !document.querySelector(sel)?.checkVisibility(),
        args: [selector],
      });
      return result[0]?.result === true;
    } catch {
      return false;
    }
  }

  private async checkTextContains(selector: string, text: string): Promise<boolean> {
    try {
      const result = await chrome.scripting.executeScript({
        target: { allFrames: true },
        func: (sel, txt) => document.querySelector(sel)?.textContent?.includes(txt) ?? false,
        args: [selector, text],
      });
      return result[0]?.result === true;
    } catch {
      return false;
    }
  }

  private async checkUrlMatches(pattern: string): Promise<boolean> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs.some(tab => new RegExp(pattern).test(tab.url || ''));
  }

  private async evalCustomVerification(expression: string): Promise<boolean> {
    try {
      const result = await chrome.scripting.executeScript({
        target: { allFrames: true },
        func: (expr) => eval(expr),
        args: [expression],
      });
      return result[0]?.result === true;
    } catch {
      return false;
    }
  }

  private async handleStepFailure(step: PlanStep, result: ToolResult, idempotencyKey: string) {
    switch (step.onFailure) {
      case 'retry':
        // Retry same step (will loop) - idempotency key prevents duplicate execution
        break;
      case 'fallback':
        if (typeof step.onFailure === 'object' && step.onFailure.type === 'fallback') {
          const fallbackStepId = step.onFailure.stepId;
          if (this.state?.plan?.contingencies[fallbackStepId]) {
            this.state.plan.steps.splice(this.state.currentStep, 1, ...this.state.plan.contingencies[fallbackStepId]);
          }
        }
        break;
      case 'escalate':
        await this.escalateToHuman(step, result);
        break;
      case 'abort':
        await this.abortTask(result.error || 'Aborted by failure action');
        break;
    }
  }

  private async escalateToHuman(step: PlanStep, result: ToolResult) {
    // Send to side panel for human intervention
    chrome.runtime.sendMessage({
      type: 'HUMAN_INTERVENTION_REQUIRED',
      payload: {
        stepId: step.id,
        error: result.error,
        context: step.action,
        actionHash: this.hashAction(step.action),
        pageRevision: this.state?.pageRevision || 0,
      },
    });
    this.abortController?.abort();
  }

  private async abortTask(reason: string) {
    this.isRunning = false;
    await this.persistState();
    chrome.runtime.sendMessage({ type: 'TASK_ABORTED', payload: { reason } });
  }

  private async completeTask() {
    this.isRunning = false;
    chrome.runtime.sendMessage({ type: 'TASK_COMPLETED', payload: { sessionId: this.activeSessionId } });
    await this.persistState();
  }

  // Public method for message router
  async captureDomSnapshot(): Promise<CompressedDom> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab.id) throw new Error('No active tab');

    // Check if we have a cached AX tree from content script
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        return (window as any).__axTreeSnapshot || null;
      },
    });

    let axTree = results[0]?.result;
    if (!axTree) {
      // Request fresh snapshot from content script
      const response = await chrome.tabs.sendMessage(tab.id!, { type: 'GET_AX_TREE' });
      axTree = response?.axTree;
    }

    return this.domCompressor.compress(axTree, tab.url || '', tab.title || '');
  }

  // CDP attachment for AX tree extraction
  async attachCdpToActiveTab(): Promise<string | null> {
    try {
      const targets = await cdpAdapter.getTargets();
      const activeTab = targets.find(t => t.type === 'page' && t.url && !t.attached);
      if (!activeTab) {
        console.log('[Orchestrator] No suitable CDP target found');
        return null;
      }

      const sessionId = await cdpAdapter.attach(activeTab.targetId);

      // Notify content script of CDP attachment
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id!, {
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

    // Notify content script
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id!, { type: 'CDP_DETACHED' });
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
    // Invalidate DOM cache for updated tab
    if (tab.url && this.state) {
      this.state.domCache.delete(tab.url);
      // Increment page revision on navigation
      this.state.pageRevision++;
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

  private async taskProcessor(entry: any) {
    // Background task processor for periodic observations, cleanup, etc.
    switch (entry.type) {
      case 'periodic_observation':
        await this.captureDomSnapshot();
        break;
      case 'cleanup':
        this.cleanupOldCache();
        break;
      case 'sync_state':
        await this.syncWithBridge();
        break;
    }
  }

  private cleanupOldCache() {
    if (!this.state) return;
    const now = Date.now();
    const MAX_AGE = 5 * 60 * 1000; // 5 minutes
    for (const [url, dom] of this.state.domCache) {
      if (now - dom.timestamp > MAX_AGE) {
        this.state.domCache.delete(url);
      }
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

export interface TaskQueueEntry {
  id: string;
  type: TaskType;
  payload: unknown;
  priority: number;
  deadline: number;
  retryPolicy: RetryPolicy;
  attempts: number;
  status: TaskStatus;
}