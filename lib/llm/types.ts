// Shared types for agents and chat hooks.

// ---------------------------------------------------------------------------
// Batch completion + tool-definition types — canonical home is now
// lib/news-harness/core/types.ts; re-exported here so importers don't change.
// ---------------------------------------------------------------------------

import type {
  BatchCall,
  ProposalAction,
  StagedProposal,
  ToolDefinition,
  ToolExecutionResult,
} from '@/lib/news-harness/core/types';
export type {
  BatchCall,
  ProposalAction,
  StagedProposal,
  ToolDefinition,
  ToolExecutionResult,
};

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
//
// ProposalAction, StagedProposal, and ToolExecutionResult now live in
// lib/news-harness/core/types.ts (the article-feedback agent's portable brain)
// and are re-exported at the top of this file.

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
  /**
   * The tools the FORCED-EXTRACTION repair pass may use (cloud path only).
   *
   * That pass reruns a turn with `tool_choice:'required'` when the first pass
   * returned text but zero tool calls. `'required'` obliges >=1 call, so
   * whatever is in this payload WILL be called and executed — including on a
   * purely conversational turn ("hi", "thanks"). It must therefore contain
   * ONLY tools whose empty-argument call is a harmless no-op.
   *
   * Absent or empty => the forced pass is SKIPPED ENTIRELY for this agent.
   * That is the correct default: an agent whose tools stage or apply changes
   * (propose/confirm surfaces) must never be forced to call one, because a
   * forced call fabricates user consent for a change nobody asked for.
   */
  getForcedExtractionTools?(): ToolDefinition[];
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
