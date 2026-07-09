// Pure derivation of the flat, render-ready thread item list.
//
// This module has NO React Native / React dependencies so it can be unit-tested
// in isolation. It takes the current in-memory session (`live`), the persisted
// older messages (`history`), and a few flags, and produces a flat
// `ChatThreadItem[]` ordered newest-LAST (ChatThread inverts internally).

import type { ConversationMessage, ToolCallRecord } from '@/lib/llm/types';
import type { ChatThreadItem, FactCardAction, PersistedMessage } from './types';

// ---------------------------------------------------------------------------
// Fact-card derivation
// ---------------------------------------------------------------------------
//
// Tool NAMES are authoritative (from PersonaUpdateAgent.getToolDefinitions):
//   saveExtractedFacts | deleteUserFacts | updateUserConfig
//
// The result/input SHAPES below are defensive: the plan documents a richer
// result shape (result.savedFacts / result.deletedStatements) than the current
// tool-handlers actually return, so we prefer those fields when present and
// fall back to the message INPUT (using the real schema field names:
// `extracted_user_information` for saves, `fact_ids` for deletes). See the
// summary for the exact deviation.

interface DerivedCard {
  action: FactCardAction;
  statements: string[];
  factIds: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Extracts statement strings + ids from a `[{ id, statement }]` result shape. */
function fromSavedFacts(value: unknown): DerivedCard | null {
  if (!Array.isArray(value)) return null;
  const statements: string[] = [];
  const factIds: string[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    const statement = typeof rec?.statement === 'string' ? rec.statement.trim() : '';
    if (!statement) continue;
    statements.push(statement);
    if (typeof rec?.id === 'string') factIds.push(rec.id);
  }
  return statements.length > 0 ? { action: 'saved', statements, factIds } : null;
}

/** Extracts statement strings from a fact-input array (string | { statement }). */
function statementsFromFactInput(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const statements: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed) statements.push(trimmed);
      continue;
    }
    const rec = asRecord(entry);
    const statement = typeof rec?.statement === 'string' ? rec.statement.trim() : '';
    if (statement) statements.push(statement);
  }
  return statements;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0);
}

/** Maps one completed tool call to a fact card, or null if it should not surface. */
function deriveCard(toolCall: ToolCallRecord): DerivedCard | null {
  if (toolCall.status !== 'done') return null;

  const result = toolCall.result ?? {};
  const input = asRecord(toolCall.input) ?? {};

  switch (toolCall.name) {
    case 'saveExtractedFacts': {
      // Prefer the rich result shape when available.
      const fromResult = fromSavedFacts(result.savedFacts);
      if (fromResult) return fromResult;
      // Actual handler returns only { success, factsSaved }. If it explicitly
      // saved nothing, don't surface a card.
      if (typeof result.factsSaved === 'number' && result.factsSaved === 0) return null;
      // Fall back to the message input (no ids available).
      const statements = statementsFromFactInput(
        input.extracted_user_information ?? input.facts,
      );
      return statements.length > 0
        ? { action: 'saved', statements, factIds: [] }
        : null;
    }

    case 'deleteUserFacts': {
      const fromResult = toStringArray(result.deletedStatements);
      if (fromResult.length > 0) {
        return { action: 'deleted', statements: fromResult, factIds: [] };
      }
      // Actual handler returns { success, deletedCount }. If nothing was
      // deleted, don't surface a card.
      if (typeof result.deletedCount === 'number' && result.deletedCount === 0) return null;
      const statements = toStringArray(input.fact_ids);
      return statements.length > 0
        ? { action: 'deleted', statements, factIds: [] }
        : null;
    }

    case 'updateUserConfig':
      return { action: 'updated', statements: [], factIds: [] };

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Message → thread items
// ---------------------------------------------------------------------------

/**
 * Emits a message item (if non-placeholder) followed by any fact cards.
 * `keyPrefix` distinguishes history (`hist`) from live (`live`) sources.
 */
function emitMessage(
  out: ChatThreadItem[],
  message: ConversationMessage,
  keyPrefix: 'hist' | 'live',
): void {
  const cards: ChatThreadItem[] = [];
  if (message.role === 'assistant' && message.toolCalls) {
    message.toolCalls.forEach((tc, idx) => {
      const card = deriveCard(tc);
      if (card) {
        cards.push({
          kind: 'fact-card',
          key: `card-${message.id}-${idx}`,
          action: card.action,
          statements: card.statements,
          factIds: card.factIds,
        });
      }
    });
  }

  const hasContent = message.content.trim().length > 0;
  // Skip empty assistant placeholders that produced no cards.
  if (!hasContent && cards.length === 0 && message.role === 'assistant') {
    return;
  }

  if (hasContent || message.role === 'user') {
    out.push({ kind: 'message', key: `${keyPrefix}-${message.id}`, message });
  }
  // Cards appear immediately after their parent message.
  out.push(...cards);
}

/** Normalizes a persisted message to the in-memory ConversationMessage shape. */
function toConversationMessage(m: PersistedMessage): ConversationMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function deriveThreadItems(opts: {
  live: ConversationMessage[];
  history: PersistedMessage[];
  introMessage: string | null;
  isStreaming: boolean;
  earlierConversationLabel: string;
  /**
   * Persisted messages of the CURRENT app-session conversation, oldest-first.
   * Rendered as part of the live session (NO "Earlier conversation" divider —
   * same conversation). Deduped against `live` by id: because messages persist
   * under their in-memory id, a live message already present here is skipped so
   * it renders statically (via resume) instead of replaying the entering anim.
   */
  resume?: PersistedMessage[];
}): ChatThreadItem[] {
  const { live, history, introMessage, isStreaming, earlierConversationLabel } = opts;
  const resume = opts.resume ?? [];
  const out: ChatThreadItem[] = [];

  // --- History (re-sorted oldest-first) ---
  const sortedHistory = [...history].sort((a, b) => a.createdAt - b.createdAt);
  let prevConversationId: string | null = null;
  for (const persisted of sortedHistory) {
    // Divider at every conversation boundary (not before the first message).
    if (prevConversationId !== null && persisted.conversationId !== prevConversationId) {
      out.push({
        kind: 'divider',
        key: `div-hist-${persisted.id}`,
        label: earlierConversationLabel,
      });
    }
    prevConversationId = persisted.conversationId;
    emitMessage(out, toConversationMessage(persisted), 'hist');
  }

  // --- Divider between OLDER conversations and the current one ---
  if (sortedHistory.length > 0) {
    out.push({ kind: 'divider', key: 'div-live', label: earlierConversationLabel });
  }

  // --- Resumed current-conversation messages (oldest-first, no divider) ---
  const sortedResume = [...resume].sort((a, b) => a.createdAt - b.createdAt);
  const resumeIds = new Set(sortedResume.map((m) => m.id));
  for (const persisted of sortedResume) {
    emitMessage(out, toConversationMessage(persisted), 'hist');
  }

  // --- Intro pseudo-message: suppressed once the conversation has resumed
  // messages (ChatSessionView already clears introMessage on the first send,
  // so intro never coexists with a live message in practice). ---
  if (introMessage !== null && sortedResume.length === 0) {
    out.push({
      kind: 'message',
      key: 'live-intro',
      message: { id: 'intro', role: 'assistant', content: introMessage },
    });
  }

  // --- Live session (skip anything already rendered via resume) ---
  for (const message of live) {
    if (resumeIds.has(message.id)) continue;
    emitMessage(out, message, 'live');
  }

  // --- Typing indicator ---
  const lastLive = live[live.length - 1];
  const showTyping =
    isStreaming &&
    (!lastLive ||
      lastLive.role === 'user' ||
      (lastLive.role === 'assistant' && lastLive.content.trim().length === 0));
  if (showTyping) {
    out.push({ kind: 'typing', key: 'typing' });
  }

  return out;
}
