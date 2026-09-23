/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

// ChatThread imports every card, and several of those reach services that
// build WatermelonDB collections at MODULE SCOPE. Stubbing the database once
// is cheaper and less brittle than stubbing each service, and this suite
// renders no cards anyway: `items` is empty.
// ChatThread imports every card, and several reach WatermelonDB, SVG or
// gesture-handler at module scope. This suite is about ONE boolean (does the
// banner gate the composer), renders no cards at all, and stubbing them is
// both cheaper and more stable than chasing each transitive library.
jest.mock('../AgentStepsBox', () => ({ __esModule: true, default: () => null }));
jest.mock('../ArticleContextCard', () => ({ __esModule: true, default: () => null }));
jest.mock('../AskChoiceCard', () => ({ __esModule: true, default: () => null }));
jest.mock('../FactCard', () => ({ __esModule: true, default: () => null }));
jest.mock('../OptimisationPlanCard', () => ({ __esModule: true, default: () => null }));
jest.mock('../ProposalCard', () => ({ __esModule: true, default: () => null }));
jest.mock('../QuickFactCheckCard', () => ({ __esModule: true, default: () => null }));
jest.mock('../FactChoiceCard', () => ({ __esModule: true, default: () => null }));
jest.mock('../FactChoiceBulkRow', () => ({ __esModule: true, default: () => null }));
jest.mock('../ChatTopicsCard', () => ({ __esModule: true, default: () => null }));
jest.mock('../TopicPlanCard', () => ({ __esModule: true, default: () => null }));
jest.mock('../ConflictResolutionCard', () => ({ __esModule: true, default: () => null }));
jest.mock('../StarterChips', () => ({ __esModule: true, default: () => null }));
jest.mock('../ChatPopover', () => ({ PopoverPhaseContext: { Provider: null } }));
jest.mock('@/components/custom/chat/MeraStreamAvatar', () => ({
  __esModule: true,
  AVATAR_GUTTER_WIDTH: 28,
  default: () => {
    const R = require('react');
    const RN = require('react-native');
    return R.createElement(RN.View, { testID: 'mera-stream-avatar' });
  },
}));
jest.mock('@/components/custom/chat/ChatPhaseLine', () => ({ __esModule: true, default: () => null }));

// Reached through StatusIndicator in the agent-steps box; RN's own mock
// requireActual's an untransformed specs_DEPRECATED file.
jest.mock('react-native/Libraries/Components/ActivityIndicator/ActivityIndicator', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(RN.View, p) };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@expo/vector-icons', () => {
  const R = require('react');
  const RN = require('react-native');
  return { MaterialIcons: (p: any) => R.createElement(RN.View, p) };
});
jest.mock('react-native-reanimated', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    __esModule: true,
    default: {
      View: (p: any) => R.createElement(RN.View, p),
      // MeraLogo (reached via MeraStreamAvatar) animates an SVG <G>.
      createAnimatedComponent: (C: any) => C,
    },
    FadeInDown: { springify: () => ({ damping: () => ({ stiffness: () => ({ mass: () => ({}) }) }) }) },
    withTiming: (v: unknown) => v,
    useSharedValue: (v: unknown) => ({ value: v }),
    useAnimatedStyle: (f: () => unknown) => f(),
    cancelAnimation: jest.fn(),
    withRepeat: (v: unknown) => v,
    Easing: { inOut: (f: unknown) => f, quad: jest.fn() },
  };
});
jest.mock('@/components/custom/AiDisclosureCaption', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(RN.Text, null, p.text) };
});
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/stores/cloud-chat-store', () => ({
  useCloudChatStore: (sel: (s: unknown) => unknown) => sel({ agentTurnState: null }),
}));

const mockSubmit = jest.fn();
const mockScrollToIndex = jest.fn();
jest.mock('@/components/ui/chat-ai', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    Conversation: (p: any) => R.createElement(RN.View, null, p.children),
    // Renders the ITEMS, in order, so position in the list is observable.
    ConversationContent: (p: any) => {
      if (p.listRef && typeof p.listRef === 'object') p.listRef.current = { scrollToIndex: mockScrollToIndex };
      return R.createElement(
        RN.View,
        { testID: 'conversation-content' },
        ...p.items.map((it: any) => R.createElement(RN.View, { key: it.key, testID: `item-${it.key}` }, p.renderItem(it))),
        p.header ?? null,
      );
    },
    Message: (p: any) => R.createElement(RN.View, null, p.children),
    MessageContent: (p: any) => R.createElement(RN.View, null, p.children),
    MessageResponse: (p: any) => R.createElement(RN.Text, null, p.children),
    PromptInput: (p: any) =>
      R.createElement(RN.Pressable, {
        testID: 'prompt-input',
        disabled: p.disabled,
        accessibilityState: { disabled: !!p.disabled },
        onPress: () => {
          if (p.disabled) return;
          mockSubmit('second try');
          p.onSubmit('second try');
        },
      }),
  };
});
jest.mock('../TopicPlanSaveAllRow', () => ({ __esModule: true, default: () => null }));

import ChatThread from '../ChatThread';
import type { ChatThreadItem } from '../types';

const props = (over: Record<string, unknown> = {}) => ({
  items: [] as ChatThreadItem[],
  isStreaming: false,
  onLoadOlder: jest.fn(),
  hasOlder: false,
  isLoadingOlder: false,
  showHistoryButton: false,
  onRevealHistory: jest.fn(),
  starterChips: [],
  onChipPress: jest.fn(),
  blockedMessage: null,
  bannerBlocksInput: false,
  showUnblockControls: false,
  unblockPending: false,
  onRequestUnblock: jest.fn(),
  onRefreshBlockStatus: jest.fn(),
  isRefreshingBlockStatus: false,
  onSend: jest.fn(),
  isInputDisabled: false,
  ...over,
});

const reply = (id: string, streaming = false): ChatThreadItem => ({
  kind: 'message',
  key: `live-${id}`,
  message: { id, role: 'assistant', content: 'hello' },
  ...(streaming ? { streaming: true } : {}),
});

describe('F4: the reply bubble keeps one left edge', () => {
  it('holds the avatar gutter with a spacer once streaming ends', () => {
    const { getByTestId, queryByTestId } = render(<ChatThread {...props({ items: [reply('a1')] })} />);
    expect(queryByTestId('mera-stream-avatar')).toBeNull();
    expect(getByTestId('mera-avatar-spacer').props.style).toEqual({ width: 28 });
  });

  it('shows the avatar instead while streaming', () => {
    const { getByTestId, queryByTestId } = render(<ChatThread {...props({ items: [reply('a1', true)] })} />);
    expect(getByTestId('mera-stream-avatar')).toBeTruthy();
    expect(queryByTestId('mera-avatar-spacer')).toBeNull();
  });
});

describe('F11: "View previous messages" sits above the oldest message', () => {
  it('is the FIRST list item, not the list header', () => {
    const onRevealHistory = jest.fn();
    const { getByTestId } = render(
      <ChatThread {...props({ items: [reply('a1')], showHistoryButton: true, onRevealHistory })} />,
    );
    const list = getByTestId('conversation-content');
    expect(list.props.children[0].props.testID).toBe('item-history-button');
    fireEvent.press(getByTestId('chat-view-previous-messages'));
    expect(onRevealHistory).toHaveBeenCalled();
  });
});

describe('F7: a neutral hint while a card waits', () => {
  it('shows the hint and keeps the composer usable', () => {
    const { getByTestId, getByText } = render(<ChatThread {...props({ composerHint: 'factChoice.pendingHint' })} />);
    expect(getByText('factChoice.pendingHint')).toBeTruthy();
    expect(getByTestId('prompt-input').props.accessibilityState.disabled).toBe(false);
  });

  it('gives way to a real banner', () => {
    const { queryByTestId } = render(
      <ChatThread {...props({ composerHint: 'factChoice.pendingHint', blockedMessage: 'chat.inferenceError' })} />,
    );
    expect(queryByTestId('chat-composer-hint')).toBeNull();
  });
});

describe('F7 ruling: a waiting card is brought back into view after a typed reply', () => {
  const card: ChatThreadItem = {
    kind: 'fact-choice-card',
    key: 'fc',
    resultKey: 'm1::0',
    baseResult: {},
    groupIndex: 0,
    groupId: 'g0',
    options: ['Lives in Berlin'],
    questionnaireAttribute: null,
    replacesFactId: null,
    topicSkillId: null,
    dismissed: false,
    stale: false,
  };
  const user: ChatThreadItem = { kind: 'message', key: 'live-u2', message: { id: 'u2', role: 'user', content: 'x' } };

  it('scrolls to the pending card once the sent message lands', () => {
    mockScrollToIndex.mockClear();
    const onSend = jest.fn();
    const view = render(<ChatThread {...props({ items: [card, reply('a1')], onSend })} />);
    fireEvent.press(view.getByTestId('prompt-input'));
    expect(onSend).toHaveBeenCalled();
    view.rerender(<ChatThread {...props({ items: [card, reply('a1'), user], onSend })} />);
    // Reversed data: the card is the oldest of three, index 2.
    expect(mockScrollToIndex).toHaveBeenCalledWith({ index: 2, viewPosition: 0.5, animated: true });
  });

  it('does not scroll when no card is waiting', () => {
    mockScrollToIndex.mockClear();
    const view = render(<ChatThread {...props({ items: [reply('a1')] })} />);
    fireEvent.press(view.getByTestId('prompt-input'));
    view.rerender(<ChatThread {...props({ items: [reply('a1'), user] })} />);
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });
});
