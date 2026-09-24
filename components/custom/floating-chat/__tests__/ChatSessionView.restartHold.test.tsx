// A restart must never land while a chat response is arriving. The floating
// chat is an overlay, open over whatever route is current, and
// `lib/app-restart.ts`'s route gate only blocks a fixed list of routes
// (login, OTP, PIN, onboarding) — chat can be mid-turn over any other route,
// so that gate cannot see it. `holdRestart` from lib/app-restart is the only
// thing that can, and ChatSessionView is the one place that sees `isStreaming`,
// the cloud loop's `turnActive`, and on-device's `localTurnBusy` together.
//
// `isStreaming` (status === 'streaming') is a PROXY, not the authoritative
// signal, on EITHER engine: `status` goes idle EARLY while a cloud
// forced-extraction/continuation pass or an on-device tool-execution loop
// keeps writing facts (see useCloudPersonaChat's `setTurnBusy` — "turnBusyRef,
// not isStreamingRef" — and useLocalLLM's `turnBusy`). So the hold must track
// `isStreaming || turnActive === true || localTurnBusy === true`, and this
// suite proves each end path releases it: normal completion, an error, and
// unmount.

import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('../ChatThread', () => ({ __esModule: true, default: () => null }));
jest.mock('../RequestUnblockModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
jest.mock('@/components/ui/text', () => ({ Text: () => null }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

jest.mock('@/lib/account-service', () => ({
  AccountService: { getPendingUnblockRequest: jest.fn().mockResolvedValue(null) },
}));
jest.mock('@/lib/hooks/useChatHistory', () => ({
  useChatHistory: () => ({ history: [], loadOlder: jest.fn(), hasOlder: false, isLoadingOlder: false }),
}));
jest.mock('@/lib/hooks/useChatPersistence', () => ({ useChatPersistence: jest.fn() }));
jest.mock('@/lib/database/services/user-persona-service', () => ({
  loadUserPersona: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/lib/haptics', () => ({ hapticMedium: jest.fn(), hapticSuccess: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));
jest.mock('@/lib/stores/mera-protocol-store', () => ({ useIsOnDeviceProcessing: () => false }));
jest.mock('@/lib/stores/user-store', () => ({
  useUserStore: { getState: () => ({ userPersona: null, fetchUserPersona: jest.fn() }) },
}));
jest.mock('@/lib/stores/subscription-store', () => ({ getAiAccess: () => 'unlocked' }));
jest.mock('../deriveThreadItems', () => ({ deriveThreadItems: () => [] }));
jest.mock('../topic-plan-turn', () => ({ decideTopicPlanTurn: () => 'wait' }));
jest.mock('@/lib/news-harness/persona-management/topic-plan-notes', () => ({
  buildTopicPlanTurnBody: () => '',
}));
jest.mock('../useTopicPlanResolutions', () => ({
  useTopicPlanResolutions: () => ({ unresolved: [] }),
}));

const mockFloatingChatStoreState = {
  setUnresolvedTopicPlanCount: jest.fn(),
  setUnresolvedFactChoiceCount: jest.fn(),
  clearTopicPlanTurnRequest: jest.fn(),
  setGenerating: jest.fn(),
  consumePendingInitialMessage: jest.fn(() => null),
  setTopicPlanTurnInFlight: jest.fn(),
  topicPlanNotes: [] as unknown[],
};
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatQuickFactChecks: () => [],
  useFloatingChatToolCallResults: () => ({}),
  useFloatingChatTopicPlanTurnRequest: () => null,
  useFloatingChatStore: { getState: () => mockFloatingChatStoreState },
}));

// Plain object read by the mock hook below — not a real store subscription,
// so a test drives it by mutating this object and re-rendering.
const mockCloudChatState: { agentTurnState: { turnActive: boolean } | null; agentTerminal: null } = {
  agentTurnState: null,
  agentTerminal: null,
};
jest.mock('@/lib/stores/cloud-chat-store', () => ({
  useCloudChatStore: (sel: (s: typeof mockCloudChatState) => unknown) => sel(mockCloudChatState),
}));

// A closure, not a direct reference: the test file's own `const` declarations
// run AFTER the hoisted `import '../ChatSessionView'` (jest hoists `jest.mock`
// above every require, and babel hoists the import itself above this file's
// plain statements), so a factory that reads `mockHoldRestart` eagerly would
// capture it before assignment. Deferring the read into a closure invoked at
// CALL time (well after module evaluation finishes) sidesteps the ordering.
const mockReleaseHold = jest.fn();
const mockHoldRestart = jest.fn((_label: string) => mockReleaseHold);
jest.mock('@/lib/app-restart', () => ({
  holdRestart: (label: string) => mockHoldRestart(label),
}));

import ChatSessionView, { type ChatSessionViewProps } from '../ChatSessionView';

const baseProps: ChatSessionViewProps = {
  messages: [],
  status: 'idle',
  sendMessage: jest.fn(),
  sendHiddenTurn: jest.fn(),
  isBlocked: false,
  blockedReason: null,
  error: null,
  context: { kind: 'persona' },
  // Falsy on purpose: skips the persona-block seed effect and the pending
  // unblock check, neither of which this suite is about.
  userId: '',
  conversationId: null,
  isLoading: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCloudChatState.agentTurnState = null;
  mockCloudChatState.agentTerminal = null;
});

describe('holding a restart while a response is in flight', () => {
  it('does not hold while idle', () => {
    render(<ChatSessionView {...baseProps} status="idle" />);
    expect(mockHoldRestart).not.toHaveBeenCalled();
  });

  it('holds as soon as the stream starts', () => {
    render(<ChatSessionView {...baseProps} status="streaming" />);
    expect(mockHoldRestart).toHaveBeenCalledWith('chat-stream');
    expect(mockReleaseHold).not.toHaveBeenCalled();
  });

  it('releases on normal completion (status back to idle, turnActive false)', () => {
    const { rerender } = render(<ChatSessionView {...baseProps} status="streaming" />);
    expect(mockHoldRestart).toHaveBeenCalledTimes(1);

    rerender(<ChatSessionView {...baseProps} status="idle" />);
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
  });

  it('releases on an error turn (status idle, error set)', () => {
    const { rerender } = render(<ChatSessionView {...baseProps} status="streaming" />);
    rerender(<ChatSessionView {...baseProps} status="idle" error="Cloud chat failed: boom" />);
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
  });

  it('stays held through the cloud tool-execution tail: status idle, turnActive still true', () => {
    const { rerender } = render(<ChatSessionView {...baseProps} status="streaming" />);
    expect(mockHoldRestart).toHaveBeenCalledTimes(1);

    // `status` goes idle early (the forced-extraction dispatch), but the loop
    // has not released `turnActive` yet.
    mockCloudChatState.agentTurnState = { turnActive: true };
    rerender(<ChatSessionView {...baseProps} status="idle" />);
    expect(mockReleaseHold).not.toHaveBeenCalled();

    // The tail finishes and the loop clears turnActive.
    mockCloudChatState.agentTurnState = { turnActive: false };
    rerender(<ChatSessionView {...baseProps} status="idle" />);
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
  });

  it('holds on turnActive alone, even if isStreaming never flips true this render', () => {
    mockCloudChatState.agentTurnState = { turnActive: true };
    render(<ChatSessionView {...baseProps} status="idle" />);
    expect(mockHoldRestart).toHaveBeenCalledWith('chat-stream');
  });

  it('releases unconditionally on unmount mid-stream', () => {
    const { unmount } = render(<ChatSessionView {...baseProps} status="streaming" />);
    expect(mockHoldRestart).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).not.toHaveBeenCalled();

    unmount();
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
  });

  it('never leaks a second hold across a re-render while still streaming', () => {
    const { rerender } = render(<ChatSessionView {...baseProps} status="streaming" />);
    rerender(<ChatSessionView {...baseProps} status="streaming" messages={[]} />);
    expect(mockHoldRestart).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).not.toHaveBeenCalled();
  });
});

describe('the on-device (localTurnBusy) tail', () => {
  it('does not hold when localTurnBusy is undefined (the cloud-engine render)', () => {
    render(<ChatSessionView {...baseProps} status="idle" />);
    expect(mockHoldRestart).not.toHaveBeenCalled();
  });

  it('holds on localTurnBusy alone, even while status is idle', () => {
    render(<ChatSessionView {...baseProps} status="idle" localTurnBusy={true} />);
    expect(mockHoldRestart).toHaveBeenCalledWith('chat-stream');
  });

  // THE GAP: `useLocalLLM`'s own `status` goes idle at the "release input
  // before tool execution" point, before the tool call this turn staged has
  // actually run. This is the exact prop shape ChatSessionView sees from
  // LocalPersonaChat at that moment — status already idle, localTurnBusy
  // still true — and it is the scenario a hold keyed on `isStreaming` alone
  // would silently release under. A suite that only checks "hold on start,
  // release on idle" passes just as happily with this gap present.
  it('stays held when status goes idle but localTurnBusy is still true (tool execution in flight)', () => {
    const { rerender } = render(
      <ChatSessionView {...baseProps} status="streaming" localTurnBusy={true} />,
    );
    expect(mockHoldRestart).toHaveBeenCalledTimes(1);

    rerender(<ChatSessionView {...baseProps} status="idle" localTurnBusy={true} />);
    expect(mockReleaseHold).not.toHaveBeenCalled();

    // The tool call finishes and the hook's own `finally` clears turnBusy.
    rerender(<ChatSessionView {...baseProps} status="idle" localTurnBusy={false} />);
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
  });

  it('releases unconditionally on unmount while localTurnBusy is still true', () => {
    const { unmount } = render(
      <ChatSessionView {...baseProps} status="idle" localTurnBusy={true} />,
    );
    expect(mockHoldRestart).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).not.toHaveBeenCalled();

    unmount();
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
  });
});
