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
  /** Epoch ms, when known: persisted messages and each typed user turn. The
   *  chat bug report's transcript reads it; a reply carries its turn's time. */
  createdAt?: number;
  toolCalls?: ToolCallRecord[];
  /**
   * A turn the MODEL must read but the user must never see.
   *
   * Set only on `role: 'user'`. Filtered out of the transcript
   * (`deriveThreadItems`) AND out of persistence (`useChatPersistence`), so it
   * exists for exactly one inference call and leaves no trace.
   *
   * It is a user turn rather than a nudge because the on-device path requires
   * one: `buildPromptFromMessages` flattens the thread to `User:` / `Assistant:`
   * and injects <context> onto the last USER turn — end the prompt on
   * `Assistant:` and a 4B model continues its own previous message.
   *
   * Deliberately NOT a third `role`: that would ripple through
   * conversation-service, the DB column, useChatPersistence and ChatThread for
   * no gain, since nothing is ever stored.
   */
  hidden?: boolean;
  /** The reader pressed Stop on this turn. The thread shows a muted "Stopped"
   *  line under whatever partial text there is. Memory only: not persisted. */
  stopped?: boolean;
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
   * The thinking gear of this agent's single-shot cloud chat calls. Absent =
   * on (cloudChatStream's default). Set false only on a pass of
   * harness-local/scripts/run-singleshot-corpus.ts for this agent.
   */
  readonly chatThinking?: boolean;
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
