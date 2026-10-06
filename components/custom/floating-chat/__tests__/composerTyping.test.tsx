// The composer keeps every character typed into it.
//
// Drives the REAL PromptInput inside the real ChatThread (the composer every
// chat uses, onboarding Step 2 included), one character at a time, with
// parent re-renders, store traffic and a composer draft in between, and
// asserts the value accumulates and the field stays editable. Written for a
// device report of "one character, then no more input"; it passes, so that
// report is not a JS state reset in this component (jest cannot see focus).

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

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
jest.mock('@/components/custom/chat/MeraStreamAvatar', () => ({ __esModule: true, default: () => null }));
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

jest.mock('@/components/ui/chat-ai', () => {
  const actual = jest.requireActual('@/components/ui/chat-ai');
  const R = require('react');
  const RN = require('react-native');
  return {
    ...actual,
    Conversation: (p: any) => R.createElement(RN.View, null, p.children),
    ConversationContent: (p: any) => R.createElement(RN.View, null, p.header ?? null),
  };
});
jest.mock('../TopicPlanSaveAllRow', () => ({ __esModule: true, default: () => null }));

import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import ChatThread from '../ChatThread';

const props = (over: Record<string, unknown> = {}) => ({
  items: [],
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

function input() {
  return screen.getByPlaceholderText('floatingChat.inputPlaceholder');
}

function typeOneByOne(word: string) {
  let typed = '';
  for (const ch of word) {
    typed += ch;
    fireEvent.changeText(input(), typed);
    expect(input().props.value).toBe(typed);
    expect(input().props.editable).toBe(true);
  }
}

beforeEach(() => useFloatingChatStore.getState().reset());

it('accumulates character by character', () => {
  render(<ChatThread {...props()} />);
  typeOneByOne('I live in Berlin');
});

it('keeps the text across parent re-renders and store traffic', () => {
  const view = render(<ChatThread {...props()} />);
  typeOneByOne('Ber');
  view.rerender(<ChatThread {...props({ composerHint: null })} />);
  act(() => {
    useFloatingChatStore.getState().setGenerating(false);
    useFloatingChatStore.getState().setBubbleCenter({ x: 1, y: 2 });
  });
  expect(input().props.value).toBe('Ber');
  fireEvent.changeText(input(), 'Berl');
  expect(input().props.value).toBe('Berl');
});

it('a draft lands once and typing carries on from it', () => {
  render(<ChatThread {...props()} />);
  act(() => useFloatingChatStore.getState().expand(undefined, { draft: 'Add ' }));
  expect(input().props.value).toBe('Add ');
  fireEvent.changeText(input(), 'Add a');
  fireEvent.changeText(input(), 'Add an');
  expect(input().props.value).toBe('Add an');
  expect(useFloatingChatStore.getState().pendingDraft).toBeNull();
});
