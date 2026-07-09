// useChatPersistence — mirrors the live in-memory chat session into the
// durable `messages` table (conversation-service), fire-and-forget.
//
// Rules:
// - USER messages persist once, as soon as they appear in `messages`.
// - ASSISTANT messages persist only when FINALIZED: the hook's status has
//   returned to 'idle' OR a newer message appeared after it (i.e. it can no
//   longer be streaming). Additionally, messages with tool calls still in
//   'pending' status are held back until every call resolves, so persisted
//   toolCalls carry their results.
// - Assistant messages with empty content and no tool calls (abandoned
//   streaming placeholders) are never persisted.
// - Idempotent across re-renders via a ref Set of already-persisted ids;
//   ids are claimed synchronously before the async write starts.

import { useEffect, useRef } from 'react';
import { appendMessage } from '../database/services/conversation-service';
import type { ConversationMessage } from '../llm/types';
import logger from '../logger';

function hasPendingToolCalls(message: ConversationMessage): boolean {
  return (message.toolCalls ?? []).some((tc) => tc.status === 'pending');
}

export function useChatPersistence(
  messages: ConversationMessage[],
  status: 'idle' | 'streaming',
  conversationId: string | null,
  // Ids already persisted for this conversation (the resumed DB rows, whose ids
  // equal the in-memory ids). Seeds the idempotency ref so reopening a popover
  // never re-persists retained cloud-store messages.
  seedPersistedIds?: readonly string[],
): void {
  const persistedIdsRef = useRef<Set<string>>(new Set());
  // Seed once per mount, before the first persistence pass. Keyed on the set's
  // identity via a ref so a stable array doesn't re-seed on every render.
  const seededRef = useRef(false);
  if (!seededRef.current && seedPersistedIds && seedPersistedIds.length > 0) {
    for (const id of seedPersistedIds) persistedIdsRef.current.add(id);
    seededRef.current = true;
  }

  useEffect(() => {
    if (!conversationId) return;

    messages.forEach((message, index) => {
      if (persistedIdsRef.current.has(message.id)) return;

      if (message.role === 'assistant') {
        // Finalized = the stream is over (idle) or something newer superseded it.
        const hasNewerMessage = index < messages.length - 1;
        if (status !== 'idle' && !hasNewerMessage) return;
        // Wait for in-flight tool calls so results are captured.
        if (hasPendingToolCalls(message)) return;

        const toolCalls = message.toolCalls ?? [];
        // Skip empty placeholders that produced nothing.
        if (message.content.trim().length === 0 && toolCalls.length === 0) {
          persistedIdsRef.current.add(message.id);
          return;
        }

        persistedIdsRef.current.add(message.id);
        appendMessage(
          conversationId,
          {
            role: 'assistant',
            content: message.content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          message.id,
        ).catch((error) => {
          logger.error('[useChatPersistence] failed to persist assistant message', {
            error: String(error),
          });
        });
        return;
      }

      // User messages persist immediately on appearance.
      persistedIdsRef.current.add(message.id);
      appendMessage(
        conversationId,
        {
          role: 'user',
          content: message.content,
        },
        message.id,
      ).catch((error) => {
        logger.error('[useChatPersistence] failed to persist user message', {
          error: String(error),
        });
      });
    });
  }, [messages, status, conversationId]);
}
