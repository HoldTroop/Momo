import { AgentState, Plan, PlanStep, ToolCall, CompressedDom, VerificationRule, FailureAction } from '../sw/orchestrator.js';
import { redactText } from './redaction.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface LlmResponse {
  content: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}

type ProviderType = 'ollama' | 'anthropic' | 'openai';

interface ProviderConfig {
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  models: string[];
}

const PROVIDERS: Record<ProviderType, ProviderConfig> = {
  ollama: {
    type: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: undefined,
    defaultModel: 'llama3.2:3b',
    models: ['llama3.2:3b', 'llama3.1:8b', 'mistral:7b', 'codellama:7b'],
  },
  anthropic: {
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: undefined, // Set via chrome.storage
    defaultModel: 'claude-3-5-haiku-20241022',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
  },
  openai: {
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: undefined,
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  },
};

export class LlmClient {
  private providers: Map<ProviderType, ProviderConfig> = new Map();
  private activeProvider: ProviderType = 'ollama';
  private activeModel: string = 'llama3.2:3b';

  constructor() {
    this.providers.set('ollama', PROVIDERS.ollama);
    this.providers.set('anthropic', PROVIDERS.anthropic);
    this.providers.set('openai', PROVIDERS.openai);
  }

  async setProvider(provider: ProviderType, apiKey?: string) {
    const config = this.providers.get(provider);
    if (!config) throw new Error(`Unknown provider: ${provider}`);
    if (apiKey) {
      config.apiKey = apiKey;
    }
    this.activeProvider = provider;
    this.activeModel = config.defaultModel;
    await this.persistConfig();
  }

  async setModel(model: string) {
    const config = this.providers.get(this.activeProvider);
    if (!config?.models.includes(model)) {
      throw new Error(`Model ${model} not available for provider ${this.activeProvider}`);
    }
    this.activeModel = model;
    await this.persistConfig();
  }

  private async persistConfig() {
    await chrome.storage.local.set({
      llmProvider: this.activeProvider,
      llmModel: this.activeModel,
    });
  }

  async loadConfig() {
    const stored = await chrome.storage.local.get(['llmProvider', 'llmModel']);
    if (stored.llmProvider) this.activeProvider = stored.llmProvider;
    if (stored.llmModel) this.activeModel = stored.llmModel;
  }

  getActiveProvider(): ProviderType {
    return this.activeProvider;
  }

  getActiveModel(): string {
    return this.activeModel;
  }

  getAvailableModels(): string[] {
    return this.providers.get(this.activeProvider)?.models || [];
  }

  async createPlan(goal: string, dom: CompressedDom, variables: Record<string, unknown>): Promise<Plan> {
    await this.loadConfig();
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildPlanPrompt(goal, dom, variables);

    const response = await this.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], this.getToolSchemas(), false);

    return this.parsePlan(redactText(response.content), goal);
  }

  async executeStep(step: PlanStep, dom: CompressedDom, variables: Record<string, unknown>, history: any[]): Promise<ToolCall | null> {
    await this.loadConfig();
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildStepPrompt(step, dom, variables, history);

    const response = await this.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], this.getToolSchemas(), false);

    const toolCall = this.parseToolCall(redactText(response.content));
    if (toolCall) {
      // Validate tool call against schema
      if (!this.validateToolCall(toolCall)) {
        console.warn('[LLM] Tool call failed schema validation:', toolCall);
        return null;
      }
    }
    return toolCall;
  }

  private validateToolCall(toolCall: ToolCall): boolean {
    const schemas = this.getToolSchemas();
    const schema = schemas.find(s => s.function.name === toolCall.name);
    if (!schema) return false;

    // Basic validation: required properties present
    const required = schema.function.parameters?.required as string[] || [];
    for (const req of required) {
      if (!(req in toolCall.arguments)) {
        console.warn(`[LLM] Missing required argument: ${req}`);
        return false;
      }
    }
    return true;
  }

  private async complete(messages: ChatMessage[], tools: Tool[], stream: boolean): Promise<LlmResponse> {
    const config = this.providers.get(this.activeProvider);
    if (!config) throw new Error(`Provider ${this.activeProvider} not configured`);

    // Redact messages before sending to LLM
    const redactedMessages = messages.map(m => ({
      ...m,
      content: redactText(m.content),
    }));

    let url: string;
    let body: Record<string, unknown>;
    let headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.type === 'ollama' || config.type === 'openai') {
      url = `${config.baseUrl}/chat/completions`;
      body = {
        model: this.activeModel,
        messages: redactedMessages,
        tools,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 2048,
        stream,
      };
      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      }
    } else if (config.type === 'anthropic') {
      url = `${config.baseUrl}/messages`;
      // Convert to Anthropic format
      const systemMessage = redactedMessages.find(m => m.role === 'system');
      const otherMessages = redactedMessages.filter(m => m.role !== 'system');
      body = {
        model: this.activeModel,
        system: systemMessage?.content || '',
        messages: otherMessages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
        tools: this.convertToolsToAnthropic(tools),
        tool_choice: { type: 'auto' },
        max_tokens: 2048,
        temperature: 0.3,
        stream,
      };
      headers['x-api-key'] = config.apiKey || '';
      headers['anthropic-version'] = '2023-06-01';
    } else {
      throw new Error(`Unsupported provider: ${config.type}`);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();

    if (config.type === 'anthropic') {
      // Convert Anthropic response to common format
      const toolCalls = data.content
        .filter((c: any) => c.type === 'tool_use')
        .map((c: any) => ({
          id: c.id,
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        }));
      return {
        content: data.content.find((c: any) => c.type === 'text')?.text || '',
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    }

    // OpenAI/Ollama format
    const choice = data.choices[0];
    return {
      content: choice.message.content || '',
      tool_calls: choice.message.tool_calls,
    };
  }

  private convertToolsToAnthropic(tools: Tool[]): any[] {
    return tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  private buildSystemPrompt(): string {
    return `You are an autonomous browser agent operating under strict policy constraints. Your job is to break down high-level goals into a sequence of precise browser actions.

POLICY CONSTRAINTS:
- Only navigate to origins on the allowlist
- Never interact with payment, authentication, or sensitive forms without explicit human confirmation
- All actions are logged and auditable
- No evasion of anti-bot systems; use real browser behavior

Available tools:
- navigate(url, waitUntil): Navigate to a URL (requires allowlist match)
- click(selector, xpath?, text?): Click an element
- type(selector, text, clearFirst?, pressEnter?): Type into an input
- scroll(selector?, direction, amount?): Scroll page or element
- extract(selector, schema, multiple?): Extract structured data
- wait(selector, condition?, timeout?): Wait for element state
- observe(includeScreenshot?): Get current page state

Rules:
1. Always use the most specific selector possible
2. Prefer observe() to understand the page before acting
3. Use wait() before interacting with dynamic elements
4. Extract data after actions to verify results
5. Handle errors gracefully - the system will retry
6. Think step by step, explain your reasoning

Output format for plans:
{
  "goal": "original goal",
  "steps": [
    { "id": "step-1", "action": {"name": "tool_name", "arguments": {...}}, "expectedOutcome": "what should happen", "verification": {"type": "elementVisible", "selector": "..."}, "onFailure": "retry" }
  ],
  "contingencies": {}
}

Output format for single step execution:
{
  "tool": "tool_name",
  "arguments": {...}
}`;
  }

  private buildPlanPrompt(goal: string, dom: CompressedDom, variables: Record<string, unknown>): string {
    const redactedDom = this.redactDom(dom);
    return `Goal: ${goal}

Current Page: ${redactedDom.title} (${redactedDom.url})
${redactedDom.summary}

Available Elements (top 20 by actionability):
${redactedDom.actions.slice(0, 20).map((a, i) => `${i+1}. [${a.role}] ${a.label} - ${a.selector} (score: ${a.actionabilityScore.toFixed(2)})`).join('\n')}

Variables: ${JSON.stringify(variables)}

Create a step-by-step plan to achieve the goal. Only use allowed origins.`;
  }

  private redactDom(dom: CompressedDom): CompressedDom {
    return {
      ...dom,
      url: redactText(dom.url),
      title: redactText(dom.title),
      summary: redactText(dom.summary),
      actions: dom.actions.map(a => ({
        ...a,
        label: redactText(a.label),
        selector: redactText(a.selector),
      })),
    };
  }

  private buildStepPrompt(step: PlanStep, dom: CompressedDom, variables: Record<string, unknown>, history: any[]): string {
    const redactedDom = this.redactDom(dom);
    const recentHistory = history.slice(-3).map(h =>
      `Step ${h.stepId}: ${h.action.name} -> ${h.result.success ? 'OK' : 'FAILED'} (${redactText(h.result.summary)})`
    ).join('\n');

    return `Current Step: ${step.id}
Action: ${step.action.name}(${JSON.stringify(step.action.arguments)})
Expected: ${step.expectedOutcome}

Recent History:
${recentHistory}

Current Page: ${redactedDom.title}
${redactedDom.summary}

Available Elements:
${redactedDom.actions.slice(0, 15).map((a, i) => `${i+1}. [${a.role}] ${a.label} - ${a.selector}`).join('\n')}

Variables: ${JSON.stringify(variables)}

Execute this step. If the action needs adjustment (e.g., different selector), output the corrected tool call.`;
  }

  private getToolSchemas(): Tool[] {
    return [
      {
        type: 'function',
        function: {
          name: 'navigate',
          description: 'Navigate to a URL (must be on allowlist)',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', format: 'uri' },
              waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
            },
            required: ['url'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'click',
          description: 'Click an element',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              xpath: { type: 'string' },
              text: { type: 'string' },
            },
            required: ['selector'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'type',
          description: 'Type text into an input field',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              text: { type: 'string' },
              clearFirst: { type: 'boolean' },
              pressEnter: { type: 'boolean' },
            },
            required: ['selector', 'text'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'scroll',
          description: 'Scroll page or element',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] },
              amount: { type: 'number' },
            },
            required: ['direction'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'extract',
          description: 'Extract structured data from page',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              schema: { type: 'object' },
              multiple: { type: 'boolean' },
            },
            required: ['selector', 'schema'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'wait',
          description: 'Wait for condition',
          parameters: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              condition: { type: 'string', enum: ['visible', 'hidden', 'enabled', 'disabled'] },
              timeout: { type: 'number' },
            },
            required: ['selector'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'observe',
          description: 'Get current page state',
          parameters: {
            type: 'object',
            properties: {
              includeScreenshot: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
      },
    ];
  }

  private parsePlan(content: string, goal: string): Plan {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          goal: parsed.goal || goal,
          steps: parsed.steps || [],
          contingencies: new Map(Object.entries(parsed.contingencies || {})),
        };
      }
    } catch (e) {
      console.warn('[LLM] Failed to parse plan:', e);
    }
    return { goal, steps: [], contingencies: new Map() };
  }

  private parseToolCall(content: string): ToolCall | null {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.tool && parsed.arguments) {
          return { name: parsed.tool, arguments: parsed.arguments };
        }
        if (parsed.name && parsed.arguments) {
          return { name: parsed.name, arguments: parsed.arguments };
        }
      }
    } catch (e) {
      console.warn('[LLM] Failed to parse tool call:', e);
    }
    return null;
  }
}