// The sample behind a fresh chat never sits behind the keyboard. The composer can focus itself, so
// the keyboard rises with no touch on the chat, and the touch rule alone left the sample up.
import { act, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Keyboard } from 'react-native';
import MeraChatSession from '@/components/custom/floating-chat/MeraChatSession';
import { resetChatSession } from '@/lib/chat-session/chat-session';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { useFloatingChatStore, type ChatContext } from '@/lib/stores/floating-chat-store';
import { initI18nEn, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';

jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
jest.setTimeout(60_000);

type Listener = () => void;
let listeners: Map<string, Set<Listener>>;
let addListener: jest.SpyInstance;
let isVisible: jest.SpyInstance;

async function openFreshChat(context: ChatContext = { kind: 'persona' }) {
  useFloatingChatStore.setState({ context, isExpanded: true });
  await render(<MeraChatSession />);
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy(), { timeout: 10_000 });
}

const keyboardEvent = (name: string) =>
  act(async () => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener();
  });

beforeAll(initI18nEn);
beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
  useDisplayPrefsStore.setState({ liteMode: true });
  listeners = new Map();
  addListener = jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, listener: Listener) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(listener);
    return { remove: () => listeners.get(name)?.delete(listener) };
  }) as never);
  isVisible = jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
});
afterEach(async () => {
  addListener.mockRestore();
  isVisible.mockRestore();
  resetChatSession();
  await new Promise((r) => setTimeout(r, 100));
});

it('shows on the Profile chat', async () => {
  await openFreshChat({ kind: 'persona', page: 'profile' });

  expect(await screen.findByTestId('chat-sample', {}, { timeout: 5_000 })).toBeTruthy();
});

it('stays up while no keyboard is open', async () => {
  await openFreshChat();

  expect(await screen.findByTestId('chat-sample', {}, { timeout: 5_000 })).toBeTruthy();
});

it.each(['keyboardWillShow', 'keyboardDidShow'])('goes on %s with no touch', async (event) => {
  await openFreshChat();
  await screen.findByTestId('chat-sample', {}, { timeout: 5_000 });

  await keyboardEvent(event);

  expect(screen.queryByTestId('chat-sample')).toBeNull();
});

it('stays gone once the keyboard closes', async () => {
  await openFreshChat();
  await screen.findByTestId('chat-sample', {}, { timeout: 5_000 });

  await keyboardEvent('keyboardDidShow');
  await keyboardEvent('keyboardDidHide');

  expect(screen.queryByTestId('chat-sample')).toBeNull();
});

it('never shows when the chat opens over a keyboard already up', async () => {
  isVisible.mockReturnValue(true);

  await openFreshChat();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });

  expect(screen.queryByTestId('chat-sample')).toBeNull();
});
