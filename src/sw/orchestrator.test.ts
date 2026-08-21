import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentOrchestrator, type AgentState, type Plan, type PlanStep } from './orchestrator.js';
import { PersistenceManager } from '../lib/persistence.js';
import { ToolRegistry } from '../lib/tool-registry.js';

// Mock dependencies
vi.mock('../lib/persistence.js');
vi.mock('../lib/tool-registry.js');
vi.mock('../lib/dom-compressor.js');
vi.mock('../lib/task-queue.js');
vi.mock('./cdp-adapter.js', () => ({
  cdpAdapter: {
    onSessionDetached: vi.fn(),
  },
}));
vi.mock('./ws-client.js', () => ({
  getWsClient: vi.fn(() => ({ ping: vi.fn() })),
}));
vi.mock('./confirmation.js', () => ({
  requestIntervention: vi.fn(),
  awaitConfirmation: vi.fn(),
  getCurrentOrigin: vi.fn(() => Promise.resolve('https://example.com')),
  handleHumanResponse: vi.fn(),
}));
vi.mock('./cdp-lifecycle.js', () => ({
  createCdpBindings: vi.fn(() => ({ sessionId: null, drivingTabId: null })),
  attachCdpToActiveTab: vi.fn(),
  detachCdp: vi.fn(),
  detachCdpIfAttached: vi.fn(),
  getActiveTabId: vi.fn(() => Promise.resolve(1)),
  handleTabUpdate: vi.fn(),
  handleTabActivated: vi.fn(),
  handleTabRemoved: vi.fn(),
  getCdpSessionTabId: vi.fn(() => null),
}));
vi.mock('./checkpoint.js', () => ({
  CHECKPOINT_INTERVAL: 5,
  createCheckpoint: vi.fn(),
}));

// Mock Chrome APIs
const mockChrome = {
  tabs: {
    query: vi.fn(() => Promise.resolve([{ id: 1, url: 'https://example.com', title: 'Test' }])),
    get: vi.fn(() => Promise.resolve({ id: 1, url: 'https://example.com' })),
    sendMessage: vi.fn(),
  },
  scripting: {
    executeScript: vi.fn(() => Promise.resolve([{ result: null }])),
  },
  runtime: {
    sendMessage: vi.fn(() => Promise.resolve()),
  },
  permissions: {
    contains: vi.fn(() => Promise.resolve(true)),
    request: vi.fn(() => Promise.resolve(true)),
  },
};
vi.stubGlobal('chrome', mockChrome);
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid-123' });

describe('AgentOrchestrator State Machine', () => {
  let orchestrator: AgentOrchestrator;
  let mockPersistence: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPersistence = {
      init: vi.fn(() => Promise.resolve()),
      getAllSessions: vi.fn(() => Promise.resolve([])),
      saveSession: vi.fn(() => Promise.resolve()),
      saveSessionWorkingCopy: vi.fn(() => Promise.resolve()),
      getSession: vi.fn(() => Promise.resolve(null)),
      loadSessionWorkingCopy: vi.fn(() => Promise.resolve(null)),
      deleteSession: vi.fn(() => Promise.resolve()),
    };

    vi.mocked(PersistenceManager).mockImplementation(() => mockPersistence);
    orchestrator = new AgentOrchestrator(mockPersistence);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('State Transition: idle → running on startTask()', () => {
    it('should transition from idle to running when startTask is called', async () => {
      await orchestrator.init();

      const goal = 'Test goal';
      const plan: Plan = {
        goal,
        steps: [
          {
            id: 'step-1',
            action: { name: 'test-tool', arguments: {} },
            expectedOutcome: 'success',
            verification: { type: 'urlMatches', pattern: '.*' },
            onFailure: 'abort',
          },
        ],
        contingencies: new Map(),
      };

      await orchestrator.startTask(goal, { plan });

      const state = orchestrator.getState();
      expect(state).not.toBeNull();
      expect(state?.status).toBe('running');
      expect(state?.goal).toBe(goal);
      expect(orchestrator.isActive()).toBe(true);
    });

    it('should throw error if agent is already running', async () => {
      await orchestrator.init();

      const plan: Plan = {
        goal: 'Test',
        steps: [
          {
            id: 'step-1',
            action: { name: 'test-tool', arguments: {} },
            expectedOutcome: 'success',
            verification: { type: 'urlMatches', pattern: '.*' },
            onFailure: 'abort',
          },
        ],
        contingencies: new Map(),
      };

      await orchestrator.startTask('Goal 1', { plan });

      await expect(orchestrator.startTask('Goal 2', { plan })).rejects.toThrow('Agent already running');
    });

    it('should initialize state with correct defaults', async () => {
      await orchestrator.init();

      const goal = 'Test goal';
      const plan: Plan = {
        goal,
        steps: [
          {
            id: 'step-1',
            action: { name: 'test-tool', arguments: {} },
            expectedOutcome: 'success',
            verification: { type: 'urlMatches', pattern: '.*' },
            onFailure: 'abort',
          },
        ],
        contingencies: new Map(),
      };

      await orchestrator.startTask(goal, { plan });

      const state = orchestrator.getState();
      expect(state?.sessionId).toBe('test-uuid-123');
      expect(state?.currentStep).toBe(0);
      expect(state?.history).toEqual([]);
      expect(state?.paused).toBe(false);
      expect(state?.pageRevision).toBe(0);
      expect(state?.status).toBe('running');
      expect(state?.error).toBeNull();
    });

    it('should reject empty plan with error', async () => {
      await orchestrator.init();

      const emptyPlan: Plan = {
        goal: 'Test',
        steps: [],
        contingencies: new Map(),
      };

      await expect(orchestrator.startTask('Test', { plan: emptyPlan })).rejects.toThrow('Plan has no steps');
    });
  });

  describe('State Transition: running → completed on success', () => {
    it('should transition to completed when all steps are executed', async () => {
      await orchestrator.init();

      const plan: Plan = {
        goal: 'Test',
        steps: [
          {
            id: 'step-1',
            action: { name: 'test-tool', arguments: {} },
            expectedOutcome: 'success',
            verification: { type: 'urlMatches', pattern: '.*' },
            onFailure: 'abort',
          },
        ],
        contingencies: new Map(),
      };

      // Mock tool registry
      const mockTool = {
        execute: vi.fn(() => Promise.resolve({
          success: true,
          summary: 'Success',
          navigationOccurred: false,
        })),
        policy: { riskClass: 'read' },
      };

      vi.spyOn(ToolRegistry.prototype, 'get').mockReturnValue(mockTool as any);
      vi.spyOn(ToolRegistry.prototype, 'validateArguments').mockReturnValue(null);

      await orchestrator.startTask('Test', { plan });

      // Wait for async execution
      await new Promise(resolve => setTimeout(resolve, 100));

      const state = orchestrator.getState();
      expect(state?.status).toBe('completed');
      expect(state?.error).toBeNull();
      expect(orchestrator.isActive()).toBe(false);
    });
  });

  describe('State Transition: running → error on failure', () => {
    it('should transition to error on abort failure', async () => {
      await orchestrator.init();

      const plan: Plan = {
        goal: 'Test',
        steps: [
          {
            id: 'step-1',
            action: { name: 'test-tool', arguments: {} },
            expectedOutcome: 'success',
            verification: { type: 'urlMatches', pattern: '.*' },
            onFailure: 'abort',
          },
        ],
        contingencies: new Map(),
      };

      // Mock tool that fails
      const mockTool = {
        execute: vi.fn(() => Promise.resolve({
          success: false,
          error: 'Tool failed',
          summary: 'Failed',
          navigationOccurred: false,
        })),
        policy: { riskClass: 'write' },
      };

      vi.spyOn(ToolRegistry.prototype, 'get').mockReturnValue(mockTool as any);
      vi.spyOn(ToolRegistry.prototype, 'validateArguments').mockReturnValue(null);

      await orchestrator.startTask('Test', { plan });

      // Wait for async execution
      await new Promise(resolve => setTimeout(resolve, 100));

      const state = orchestrator.getState();
      expect(state?.status).toBe('error');
      expect(state?.error).toBeTruthy();
      expect(orchestrator.isActive()).toBe(false);
    });

    it('should mark interrupted session as error on load', async () => {
      const interruptedState: AgentState = {
        sessionId: 'test-123',
        goal: 'Test',
        plan: null,
        currentStep: 0,
        history: [],
        variables: {},
        checkpoints: [],
        paused: false,
        pageRevision: 0,
        allowlist: [],
        tokenBudget: { max: 100000, used: 0 },
        pendingHumanIntervention: null,
        status: 'running',
        error: null,
      };

      mockPersistence.getAllSessions.mockResolvedValue([
        { state: interruptedState, createdAt: Date.now(), updatedAt: Date.now() },
      ]);

      await orchestrator.init();

      const state = orchestrator.getState();
      expect(state?.status).toBe('error');
      expect(state?.error).toBe('Interrupted by service worker restart');
      expect(mockPersistence.saveSession).toHaveBeenCalled();
    });
  });

  describe('Confirmation timeout handling', () => {
    it('should handle confirmation requirement from tool', async () => {
      await orchestrator.init();

      const confirmationMock = vi.fn<() => Promise<'confirm' | 'deny' | 'takeover'>>(() => Promise.resolve('confirm'));
      const { awaitConfirmation } = await import('./confirmation.js');
      vi.mocked(awaitConfirmation).mockImplementation(confirmationMock);

      const plan: Plan = {
        goal: 'Test',
        steps: [
          {
            id: 'step-1',
            action: { name: 'sensitive-tool', arguments: {} },
            expectedOutcome: 'success',
            verification: { type: 'urlMatches', pattern: '.*' },
            onFailure: 'abort',
          },
        ],
        contingencies: new Map(),
      };

      let callCount = 0;
      const mockTool = {
        execute: vi.fn((args: any, context: any) => {
          callCount++;
          if (callCount === 1 && !context.preAuthorized) {
            return Promise.resolve({
              success: true,
              summary: 'Needs confirmation',
              navigationOccurred: false,
              requiresConfirmation: true,
              confirmationData: {
                origin: 'https://example.com',
                action: 'sensitive-tool',
                target: 'test',
                data: {},
                reversible: false,
                riskClass: 'write',
              },
            });
          }
          return Promise.resolve({
            success: true,
            summary: 'Executed after confirmation',
            navigationOccurred: false,
          });
        }),
        policy: { riskClass: 'write' },
      };

      vi.spyOn(ToolRegistry.prototype, 'get').mockReturnValue(mockTool as any);
      vi.spyOn(ToolRegistry.prototype, 'validateArguments').mockReturnValue(null);

      await orchestrator.startTask('Test', { plan });
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(confirmationMock).toHaveBeenCalled();
      expect(mockTool.execute).toHaveBeenCalledTimes(2);
    });

    it('should abort task on confirmation denial', async () => {
      await orchestrator.init();

      const confirmationMock = vi.fn<() => Promise<'confirm' | 'deny' | 'takeover'>>(() => Promise.resolve('deny'));
      const { awaitConfirmation } = await import('./confirmation.js');
      vi.mocked(awaitConfirmation).mockImplementation(confirmationMock);

      const plan: Plan = {
        goal: 'Test',
        steps: [
          {
            id: 'step-1',
            action: { name: 'sensitive-tool', arguments: {} },
            expectedOutcome: 'success',
            verification: { type: 'urlMatches', pattern: '.*' },
            onFailure: 'abort',
          },
        ],
        contingencies: new Map(),
      };

      const mockTool = {
        execute: vi.fn(() => Promise.resolve({
          success: true,
          summary: 'Needs confirmation',
          navigationOccurred: false,
          requiresConfirmation: true,
          confirmationData: {
            origin: 'https://example.com',
            action: 'sensitive-tool',
            target: 'test',
            data: {},
            reversible: false,
            riskClass: 'write',
          },
        })),
        policy: { riskClass: 'write' },
      };

      vi.spyOn(ToolRegistry.prototype, 'get').mockReturnValue(mockTool as any);
      vi.spyOn(ToolRegistry.prototype, 'validateArguments').mockReturnValue(null);

      await orchestrator.startTask('Test', { plan });
      await new Promise(resolve => setTimeout(resolve, 100));

      const state = orchestrator.getState();
      expect(state?.status).toBe('idle');
      expect(orchestrator.isActive()).toBe(false);
    });
  });

  describe('Stale reference recovery (retry logic)', () => {
    it('should retry failed step with exponential backoff', async () => {
      await orchestrator.init();

      const plan: Plan = {
        goal: 'Test',
        steps: [
          {
            id: 'step-1',
            action: { name: 'flaky-tool', arguments: {} },
            expectedOutcome: 'success',
            verification: { type: 'urlMatches', pattern: '.*' },
            onFailure: 'retry',
          },
        ],
        contingencies: new Map(),
      };

      let attemptCount = 0;
      const mockTool = {
        execute: vi.fn(() => {
          attemptCount++;
          if (attemptCount < 3) {
            return Promise.resolve({
              success: false,
              error: 'Stale reference',
              summary: 'Failed',
              navigationOccurred: false,
            });
          }
          return Promise.resolve({
            success: true,
            summary: 'Success after retry',
            navigationOccurred: false,
          });
        }),
        policy: { riskClass: 'read' },
      };

      vi.spyOn(ToolRegistry.prototype, 'get').mockReturnValue(mockTool as any);
      vi.spyOn(ToolRegistry.prototype, 'validateArguments').mockReturnValue(null);

      await orchestrator.startTask('Test', { plan });
      await new Promise(resolve => setTimeout(resolve, 3000));

      const state = orchestrator.getState();
      expect(attemptCount).toBeGreaterThanOrEqual(2);
      expect(state?.history.length).toBeGreaterThanOrEqual(2);
    });

    it('should escalate after MAX_RETRY_ATTEMPTS', async () => {
      await orchestrator.init();

      const escalateMock = vi.fn<() => Promise<'confirm' | 'deny' | 'takeover'>>(() => Promise.resolve('deny'));
      const { requestIntervention } = await import('./confirmation.js');
      vi.mocked(requestIntervention).mockImplementation(escalateMock);

      const plan: Plan = {
        goal: 'Test',
        steps: [
          {
            id: 'step-1',
            action: { name: 'always-fail-tool', arguments: {} },
            expectedOutcome: 'success',
            verification: { type: 'urlMatches', pattern: '.*' },
            onFailure: 'retry',
          },
        ],
        contingencies: new Map(),
      };

      const mockTool = {
        execute: vi.fn(() => Promise.resolve({
          success: false,
          error: 'Always fails',
          summary: 'Failed',
          navigationOccurred: false,
        })),
        policy: { riskClass: 'write' },
      };

      vi.spyOn(ToolRegistry.prototype, 'get').mockReturnValue(mockTool as any);
      vi.spyOn(ToolRegistry.prototype, 'validateArguments').mockReturnValue(null);

      await orchestrator.startTask('Test', { plan });
      await new Promise(resolve => setTimeout(resolve, 8000));

      // After 3 retries, should escalate
      expect(escalateMock).toHaveBeenCalled();
    }, 10000);
  });

  describe('Checkpoint creation at CHECKPOINT_INTERVAL', () => {
    it('should create checkpoint at interval', async () => {
      await orchestrator.init();

      const { createCheckpoint } = await import('./checkpoint.js');
      const checkpointMock = vi.mocked(createCheckpoint);

      const steps: PlanStep[] = [];
      for (let i = 0; i < 10; i++) {
        steps.push({
          id: `step-${i}`,
          action: { name: 'test-tool', arguments: {} },
          expectedOutcome: 'success',
          verification: { type: 'urlMatches', pattern: '.*' },
          onFailure: 'abort',
        });
      }

      const plan: Plan = {
        goal: 'Test',
        steps,
        contingencies: new Map(),
      };

      const mockTool = {
        execute: vi.fn(() => Promise.resolve({
          success: true,
          summary: 'Success',
          navigationOccurred: false,
        })),
        policy: { riskClass: 'read' },
      };

      vi.spyOn(ToolRegistry.prototype, 'get').mockReturnValue(mockTool as any);
      vi.spyOn(ToolRegistry.prototype, 'validateArguments').mockReturnValue(null);

      await orchestrator.startTask('Test', { plan });
      await new Promise(resolve => setTimeout(resolve, 500));

      // Checkpoint should be called at step 5 (CHECKPOINT_INTERVAL = 5)
      expect(checkpointMock).toHaveBeenCalled();
    });

    it('should not fail step execution if checkpoint fails', async () => {
      await orchestrator.init();

      const { createCheckpoint } = await import('./checkpoint.js');
      vi.mocked(createCheckpoint).mockRejectedValue(new Error('Checkpoint failed'));

      const steps: PlanStep[] = [];
      for (let i = 0; i < 6; i++) {
        steps.push({
          id: `step-${i}`,
          action: { name: 'test-tool', arguments: {} },
          expectedOutcome: 'success',
          verification: { type: 'urlMatches', pattern: '.*' },
          onFailure: 'abort',
        });
      }

      const plan: Plan = {
        goal: 'Test',
        steps,
        contingencies: new Map(),
      };

      const mockTool = {
        execute: vi.fn(() => Promise.resolve({
          success: true,
          summary: 'Success',
          navigationOccurred: false,
        })),
        policy: { riskClass: 'read' },
      };

      vi.spyOn(ToolRegistry.prototype, 'get').mockReturnValue(mockTool as any);
      vi.spyOn(ToolRegistry.prototype, 'validateArguments').mockReturnValue(null);

      await orchestrator.startTask('Test', { plan });
      await new Promise(resolve => setTimeout(resolve, 300));

      // Should continue despite checkpoint failure
      const state = orchestrator.getState();
      expect(state?.status).toBe('completed');
      expect(state?.currentStep).toBe(6);
    });
  });
});
