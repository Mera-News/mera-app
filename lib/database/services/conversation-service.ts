// Conversation Service — durable chat-history persistence.
//
// Backs the long-lived, user-owned `conversations` / `messages` tables. Unlike
// the ephemeral suggestion caches these are never wiped on resync. Messages can
// be paged reverse-chronologically ACROSS all conversations to power a unified
// chat history / fact-card timeline.

import { Q } from '@nozbe/watermelondb';
import type { Clause } from '@nozbe/watermelondb/QueryDescription';
import database from '../index';
import type ConversationModel from '../models/Conversation';
import type MessageModel from '../models/Message';
import type { ToolCallRecord } from '../../llm/types';
import logger from '../../logger';

const conversationsCol = database.get<ConversationModel>('conversations');
const messagesCol = database.get<MessageModel>('messages');

export type ConversationSurface = 'ONBOARDING' | 'CONFIG';
export type MessageRole = 'user' | 'assistant';

export interface PersistedMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  /** Parsed from tool_calls_json; null when absent or unparseable. */
  toolCalls: ToolCallRecord[] | null;
  createdAt: number;
}

export interface MessageCursor {
  createdAt: number;
  id: string;
}

// --- Helpers ---

/** Normalizes a WMDB @date field (Date) or a raw number to epoch millis. */
function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return 0;
}

/** Parses a tool_calls_json string, tolerating corrupt values by returning null. */
function parseToolCalls(raw: string | null | undefined): ToolCallRecord[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ToolCallRecord[]) : null;
  } catch (error) {
    logger.captureException(error, {
      tags: { source: 'conversation-service', method: 'parseToolCalls' },
    });
    return null;
  }
}

function toPersistedMessage(record: MessageModel): PersistedMessage {
  return {
    id: record.id,
    conversationId: record.conversationId,
    role: record.role as MessageRole,
    content: record.content,
    toolCalls: parseToolCalls(record.toolCallsJson),
    createdAt: toMillis(record.createdAt),
  };
}

/**
 * Deterministic reverse-chronological comparator: created_at desc, id desc
 * tie-break. Used to order rows within JS so identical timestamps stay stable.
 */
function byNewestFirst(a: PersistedMessage, b: PersistedMessage): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** True when `m` sorts strictly older than the cursor in (created_at, id) desc order. */
function isOlderThanCursor(m: PersistedMessage, cursor: MessageCursor): boolean {
  if (m.createdAt !== cursor.createdAt) return m.createdAt < cursor.createdAt;
  return m.id < cursor.id;
}

// --- Write ---

export async function createConversation(surface: ConversationSurface): Promise<string> {
  let createdId = '';
  await database.write(async () => {
    const record = await conversationsCol.create((c) => {
      c.surface = surface;
    });
    createdId = record.id;
  });
  return createdId;
}

/**
 * Appends a message. When `explicitId` is provided the row is created with that
 * id (the in-memory message id) rather than an auto-generated one — this makes
 * the DB id and in-memory id one and the same, so resumed messages dedupe
 * cleanly against the live/cloud-store session and persistence stays idempotent
 * across popover reopen (the persistence hook seeds its ref from these ids).
 */
export async function appendMessage(
  conversationId: string,
  msg: { role: MessageRole; content: string; toolCalls?: ToolCallRecord[] },
  explicitId?: string,
): Promise<string> {
  let createdId = '';
  await database.write(async () => {
    const record = await messagesCol.create((m) => {
      if (explicitId) {
        // Sanctioned WMDB way to set a custom primary key on create.
        m._raw.id = explicitId;
      }
      m.conversationId = conversationId;
      m.role = msg.role;
      m.content = msg.content;
      m.toolCallsJson =
        msg.toolCalls && msg.toolCalls.length > 0 ? JSON.stringify(msg.toolCalls) : null;
    });
    createdId = record.id;
  });
  return createdId;
}

/**
 * Loads all messages for one conversation, oldest-first. Powers resuming the
 * CURRENT app-session conversation when the popover reopens (its live state may
 * have been torn down on collapse).
 */
export async function fetchMessagesForConversation(
  conversationId: string,
): Promise<PersistedMessage[]> {
  const records = await messagesCol
    .query(Q.where('conversation_id', conversationId), Q.sortBy('created_at', Q.asc))
    .fetch();
  const items = records.map(toPersistedMessage);
  // Finalize ordering in JS (oldest-first) so it's exact regardless of adapter
  // sort stability — mirror byNewestFirst's tie-break, reversed.
  items.sort((a, b) => -byNewestFirst(a, b));
  return items;
}

// --- Read (reverse-chronological pagination across all conversations) ---

/**
 * Pages messages newest-first ACROSS all conversations. `cursor` returns only
 * messages strictly older than {createdAt, id} (id tie-break for identical
 * timestamps); pass null for the first page. `excludeConversationId` drops the
 * currently-open conversation from the history feed.
 *
 * Ordering (created_at desc, id desc tie-break) is finalized in JS so the
 * tie-break is exact regardless of the underlying adapter's sort stability.
 */
export async function fetchMessagesBefore(
  cursor: MessageCursor | null,
  limit: number,
  excludeConversationId?: string,
): Promise<{ items: PersistedMessage[]; nextCursor: MessageCursor | null; hasMore: boolean }> {
  if (limit <= 0) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  // Coarse DB-side narrowing where possible (a superset; JS refines below). The
  // cursor bound is `<=` so equal-timestamp rows are retained for the exact
  // id tie-break. Exact filtering + ordering happens in JS so it stays correct
  // even against adapters that ignore predicates.
  const clauses: Clause[] = [];
  if (excludeConversationId) {
    clauses.push(Q.where('conversation_id', Q.notEq(excludeConversationId)));
  }
  if (cursor) {
    clauses.push(Q.where('created_at', Q.lte(cursor.createdAt)));
  }
  clauses.push(Q.sortBy('created_at', Q.desc));

  const records = await messagesCol.query(...clauses).fetch();

  let items = records.map(toPersistedMessage);
  if (excludeConversationId) {
    items = items.filter((m) => m.conversationId !== excludeConversationId);
  }
  if (cursor) {
    items = items.filter((m) => isOlderThanCursor(m, cursor));
  }
  items.sort(byNewestFirst);

  const hasMore = items.length > limit;
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor: MessageCursor | null =
    hasMore && last ? { createdAt: last.createdAt, id: last.id } : null;

  return { items: page, nextCursor, hasMore };
}
