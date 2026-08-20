// Tool-domain types shared by every tool executor and the ToolRegistry.
// Depends on the orchestrator's domain model (CompressedDom, ToolCall,
// ToolResult) for its structural fields — a type-only import that is erased at
// runtime, so it introduces no runtime import cycle.
import type { ToolCall, ToolResult, CompressedDom } from '../../sw/orchestrator.js';

export type RiskClass = 'read' | 'write' | 'navigation' | 'payment' | 'auth' | 'dangerous';

export interface ToolPolicy {
  riskClass: RiskClass;
  requiresConfirmation: boolean;
  allowedOrigins?: string[];
  reversible: boolean;
  idempotent: boolean;
  tokenCost: number;
}

export interface ToolContext {
  dom: CompressedDom;
  variables: Record<string, unknown>;
  step: ToolCall;
  allowlist: string[];
  /** Read-only-tool token budget; write actions are budgeted by the Rust bridge. */
  tokenBudget: { max: number; used: number };
  pageRevision: number;
  sessionId: string;
  tabId: number;
  getCdpSession: () => Promise<string | null>;
  /**
   * One-shot human-confirmation grant. When true, the tool still runs the
   * bridge's allow/deny check but skips the `requires_confirmation` early
   * return — the human has already approved this exact action. Set only by the
   * orchestrator's confirmation re-execution path.
   */
  preAuthorized?: boolean;
}

export type ToolExecutor = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  policy: ToolPolicy;
  execute: ToolExecutor;
}

/** Bridge policy decision, mirroring the Rust `PolicyDecision` serialization. */
export interface PolicyDecision {
  allowed: boolean;
  requires_confirmation: boolean;
  reason: string | null;
  risk_class: string;
  confirmation_data: { origin: string; action: string; target: string; data: unknown; reversible: boolean; risk_class: string } | null;
}

/** Bridge authorize response: the decision plus the `action_hash` for result reporting. */
export interface AuthResult {
  decision: PolicyDecision | null;
  actionHash: string | null;
}
