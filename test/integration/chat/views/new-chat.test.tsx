// NEW CHAT on the real surface: nothing of the previous thread may stay on screen above the new
// question, and nothing of it may be written into the new conversation.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import MeraChatSession from '@/components/custom/floating-chat/MeraChatSession';
import { resetChatSession } from '@/lib/chat-session/chat-session';
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { defaultResponder, initI18nEn, mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules, seedFacts, until } from '@/test/integration/chat/_helpers';

jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
jest.setTimeout(60_000);

const OLD = 'What is the old question?';
const NEW = 'What is the new question?';
const idle = () => !useFloatingChatStore.getState().isGenerating;

async function ask(text: string) {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('chat-input'), text);
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('chat-send'));
  });
}

async function newChat() {
  const before = useFloatingChatStore.getState().conversationId;
  await act(async () => {
    useFloatingChatStore.getState().requestNewChat();
  });
  await until(() => {
    const id = useFloatingChatStore.getState().conversationId;
    return id !== null && id !== before;
  }, 5000, 'a new conversation');
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
}

const expectOnlyNew = async () => {
  await waitFor(() => expect(screen.queryByText(NEW)).toBeTruthy());
  expect(screen.queryByText(OLD)).toBeNull();
  expect(useCloudChatStore.getState().messages.some((m) => m.content === OLD)).toBe(false);
  await until(idle, 10_000, 'the new turn ends');
  await new Promise((r) => setTimeout(r, 100));
  const rows = await fetchMessagesForConversation(useFloatingChatStore.getState().conversationId!);
  expect(rows.some((m) => m.content === OLD)).toBe(false);
};

beforeAll(initI18nEn);
beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
  await seedFacts(['Lives in Oslo']);
  useDisplayPrefsStore.setState({ liteMode: true });
  useFloatingChatStore.setState({ context: { kind: 'persona' }, isExpanded: true });
  await render(<MeraChatSession />);
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy(), { timeout: 10_000 });
});
afterEach(async () => {
  resetChatSession();
  await new Promise((r) => setTimeout(r, 100));
});

it('after a finished turn', async () => {
  await ask(OLD);
  await until(() => useCloudChatStore.getState().messages.length > 1 && idle(), 10_000, 'first turn');
  await newChat();
  await ask(NEW);
  await expectOnlyNew();
});

it('during a running turn', async () => {
  server.use(...mockGateway((call) => (call.route === 'chat' && call.messages.some((m) => m.content.includes(OLD)) ? { chunks: ['Looking ', 'x'], stallAfter: 1 } : defaultResponder(call))));
  await ask(OLD);
  await until(() => useCloudChatStore.getState().messages.length > 1, 10_000, 'first turn');
  await newChat();
  await ask(NEW);
  await expectOnlyNew();
});

it('after a failed turn', async () => {
  server.use(...mockGateway((call) => (call.route === 'chat' && call.messages.some((m) => m.content.includes(OLD)) ? { status: 400, body: 'no' } : defaultResponder(call))));
  await ask(OLD);
  await until(() => useCloudChatStore.getState().error !== null && idle(), 15_000, 'first turn fails');
  await newChat();
  await ask(NEW);
  await expectOnlyNew();
});

it('after closing and reopening the panel', async () => {
  await ask(OLD);
  await until(() => useCloudChatStore.getState().messages.length > 1 && idle(), 10_000, 'first turn');
  await screen.unmount();
  await render(<MeraChatSession />);
  await waitFor(() => expect(screen.getByTestId('chat-input')).toBeTruthy());
  await newChat();
  await ask(NEW);
  await expectOnlyNew();
});
