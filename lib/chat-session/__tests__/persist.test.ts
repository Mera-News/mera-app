import type { ConversationMessage } from '@/lib/llm/types';
import { toPersist } from '../persist';

const m = (id: string, role: 'user' | 'assistant', extra: Partial<ConversationMessage> = {}) =>
  ({ id, role, content: 'text', createdAt: 0, ...extra }) as ConversationMessage;

it('a streaming reply waits; a superseded one does not', () => {
  const thread = [m('u1', 'user'), m('a1', 'assistant'), m('u2', 'user'), m('a2', 'assistant')];
  const plan = toPersist(thread, 'streaming', new Set());
  expect(plan.write.map((x) => x.id)).toEqual(['u1', 'a1', 'u2']);
  expect(plan.claim).toEqual(['u1', 'a1', 'u2']);
});

it('a reply with a pending tool call waits even when idle', () => {
  const pending = m('a1', 'assistant', {
    toolCalls: [{ id: 't', name: 'x', input: {}, status: 'pending' }],
  } as Partial<ConversationMessage>);
  expect(toPersist([pending], 'idle', new Set())).toEqual({ claim: [], write: [] });
});

it('an empty placeholder and a hidden turn are claimed, never written', () => {
  const plan = toPersist(
    [m('h1', 'user', { hidden: true }), m('a1', 'assistant', { content: '  ' })],
    'idle',
    new Set(),
  );
  expect(plan.claim).toEqual(['h1', 'a1']);
  expect(plan.write).toEqual([]);
});

it('skips what is already persisted', () => {
  expect(toPersist([m('u1', 'user')], 'idle', new Set(['u1']))).toEqual({ claim: [], write: [] });
});
