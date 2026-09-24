// A waiting fact card is not an error and not a gate (audit F7), and the
// usage notice depends on which chat this is (audit F12).

import React from 'react';
import { render } from '@testing-library/react-native';

let mockThreadProps: any = null;
jest.mock('../ChatThread', () => ({
  __esModule: true,
  default: (p: any) => {
    mockThreadProps = p;
    return null;
  },
}));
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
let mockItems: any[] = [];
jest.mock('../deriveThreadItems', () => ({ deriveThreadItems: () => mockItems }));
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

const sendMessage = jest.fn();
const baseProps: ChatSessionViewProps = {
  messages: [],
  status: 'idle',
  sendMessage,
  sendHiddenTurn: jest.fn(),
  isBlocked: false,
  blockedReason: null,
  error: null,
  context: { kind: 'persona' },
  userId: '',
  conversationId: null,
  isLoading: false,
};

const pendingCard = {
  kind: 'fact-choice-card',
  key: 'fc-1',
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

beforeEach(() => {
  jest.clearAllMocks();
  mockThreadProps = null;
  mockItems = [];
});

describe('a waiting fact card', () => {
  it('never blocks the composer or shows an error before the user acts', () => {
    mockItems = [pendingCard];
    render(<ChatSessionView {...baseProps} />);
    expect(mockThreadProps.bannerBlocksInput).toBe(false);
    expect(mockThreadProps.blockedMessage).toBeNull();
    expect(mockThreadProps.composerHint).toBe('factChoice.pendingHint');
  });

  it('takes a typed answer and leaves the card as it was', () => {
    mockItems = [pendingCard];
    render(<ChatSessionView {...baseProps} />);
    mockThreadProps.onSend('the one in Germany');
    expect(sendMessage).toHaveBeenCalledWith('the one in Germany');
  });

  it('says nothing when no card is waiting', () => {
    render(<ChatSessionView {...baseProps} />);
    expect(mockThreadProps.composerHint).toBeNull();
  });
});

describe('the usage notice', () => {
  it('keeps the settings assistant notice for the persona chat', () => {
    render(<ChatSessionView {...baseProps} />);
    expect(mockThreadProps.usageNotice).toBe('floatingChat.aiUsageNotice');
  });

  it('uses the general notice in an article chat', () => {
    render(<ChatSessionView {...baseProps} context={{ kind: 'article-suggestion', articleId: 'a1' }} />);
    expect(mockThreadProps.usageNotice).toBe('floatingChat.aiUsageNoticeGeneral');
  });
});
