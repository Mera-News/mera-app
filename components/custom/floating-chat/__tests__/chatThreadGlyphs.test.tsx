// ux2 batch 25: VoiceOver must never read an icon-font glyph in the chat.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { render } from '@testing-library/react-native';

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
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());
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
let mockContentProps: Record<string, unknown> = {};
jest.mock('@/components/ui/chat-ai', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    Conversation: (p: any) => R.createElement(RN.View, null, p.children),
    // Renders the ITEMS, in order, so position in the list is observable.
    ConversationContent: (p: any) => {
      mockContentProps = p;
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
import { privateUseLabelLeaks } from '@/lib/__test-helpers__/icon-glyph-a11y';

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


it('the thread chrome (history button, unblock refresh) leaks no glyph', () => {
  const { UNSAFE_root } = render(
    <ChatThread {...props({ showHistoryButton: true, blockedMessage: 'blocked', bannerBlocksInput: true, showUnblockControls: true, unblockPending: true })} />,
  );
  expect(privateUseLabelLeaks(UNSAFE_root)).toEqual([]);
});
