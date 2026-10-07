// The chat session's busy flag drives the Mera button's unread ring, and a
// busy or unread thread is never replaced by an open from somewhere else.

import { useFloatingChatStore } from '../floating-chat-store';

const store = () => useFloatingChatStore.getState();

beforeEach(() => store().reset());

function turnOnFeed() {
  store().expand({ kind: 'persona', page: 'feed' });
  store().setConversationId('c1');
  store().setGenerating(true);
}

it('a turn that ends while the chat is closed leaves the answer unread', () => {
  turnOnFeed();
  store().collapse();
  expect(store().answerUnread).toBe(false);
  store().setGenerating(false);
  expect(store().answerUnread).toBe(true);
});

it('a turn that ends with the chat open is read', () => {
  turnOnFeed();
  store().setGenerating(false);
  expect(store().answerUnread).toBe(false);
});

it('opening the chat clears unread, by every opener', () => {
  for (const open of [
    () => store().expand({ kind: 'persona', page: 'world' }),
    () => store().toggle(),
    () => store().openArticleFeedback({ kind: 'article-suggestion', articleId: 'a' }, 'hi'),
    () => store().openOptimisationPlan(),
  ]) {
    store().reset();
    turnOnFeed();
    store().collapse();
    store().setGenerating(false);
    open();
    expect(store().isExpanded).toBe(true);
    expect(store().answerUnread).toBe(false);
  }
});

it('while busy, an open from another page or kind keeps the running thread', () => {
  turnOnFeed();
  store().collapse();
  store().expand({ kind: 'article-suggestion', articleId: 'a1' }, { draft: 'x' });
  expect(store().conversationId).toBe('c1');
  expect(store().context).toEqual({ kind: 'persona', page: 'feed' });
  expect(store().pendingDraft).toBe('x');
});

it('an unread answer keeps its thread too, and a seeded open drops its seed', () => {
  turnOnFeed();
  store().collapse();
  store().setGenerating(false);
  store().openArticleFeedback({ kind: 'article-suggestion', articleId: 'a1' }, 'Why?');
  expect(store().conversationId).toBe('c1');
  expect(store().pendingInitialMessage).toBeNull();
});

it('once read and idle, an open elsewhere switches as before', () => {
  turnOnFeed();
  store().setGenerating(false);
  store().collapse();
  store().expand({ kind: 'article-suggestion', articleId: 'a1' });
  expect(store().conversationId).toBeNull();
});

it('reset clears unread', () => {
  turnOnFeed();
  store().collapse();
  store().setGenerating(false);
  store().reset();
  expect(store().answerUnread).toBe(false);
});
