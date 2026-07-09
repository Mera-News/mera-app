// conversation-service unit tests
// All WatermelonDB I/O is intercepted via makeDatabaseMock().
//
// Note: the fake `query()` ignores the Q predicate and returns every row set via
// `_setRows`, so these tests exercise the service's in-JS filtering / ordering /
// tie-break / pagination logic directly.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn() },
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import logger from '@/lib/logger';
import {
  createConversation,
  appendMessage,
  fetchMessagesBefore,
} from '../conversation-service';
import type { ToolCallRecord } from '@/lib/llm/types';

const db = database as any;

const NOW = 1_700_000_000_000;

function makeMessageRecord(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    id: `msg_${Math.random().toString(36).slice(2)}`,
    conversationId: 'conv-1',
    role: 'user',
    content: 'hello',
    suggestedOptionsJson: null,
    toolCallsJson: null,
    createdAt: new Date(NOW),
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('conversations', []);
  db._setRows('messages', []);
});

// ---------------------------------------------------------------------------
// createConversation
// ---------------------------------------------------------------------------

describe('createConversation', () => {
  it('creates a conversation row and returns its id', async () => {
    db._collections['conversations'].create.mockResolvedValueOnce(
      makeRecord({ id: 'conv-new' }),
    );

    const id = await createConversation('ONBOARDING');

    expect(id).toBe('conv-new');
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(db._collections['conversations'].create).toHaveBeenCalledTimes(1);
  });

  it('sets the surface field on the created row', async () => {
    const created = makeRecord({ id: 'conv-2' });
    db._collections['conversations'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        fn(created);
        return created;
      },
    );

    await createConversation('CONFIG');

    expect(created.surface).toBe('CONFIG');
  });
});

// ---------------------------------------------------------------------------
// appendMessage
// ---------------------------------------------------------------------------

describe('appendMessage', () => {
  it('creates a message row and returns its id', async () => {
    db._collections['messages'].create.mockResolvedValueOnce(
      makeRecord({ id: 'msg-new' }),
    );

    const id = await appendMessage('conv-1', { role: 'user', content: 'hi' });

    expect(id).toBe('msg-new');
    expect(database.write).toHaveBeenCalledTimes(1);
  });

  it('sets role, content and conversationId, leaving tool_calls_json null when absent', async () => {
    const created = makeRecord({ id: 'msg-1' });
    db._collections['messages'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        fn(created);
        return created;
      },
    );

    await appendMessage('conv-42', { role: 'assistant', content: 'reply' });

    expect(created.conversationId).toBe('conv-42');
    expect(created.role).toBe('assistant');
    expect(created.content).toBe('reply');
    expect(created.toolCallsJson).toBeNull();
  });

  it('serializes toolCalls to tool_calls_json when provided', async () => {
    const toolCalls: ToolCallRecord[] = [
      { id: 't1', name: 'save_extracted_facts', input: { a: 1 }, status: 'done' },
    ];
    const created = makeRecord({ id: 'msg-2' });
    db._collections['messages'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        fn(created);
        return created;
      },
    );

    await appendMessage('conv-1', { role: 'assistant', content: 'x', toolCalls });

    expect(created.toolCallsJson).toBe(JSON.stringify(toolCalls));
  });

  it('leaves tool_calls_json null when toolCalls is an empty array', async () => {
    const created = makeRecord({ id: 'msg-3' });
    db._collections['messages'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        fn(created);
        return created;
      },
    );

    await appendMessage('conv-1', { role: 'assistant', content: 'x', toolCalls: [] });

    expect(created.toolCallsJson).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchMessagesBefore — reverse-chronological pagination across conversations
// ---------------------------------------------------------------------------

describe('fetchMessagesBefore', () => {
  it('returns empty result for a non-positive limit', async () => {
    db._setRows('messages', [makeMessageRecord()]);
    const result = await fetchMessagesBefore(null, 0);
    expect(result).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it('returns messages newest-first', async () => {
    db._setRows('messages', [
      makeMessageRecord({ id: 'a', createdAt: new Date(NOW - 2000) }),
      makeMessageRecord({ id: 'c', createdAt: new Date(NOW) }),
      makeMessageRecord({ id: 'b', createdAt: new Date(NOW - 1000) }),
    ]);

    const result = await fetchMessagesBefore(null, 10);

    expect(result.items.map((m) => m.id)).toEqual(['c', 'b', 'a']);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('pages across two conversations by created_at, newest first', async () => {
    db._setRows('messages', [
      makeMessageRecord({ id: 'm1', conversationId: 'conv-1', createdAt: new Date(NOW - 4000) }),
      makeMessageRecord({ id: 'm2', conversationId: 'conv-2', createdAt: new Date(NOW - 3000) }),
      makeMessageRecord({ id: 'm3', conversationId: 'conv-1', createdAt: new Date(NOW - 2000) }),
      makeMessageRecord({ id: 'm4', conversationId: 'conv-2', createdAt: new Date(NOW - 1000) }),
    ]);

    const result = await fetchMessagesBefore(null, 10);

    expect(result.items.map((m) => m.id)).toEqual(['m4', 'm3', 'm2', 'm1']);
  });

  it('excludes the current conversation when excludeConversationId is set', async () => {
    db._setRows('messages', [
      makeMessageRecord({ id: 'm1', conversationId: 'conv-1', createdAt: new Date(NOW - 3000) }),
      makeMessageRecord({ id: 'm2', conversationId: 'conv-2', createdAt: new Date(NOW - 2000) }),
      makeMessageRecord({ id: 'm3', conversationId: 'conv-1', createdAt: new Date(NOW - 1000) }),
    ]);

    const result = await fetchMessagesBefore(null, 10, 'conv-1');

    expect(result.items.map((m) => m.id)).toEqual(['m2']);
  });

  it('sets hasMore and nextCursor when more rows exist than the limit', async () => {
    db._setRows('messages', [
      makeMessageRecord({ id: 'm1', createdAt: new Date(NOW - 3000) }),
      makeMessageRecord({ id: 'm2', createdAt: new Date(NOW - 2000) }),
      makeMessageRecord({ id: 'm3', createdAt: new Date(NOW - 1000) }),
    ]);

    const result = await fetchMessagesBefore(null, 2);

    expect(result.items.map((m) => m.id)).toEqual(['m3', 'm2']);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toEqual({ createdAt: NOW - 2000, id: 'm2' });
  });

  it('cursor is stable across pages — second page continues without gaps or repeats', async () => {
    const rows = [
      makeMessageRecord({ id: 'm1', createdAt: new Date(NOW - 5000) }),
      makeMessageRecord({ id: 'm2', createdAt: new Date(NOW - 4000) }),
      makeMessageRecord({ id: 'm3', createdAt: new Date(NOW - 3000) }),
      makeMessageRecord({ id: 'm4', createdAt: new Date(NOW - 2000) }),
      makeMessageRecord({ id: 'm5', createdAt: new Date(NOW - 1000) }),
    ];
    db._setRows('messages', rows);

    const page1 = await fetchMessagesBefore(null, 2);
    expect(page1.items.map((m) => m.id)).toEqual(['m5', 'm4']);
    expect(page1.hasMore).toBe(true);

    const page2 = await fetchMessagesBefore(page1.nextCursor, 2);
    expect(page2.items.map((m) => m.id)).toEqual(['m3', 'm2']);
    expect(page2.hasMore).toBe(true);

    const page3 = await fetchMessagesBefore(page2.nextCursor, 2);
    expect(page3.items.map((m) => m.id)).toEqual(['m1']);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();
  });

  it('breaks identical-timestamp ties by id descending and pages them stably', async () => {
    // All three share the same createdAt — ordering must fall back to id desc.
    db._setRows('messages', [
      makeMessageRecord({ id: 'aaa', createdAt: new Date(NOW) }),
      makeMessageRecord({ id: 'ccc', createdAt: new Date(NOW) }),
      makeMessageRecord({ id: 'bbb', createdAt: new Date(NOW) }),
    ]);

    const page1 = await fetchMessagesBefore(null, 2);
    expect(page1.items.map((m) => m.id)).toEqual(['ccc', 'bbb']);
    expect(page1.nextCursor).toEqual({ createdAt: NOW, id: 'bbb' });

    const page2 = await fetchMessagesBefore(page1.nextCursor, 2);
    expect(page2.items.map((m) => m.id)).toEqual(['aaa']);
    expect(page2.hasMore).toBe(false);
  });

  it('round-trips tool_calls_json into parsed toolCalls', async () => {
    const toolCalls: ToolCallRecord[] = [
      { id: 't1', name: 'delete_user_facts', input: { fact_ids: ['x'] }, status: 'done' },
    ];
    db._setRows('messages', [
      makeMessageRecord({ id: 'm1', toolCallsJson: JSON.stringify(toolCalls) }),
    ]);

    const result = await fetchMessagesBefore(null, 10);

    expect(result.items[0].toolCalls).toEqual(toolCalls);
  });

  it('returns null toolCalls when tool_calls_json is absent', async () => {
    db._setRows('messages', [makeMessageRecord({ id: 'm1', toolCallsJson: null })]);
    const result = await fetchMessagesBefore(null, 10);
    expect(result.items[0].toolCalls).toBeNull();
  });

  it('tolerates corrupt tool_calls_json by returning null and capturing the error', async () => {
    db._setRows('messages', [makeMessageRecord({ id: 'm1', toolCallsJson: '{not json' })]);

    const result = await fetchMessagesBefore(null, 10);

    expect(result.items[0].toolCalls).toBeNull();
    expect(logger.captureException).toHaveBeenCalledTimes(1);
  });

  it('handles createdAt stored as a raw number (not a Date)', async () => {
    db._setRows('messages', [makeMessageRecord({ id: 'm1', createdAt: NOW })]);
    const result = await fetchMessagesBefore(null, 10);
    expect(result.items[0].createdAt).toBe(NOW);
  });
});
