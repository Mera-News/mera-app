// A transport failure must never disable the composer.
//
// DEVICE BUG: the banner and the input gate were the same condition
// (`blockedMessage !== null`). store.error sets that banner, and store.error
// is cleared only by starting a turn — which needs the input. So one failed
// turn killed the composer for the rest of the session, under a banner that
// said "try again in a moment".

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
jest.mock('@/components/custom/chat/MeraStreamAvatar', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/chat/StreamingWord', () => ({ __esModule: true, default: () => null }));

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
  useCloudChatStore: (sel: (s: unknown) => unknown) => sel({ thinking: false, agentTurnState: null }),
}));

const mockSubmit = jest.fn();
jest.mock('@/components/ui/chat-ai', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    Conversation: (p: any) => R.createElement(RN.View, null, p.children),
    ConversationContent: (p: any) => R.createElement(RN.View, null, p.header ?? null),
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

beforeEach(() => jest.clearAllMocks());

describe('after a transport failure', () => {
  const failed = {
    blockedMessage: 'chat.inferenceError',
    bannerBlocksInput: false,
  };

  it('leaves the input ENABLED, so the user can do what the banner says', () => {
    const { getByTestId } = render(<ChatThread {...props(failed)} />);
    expect(getByTestId('prompt-input').props.accessibilityState.disabled).toBe(false);
  });

  it('still shows the banner', () => {
    const { getByText } = render(<ChatThread {...props(failed)} />);
    expect(getByText('chat.inferenceError')).toBeTruthy();
  });

  it('a second send starts a turn', () => {
    const onSend = jest.fn();
    const { getByTestId } = render(<ChatThread {...props({ ...failed, onSend })} />);
    fireEvent.press(getByTestId('prompt-input'));
    expect(onSend).toHaveBeenCalledWith('second try');
  });
});

describe('the causes that SHOULD still block', () => {
  it('a server block disables the input', () => {
    const { getByTestId } = render(
      <ChatThread
        {...props({ blockedMessage: 'errors.accountRestricted', bannerBlocksInput: true })}
      />,
    );
    expect(getByTestId('prompt-input').props.accessibilityState.disabled).toBe(true);
  });

  it('an unresolved card gate disables the input', () => {
    const { getByTestId } = render(
      <ChatThread
        {...props({
          blockedMessage: 'factChoice.resolveBeforeContinuing',
          bannerBlocksInput: true,
        })}
      />,
    );
    expect(getByTestId('prompt-input').props.accessibilityState.disabled).toBe(true);
  });

  it('a blocked send does not reach onSend', () => {
    const onSend = jest.fn();
    const { getByTestId } = render(
      <ChatThread {...props({ blockedMessage: 'x', bannerBlocksInput: true, onSend })} />,
    );
    fireEvent.press(getByTestId('prompt-input'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('isInputDisabled still wins on its own', () => {
    const { getByTestId } = render(<ChatThread {...props({ isInputDisabled: true })} />);
    expect(getByTestId('prompt-input').props.accessibilityState.disabled).toBe(true);
  });
});
