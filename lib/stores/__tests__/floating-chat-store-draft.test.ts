// The Profile chat's facts draft (ux2 F2): only a chat opened FROM PROFILE
// opens a draft; the floating bubble never does; any close settles it.

const mockOpen = jest.fn(async () => undefined);
const mockSettle = jest.fn(async () => undefined);
jest.mock('@/lib/services/facts-draft-service', () => ({
  openFactsDraft: () => mockOpen(),
  settleProfileChatClose: () => mockSettle(),
}));

import { useFloatingChatStore } from '../floating-chat-store';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  jest.clearAllMocks();
  useFloatingChatStore.getState().reset();
});

it('opens a draft when the chat expands with origin profile', async () => {
  useFloatingChatStore.getState().expand({ kind: 'persona', origin: 'profile' });
  await flush();
  expect(mockOpen).toHaveBeenCalledTimes(1);
});

it('the floating bubble does not count', async () => {
  useFloatingChatStore.getState().expand();
  useFloatingChatStore.getState().expand({ kind: 'persona' });
  await flush();
  expect(mockOpen).not.toHaveBeenCalled();
});

it('any close (X, backdrop, swipe all collapse) settles the draft', async () => {
  useFloatingChatStore.getState().expand({ kind: 'persona', origin: 'profile' });
  await flush();
  useFloatingChatStore.getState().collapse();
  await flush();
  expect(mockSettle).toHaveBeenCalledTimes(1);
});

it('an open that stays open settles nothing', async () => {
  useFloatingChatStore.getState().expand({ kind: 'persona', origin: 'profile' });
  useFloatingChatStore.getState().expand({ kind: 'persona', origin: 'profile' });
  await flush();
  expect(mockOpen).toHaveBeenCalledTimes(1);
  expect(mockSettle).not.toHaveBeenCalled();
});

it('a later bubble open after a Profile chat is not a Profile chat', async () => {
  useFloatingChatStore.getState().expand({ kind: 'persona', origin: 'profile' });
  await flush();
  useFloatingChatStore.getState().collapse();
  await flush();
  useFloatingChatStore.getState().expand();
  await flush();
  expect(mockOpen).toHaveBeenCalledTimes(1);
});
