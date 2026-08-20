import type { ToolCall } from '../sw/orchestrator.js';
import { navigateTool } from './tools/navigate.js';
import { clickTool } from './tools/click.js';
import { typeTool } from './tools/type.js';
import { scrollTool } from './tools/scroll.js';
import { extractTool } from './tools/extract.js';
import { waitTool } from './tools/wait.js';
import { observeTool } from './tools/observe.js';
import { humanClickTool } from './tools/human-click.js';
import { humanTypeTool } from './tools/human-type.js';
import { executeActionTool } from './tools/execute-action.js';
import type { ToolDefinition } from './tools/types.js';

// Re-export the tool-domain types for consumers that still import them from the
// registry (the orchestrator imports ToolContext here). Each tool's executor now
// lives in src/lib/tools/<tool>.ts; this module is a thin registry + ingress
// validator and nothing else.
export type { RiskClass, ToolPolicy, ToolContext, ToolExecutor, ToolDefinition, PolicyDecision, AuthResult } from './tools/types.js';

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    this.registerCoreTools();
  }

  private registerCoreTools() {
    this.register(navigateTool);
    this.register(clickTool);
    this.register(typeTool);
    this.register(scrollTool);
    this.register(extractTool);
    this.register(waitTool);
    this.register(observeTool);
    this.register(humanClickTool);
    this.register(humanTypeTool);
    this.register(executeActionTool);
  }

  register(definition: ToolDefinition) {
    if (this.tools.has(definition.name)) throw new Error(`Tool already registered: ${definition.name}`);
    this.tools.set(definition.name, definition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getSchemas(): Record<string, unknown>[] {
    return this.getAll().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      policy: t.policy,
    }));
  }

  /**
   * Validate an inbound tool call against its declared JSON-schema parameters
   * (required keys, enums, and primitive types). Returns an error string on
   * failure, or null when the call is well-formed. This is the external-agent
   * ingress gate: untrusted arguments never reach a tool executor.
   */
  validateArguments(toolCall: ToolCall): string | null {
    const tool = this.tools.get(toolCall.name);
    if (!tool) return `Unknown tool: ${toolCall.name}`;

    const schema = tool.parameters as {
      properties?: Record<string, { type?: string; enum?: unknown[] }>;
      required?: string[];
      additionalProperties?: boolean;
    };
    const args = toolCall.arguments ?? {};
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];

    for (const key of required) {
      if (!(key in args) || args[key] === undefined) return `Missing required argument: ${key}`;
    }

    for (const [key, value] of Object.entries(args)) {
      const prop = properties[key];
      if (!prop) {
        if (schema.additionalProperties === false) return `Unexpected argument: ${key}`;
        continue;
      }
      if (value === undefined) continue;

      if (prop.enum && !prop.enum.includes(value)) {
        return `Invalid value for ${key}: expected one of ${JSON.stringify(prop.enum)}`;
      }

      switch (prop.type) {
        case 'string':
          if (typeof value !== 'string') return `Argument ${key} must be a string`;
          break;
        case 'number':
          if (typeof value !== 'number' || !Number.isFinite(value)) return `Argument ${key} must be a finite number`;
          break;
        case 'boolean':
          if (typeof value !== 'boolean') return `Argument ${key} must be a boolean`;
          break;
        case 'object':
          if (typeof value !== 'object' || value === null) return `Argument ${key} must be an object`;
          break;
      }
    }

    return null;
  }
}
