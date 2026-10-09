// conversation-service at its seam: the durable chat history, over the in-memory DB. Replaces
// lib/database/services/__tests__/conversation-service.test.ts, whose database mock ignored every
// Q clause, so its pagination tests only pinned the service's JS filter. Here Q.sortBy, Q.lte and
// Q.notEq are real, and a page boundary across equal timestamps is run against the real table.
//
// Not carried over: "handles createdAt stored as a raw number". The model's @date getter returns a
// Date (Date(0) for a lost value), never a number or null, so lines 42-43 of toMillis cannot be
// reached at any seam (R30 candidate).
// The createConversation / appendMessage "calls database.write once" assertions only counted mock
// calls; the written row is read back instead.
import {
  appendMessage,
  createConversation,
  fetchMessagesBefore,
  fetchMessagesForConversation,
  patchMessageToolCallResult,
} from '@/lib/database/services/conversation-service';
import type { ToolCallRecord } from '@/lib/llm/types';
import { corruptColumn, countRows, freezeClock, quietLogger, restoreFaults, rowById, T0 } from './support';

beforeEach(() => freezeClock());
afterEach(restoreFaults);

const tick = (ms = 1000) => jest.advanceTimersByTime(ms);
const ids = (items: { id: string }[]) => items.map((m) => m.id);

const call = (id: string, over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  id,
  name: 'save_extracted_facts',
  input: { id },
  status: 'staged' as ToolCallRecord['status'],
  ...over,
});

describe('createConversation', () => {
  it('creates a row with the surface and returns its id', async () => {
    const onboarding = await createConversation('ONBOARDING');
    const config = await createConversation('CONFIG');

    expect(onboarding).not.toBe(config);
    expect((await rowById('conversations', onboarding))?.surface).toBe('ONBOARDING');
    expect((await rowById('conversations', config))?.surface).toBe('CONFIG');
    expect(await countRows('conversations')).toBe(2);
  });
});

describe('appendMessage', () => {
  it('creates a message row and returns its id', async () => {
    const conv = await createConversation('CONFIG');
    const id = await appendMessage(conv, { role: 'user', content: 'hi' });

    const row = await rowById('messages', id);
    expect(row).toMatchObject({ conversationId: conv, role: 'user', content: 'hi', toolCallsJson: null });
    expect(row.createdAt.getTime()).toBe(T0);
  });

  it('uses the explicit id as the primary key', async () => {
    const conv = await createConversation('CONFIG');
    expect(await appendMessage(conv, { role: 'assistant', content: 'a' }, 'asst-1')).toBe('asst-1');
    expect(await rowById('messages', 'asst-1')).not.toBeNull();
  });

  // The caller's "already persisted" guard is an in-memory ref, empty again after a remount while
  // the row is still on disk. The insert then failed the primary key (sqlite 1555) on a dev build.
  it('returns the existing id and writes nothing when the explicit id is already there', async () => {
    const conv = await createConversation('CONFIG');
    await appendMessage(conv, { role: 'assistant', content: 'first' }, 'asst-1');

    const again = await appendMessage(conv, { role: 'assistant', content: 'second try' }, 'asst-1');

    expect(again).toBe('asst-1');
    expect(await countRows('messages')).toBe(1);
    expect((await rowById('messages', 'asst-1')).content).toBe('first');
  });

  it('serializes toolCalls and reads them back parsed', async () => {
    const conv = await createConversation('CONFIG');
    const calls = [call('t1'), call('t2', { name: 'delete_user_facts' })];
    const id = await appendMessage(conv, { role: 'assistant', content: 'x', toolCalls: calls });

    expect((await rowById('messages', id)).toolCallsJson).toBe(JSON.stringify(calls));
    const [read] = await fetchMessagesForConversation(conv);
    expect(read.toolCalls).toEqual(calls);
  });

  it('leaves tool_calls_json null for an empty toolCalls array', async () => {
    const conv = await createConversation('CONFIG');
    const id = await appendMessage(conv, { role: 'assistant', content: 'x', toolCalls: [] });
    expect((await rowById('messages', id)).toolCallsJson).toBeNull();
  });
});

describe('patchMessageToolCallResult', () => {
  it('rewrites only the indexed call, marks it done and keeps its siblings byte for byte', async () => {
    const conv = await createConversation('CONFIG');
    const calls = [call('t1'), call('t2'), call('t3')];
    const id = await appendMessage(conv, { role: 'assistant', content: 'x', toolCalls: calls });

    await expect(patchMessageToolCallResult(id, 1, { savedFacts: ['f1'] })).resolves.toBe(true);

    const [read] = await fetchMessagesForConversation(conv);
    expect(read.toolCalls).toEqual([calls[0], { ...calls[1], result: { savedFacts: ['f1'] }, status: 'done' }, calls[2]]);
  });

  it('patches its own message and no other', async () => {
    const conv = await createConversation('CONFIG');
    const calls = [call('t1')];
    const mine = await appendMessage(conv, { role: 'assistant', content: 'mine', toolCalls: calls });
    const other = await appendMessage(conv, { role: 'assistant', content: 'other', toolCalls: calls });

    await patchMessageToolCallResult(mine, 0, { ok: true });

    expect((await rowById('messages', other)).toolCallsJson).toBe(JSON.stringify(calls));
    expect(JSON.parse((await rowById('messages', mine)).toolCallsJson)[0].result).toEqual({ ok: true });
  });

  it('is a no-op that answers false for a missing row, a missing index and a message with no calls', async () => {
    const conv = await createConversation('CONFIG');
    const withCalls = await appendMessage(conv, { role: 'assistant', content: 'x', toolCalls: [call('t1')] });
    const plain = await appendMessage(conv, { role: 'assistant', content: 'y' });
    const before = (await rowById('messages', withCalls)).toolCallsJson;

    await expect(patchMessageToolCallResult('nope', 0, {})).resolves.toBe(false);
    await expect(patchMessageToolCallResult(withCalls, 5, {})).resolves.toBe(false);
    await expect(patchMessageToolCallResult(plain, 0, {})).resolves.toBe(false);
    expect((await rowById('messages', withCalls)).toolCallsJson).toBe(before);
    expect((await rowById('messages', plain)).toolCallsJson).toBeNull();
  });
});

describe('fetchMessagesForConversation', () => {
  it('returns only that conversation, oldest first', async () => {
    const a = await createConversation('CONFIG');
    const b = await createConversation('ONBOARDING');
    await appendMessage(a, { role: 'user', content: '1' }, 'a1');
    tick();
    await appendMessage(b, { role: 'user', content: 'other' }, 'b1');
    tick();
    await appendMessage(a, { role: 'assistant', content: '3' }, 'a3');
    jest.setSystemTime(T0 - 500);
    await appendMessage(a, { role: 'user', content: 'earliest' }, 'a0');

    const items = await fetchMessagesForConversation(a);

    expect(ids(items)).toEqual(['a0', 'a1', 'a3']);
    expect(items.map((m) => m.conversationId)).toEqual([a, a, a]);
  });

  it('breaks identical timestamps by id ascending', async () => {
    const conv = await createConversation('CONFIG');
    for (const id of ['ccc', 'aaa', 'bbb']) await appendMessage(conv, { role: 'user', content: id }, id);

    expect(ids(await fetchMessagesForConversation(conv))).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('is empty for a conversation with no messages', async () => {
    expect(await fetchMessagesForConversation(await createConversation('CONFIG'))).toEqual([]);
  });
});

describe('fetchMessagesBefore', () => {
  /** Appends `id` at `T0 + offsetMs` by moving the strict clock there first. */
  async function at(conv: string, id: string, offsetMs: number) {
    jest.setSystemTime(T0 + offsetMs);
    await appendMessage(conv, { role: 'user', content: id }, id);
  }

  it('returns an empty page for a non-positive limit', async () => {
    const conv = await createConversation('CONFIG');
    await at(conv, 'm1', 0);
    expect(await fetchMessagesBefore(null, 0)).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it('returns messages newest first with no cursor when everything fits', async () => {
    const conv = await createConversation('CONFIG');
    await at(conv, 'a', -2000);
    await at(conv, 'c', 0);
    await at(conv, 'b', -1000);

    const page = await fetchMessagesBefore(null, 10);

    expect(ids(page.items)).toEqual(['c', 'b', 'a']);
    expect(page).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('pages across conversations by created_at, and drops the open conversation', async () => {
    const one = await createConversation('CONFIG');
    const two = await createConversation('ONBOARDING');
    await at(one, 'm1', -4000);
    await at(two, 'm2', -3000);
    await at(one, 'm3', -2000);
    await at(two, 'm4', -1000);

    expect(ids((await fetchMessagesBefore(null, 10)).items)).toEqual(['m4', 'm3', 'm2', 'm1']);
    expect(ids((await fetchMessagesBefore(null, 10, one)).items)).toEqual(['m4', 'm2']);
  });

  it('sets hasMore and a cursor on the last returned row when more rows exist', async () => {
    const conv = await createConversation('CONFIG');
    await at(conv, 'm1', -3000);
    await at(conv, 'm2', -2000);
    await at(conv, 'm3', -1000);

    const page = await fetchMessagesBefore(null, 2);

    expect(ids(page.items)).toEqual(['m3', 'm2']);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({ createdAt: T0 - 2000, id: 'm2' });
  });

  it('walks every page without a gap or a repeat', async () => {
    const conv = await createConversation('CONFIG');
    for (let i = 1; i <= 5; i++) await at(conv, `m${i}`, -(6 - i) * 1000);

    const p1 = await fetchMessagesBefore(null, 2);
    const p2 = await fetchMessagesBefore(p1.nextCursor, 2);
    const p3 = await fetchMessagesBefore(p2.nextCursor, 2);

    expect([ids(p1.items), ids(p2.items), ids(p3.items)]).toEqual([['m5', 'm4'], ['m3', 'm2'], ['m1']]);
    expect([p1.hasMore, p2.hasMore, p3.hasMore]).toEqual([true, true, false]);
    expect(p3.nextCursor).toBeNull();
  });

  // The cursor bound is Q.lte so equal-timestamp rows survive the DB filter for the id tie-break.
  // A strict Q.lt would drop 'aaa' here and the walk would lose it.
  it('pages across a boundary of equal timestamps by id descending, losing nothing', async () => {
    const conv = await createConversation('CONFIG');
    await at(conv, 'old', -5000);
    for (const id of ['aaa', 'ddd', 'bbb', 'eee', 'ccc']) await at(conv, id, 0);

    const p1 = await fetchMessagesBefore(null, 2);
    expect(ids(p1.items)).toEqual(['eee', 'ddd']);
    expect(p1.nextCursor).toEqual({ createdAt: T0, id: 'ddd' });

    const p2 = await fetchMessagesBefore(p1.nextCursor, 2);
    expect(ids(p2.items)).toEqual(['ccc', 'bbb']);

    const p3 = await fetchMessagesBefore(p2.nextCursor, 2);
    expect(ids(p3.items)).toEqual(['aaa', 'old']);
    expect(p3).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('round-trips tool calls, and reads null when the column is empty', async () => {
    const conv = await createConversation('CONFIG');
    const calls = [call('t1', { name: 'delete_user_facts' })];
    await appendMessage(conv, { role: 'assistant', content: 'with' }, 'with');
    await appendMessage(conv, { role: 'assistant', content: 'x', toolCalls: calls }, 'calls');

    const byId = Object.fromEntries((await fetchMessagesBefore(null, 10)).items.map((m) => [m.id, m]));
    expect(byId.calls.toolCalls).toEqual(calls);
    expect(byId.with.toolCalls).toBeNull();
  });

  it('tolerates a corrupt tool_calls_json: null calls, one captured error, the row still listed', async () => {
    const logs = quietLogger();
    const conv = await createConversation('CONFIG');
    const id = await appendMessage(conv, { role: 'assistant', content: 'x' });
    await corruptColumn('messages', id, 'toolCallsJson', '{not json');

    const page = await fetchMessagesBefore(null, 10);

    expect(page.items).toHaveLength(1);
    expect(page.items[0].toolCalls).toBeNull();
    expect(logs.captureException).toHaveBeenCalledTimes(1);
  });

  it('reads a message whose created_at was lost as time 0, after every dated one', async () => {
    const conv = await createConversation('CONFIG');
    const lost = await appendMessage(conv, { role: 'user', content: 'lost' }, 'lost');
    await appendMessage(conv, { role: 'user', content: 'dated' }, 'dated');
    await corruptColumn('messages', lost, 'createdAt', null);

    const page = await fetchMessagesBefore(null, 10);

    expect(ids(page.items)).toEqual(['dated', 'lost']);
    expect(page.items[1].createdAt).toBe(0);
  });

  it('reads a tool_calls_json that parses to a non-array as no calls', async () => {
    const conv = await createConversation('CONFIG');
    const id = await appendMessage(conv, { role: 'assistant', content: 'x' });
    await corruptColumn('messages', id, 'toolCallsJson', '{"a":1}');

    expect((await fetchMessagesBefore(null, 10)).items[0].toolCalls).toBeNull();
  });
});
