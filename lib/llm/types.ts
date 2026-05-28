// Shared types for agents and chat hooks.

// ---------------------------------------------------------------------------
// Batch completion types (cloud-only — used for background scoring)
// ---------------------------------------------------------------------------

export interface BatchCall {
  id: string;
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  enableThinking?: boolean;
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI JSON Schema format — sent to cloud backend)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

// ---------------------------------------------------------------------------
// Conversation message (internal state model)
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  result?: Record<string, unknown>;
  status: 'pending' | 'done' | 'error';
}

/** Internal message model — NOT tied to AI SDK's UIMessage. */
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallRecord[];
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

export interface ToolExecutionResult {
  result: Record<string, unknown>;
  sideEffects?: {
    /** If set, the chat should be blocked and no further messages accepted. */
    blocked?: { reason: string };
  };
}

export interface ConversationHistory {
  messages: ConversationMessage[];
}

export interface IAgent {
  /** Unique ID used to scope conversation persistence (e.g. "persona-{userId}-ONBOARDING"). */
  readonly id: string;
  /** Build the system prompt given whether the engine needs XML tool-call format. */
  buildSystemPrompt(needsToolFormat: boolean): Promise<string>;
  /** Build dynamic context (known facts, questionnaire state) to inject into user messages. */
  buildContext?(): Promise<string>;
  /** Return tool definitions in OpenAI JSON Schema format (for cloud chat). */
  getToolDefinitions?(): ToolDefinition[];
  /** Execute a tool call by name and return result + optional side effects. */
  executeTool(name: string, input: unknown): Promise<ToolExecutionResult>;
  /** Optional: load prior conversation from local storage on mount. */
  loadHistory?(): Promise<ConversationHistory>;
  /** Optional: persist a message to local storage after it is finalized. */
  persistMessage?(
    role: 'user' | 'assistant',
    content: string,
  ): Promise<void>;
}
