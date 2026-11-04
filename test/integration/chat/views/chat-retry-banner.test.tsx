// The failure banner's one-tap Retry. The engine's retry is covered in cloud-engine/retry.test.ts;
// this is the view seam: when Retry shows, what a tap does, and that it cannot fire twice.
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import ChatThread from '@/components/custom/floating-chat/ChatThread';
import { useChatSessionView } from '@/components/custom/floating-chat/useChatSessionView';
import type { ChatSessionViewProps } from '@/components/custom/floating-chat/ChatSessionView';
import type { ChatThreadProps } from '@/components/custom/floating-chat/types';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { initI18nEn } from '@/test/helpers';

jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));

const mockCanRetry = jest.fn(() => true);
const mockRetry = jest.fn();
jest.mock('@/lib/chat-session/chat-session', () => ({
  ...jest.requireActual('@/lib/chat-session/chat-session'),
  canRetryChatTurn: () => mockCanRetry(),
  retryChatTurn: () => mockRetry(),
}));

const baseProps: ChatSessionViewProps = {
  messages: [],
  status: 'idle',
  sendMessage: jest.fn(),
  sendHiddenTurn: jest.fn(),
  isBlocked: false,
  blockedReason: null,
  error: 'boom',
  context: { kind: 'persona' },
  userId: 'user-1',
  conversationId: 'c1',
  isLoading: false,
};

/** The hook wired to the real ChatThread, as ChatSessionView does. */
function Harness(props: ChatSessionViewProps) {
  const v = useChatSessionView(props);
  const thread: ChatThreadProps = {
    items: [],
    isStreaming: false,
    onLoadOlder: () => {},
    hasOlder: false,
    isLoadingOlder: false,
    showHistoryButton: false,
    onRevealHistory: () => {},
    starterChips: [],
    onChipPress: () => {},
    blockedMessage: v.blockedMessage,
    onRetry: v.onRetry,
    bannerBlocksInput: v.bannerBlocksInput,
    showUnblockControls: false,
    unblockPending: false,
    onRequestUnblock: () => {},
    onRefreshBlockStatus: () => {},
    isRefreshingBlockStatus: false,
    onSend: () => {},
    isInputDisabled: false,
  };
  return <ChatThread {...thread} />;
}

beforeAll(initI18nEn);
beforeEach(() => {
  mockCanRetry.mockReset().mockReturnValue(true);
  mockRetry.mockReset();
  useFloatingChatStore.getState().reset();
});

it('hides Retry when the engine cannot retry', async () => {
  mockCanRetry.mockReturnValue(false);
  const view = await render(<Harness {...baseProps} />);
  expect(view.getByText("We're having trouble reaching the Mera inference service", { exact: false })).toBeTruthy();
  expect(view.queryByTestId('chat-retry-turn')).toBeNull();
});

it('hides Retry when there is no error', async () => {
  const view = await render(<Harness {...baseProps} error={null} />);
  expect(view.queryByTestId('chat-retry-turn')).toBeNull();
});

it('shows Retry, including on the render after isGenerating clears', async () => {
  mockCanRetry.mockReturnValue(false);
  useFloatingChatStore.setState({ isGenerating: true });
  const view = await render(<Harness {...baseProps} />);
  expect(view.queryByTestId('chat-retry-turn')).toBeNull();

  mockCanRetry.mockReturnValue(true);
  await act(async () => useFloatingChatStore.setState({ isGenerating: false }));
  expect(view.getByTestId('chat-retry-turn')).toBeTruthy();
});

it('a double tap retries once and the banner hides', async () => {
  const view = await render(<Harness {...baseProps} />);
  const button = view.getByTestId('chat-retry-turn');
  expect(button.props.accessibilityLabel).toBe('Retry');
  await fireEvent.press(button);
  await fireEvent.press(button);
  expect(mockRetry).toHaveBeenCalledTimes(1);
  expect(view.queryByTestId('chat-retry-turn')).toBeNull();
  expect(view.queryByText("We're having trouble", { exact: false })).toBeNull();
});

it('offers Retry again after a repeat failure', async () => {
  const view = await render(<Harness {...baseProps} />);
  await fireEvent.press(view.getByTestId('chat-retry-turn'));
  await view.rerender(<Harness {...baseProps} error={null} />);
  await view.rerender(<Harness {...baseProps} error="again" />);
  await fireEvent.press(view.getByTestId('chat-retry-turn'));
  expect(mockRetry).toHaveBeenCalledTimes(2);
});

it('keeps the touch frame at 44pt as a number', async () => {
  const view = await render(<Harness {...baseProps} />);
  const frame = view.getByTestId('chat-retry-turn').parent!;
  expect(JSON.stringify(frame.props.style)).toContain('"minHeight":44');
});
