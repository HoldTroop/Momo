// Checkpointing for the orchestrator: snapshot the active session's progress
// every N steps so a future resume can restart near where it left off. Extracted
// from the former god file.
import type { PersistenceManager } from '../lib/persistence.js';
import type { AgentState, Checkpoint } from './orchestrator.js';

export const CHECKPOINT_INTERVAL = 5;

export async function createCheckpoint(
  state: AgentState,
  persistence: PersistenceManager,
  activeSessionId: string,
): Promise<void> {
  const checkpoint: Checkpoint = {
    stepIndex: state.currentStep,
    stateSnapshot: {
      goal: state.goal,
      currentStep: state.currentStep,
      variables: state.variables,
      historyLength: state.history.length,
      pageRevision: state.pageRevision,
    },
    walPosition: await persistence.getWalPosition(),
    timestamp: Date.now(),
  };

  state.checkpoints.push(checkpoint);
  await persistence.saveCheckpoint(activeSessionId, checkpoint);
}
