// navx: a page change keeps the thread only on a quick reopen or while a
// proposal waits; drafts ride expand() and are consumed once.

import type { StagedProposal } from '../../llm/types';
import { KEEP_THREAD_MS, useFloatingChatStore } from '../floating-chat-store';

const store = () => useFloatingChatStore.getState();

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  store().reset();
});
afterEach(() => jest.useRealTimers());

function openOnFeedThenClose() {
  store().expand({ kind: 'persona', page: 'feed' });
  store().setConversationId('c1');
  store().collapse();
}

it('a page change starts a fresh thread after the keep window', () => {
  openOnFeedThenClose();
  jest.advanceTimersByTime(KEEP_THREAD_MS + 1);
  store().expand({ kind: 'persona', page: 'facts' });
  expect(store().conversationId).toBeNull();
  expect(store().context).toEqual({ kind: 'persona', page: 'facts' });
});

it('a reopen inside the keep window keeps the thread and takes the new page', () => {
  openOnFeedThenClose();
  jest.advanceTimersByTime(KEEP_THREAD_MS - 1);
  store().expand({ kind: 'persona', page: 'facts' });
  expect(store().conversationId).toBe('c1');
  expect(store().context).toEqual({ kind: 'persona', page: 'facts' });
});

it('a waiting proposal keeps the thread however long ago it closed', () => {
  openOnFeedThenClose();
  store().setProposal({ id: 'p1' } as StagedProposal);
  jest.advanceTimersByTime(KEEP_THREAD_MS * 3);
  store().expand({ kind: 'persona', page: 'world' });
  expect(store().conversationId).toBe('c1');
  expect(store().proposal).not.toBeNull();
});

it('the first open of a session on a new page is fresh (no close yet)', () => {
  store().setConversationId('c0');
  store().expand({ kind: 'persona', page: 'feed' });
  expect(store().conversationId).toBeNull();
});

it('a change of kind is always fresh, even inside the window', () => {
  openOnFeedThenClose();
  store().expand({ kind: 'follow-story', page: 'stories' });
  expect(store().conversationId).toBeNull();
});

it('the same page reopened keeps the thread', () => {
  openOnFeedThenClose();
  jest.advanceTimersByTime(KEEP_THREAD_MS * 2);
  store().expand({ kind: 'persona', page: 'feed' });
  expect(store().conversationId).toBe('c1');
});

it('collapse and toggle stamp closedAt only when they close', () => {
  store().collapse();
  expect(store().closedAt).toBeNull();
  store().toggle();
  expect(store().closedAt).toBeNull();
  store().toggle();
  expect(store().closedAt).toBe(Date.now());
});

it('a draft rides expand and is consumed exactly once', () => {
  store().expand({ kind: 'persona', page: 'facts' }, { draft: 'Add an interest' });
  expect(store().pendingDraft).toBe('Add an interest');
  expect(store().consumePendingDraft()).toBe('Add an interest');
  expect(store().consumePendingDraft()).toBeNull();
});

it('an expand without a draft clears a stale one', () => {
  store().expand({ kind: 'persona', page: 'facts' }, { draft: 'x' });
  store().collapse();
  store().expand({ kind: 'persona', page: 'facts' });
  expect(store().pendingDraft).toBeNull();
});
