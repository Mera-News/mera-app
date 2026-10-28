// New chat is a fresh thread: a card left waiting must not follow the reader
// into it (device finding d12: the next turn's state line said a card was
// waiting with nothing on screen). Every other fresh-thread path drops it.
import type { StagedProposal } from '@/lib/llm/types';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';

const card: StagedProposal = { id: 'p1', explanation: '', expectedEffects: '', actions: [{ type: 'retire_topic', topicText: 'Cricket' }] };
const store = () => useFloatingChatStore.getState();

beforeEach(() => store().reset());

it('New chat drops the waiting card along with the conversation', () => {
  store().setConversationId('c1');
  store().setProposal(card);

  store().requestNewChat();

  expect(store().conversationId).toBeNull();
  expect(store().proposal).toBeNull();
});

it('New chat keeps the tool-result overrides: they record writes that already happened', () => {
  store().setToolCallResult('m1::0', { followed: { a: 'following' } });
  store().requestNewChat();
  expect(store().toolCallResults['m1::0']).toEqual({ followed: { a: 'following' } });
});
