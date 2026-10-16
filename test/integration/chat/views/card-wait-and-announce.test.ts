// onemera S1: the composer hint while a card waits, and the spoken line when a
// card resolves by typing. Real stores; the engine callbacks are plain jest.fn.
import { act, renderHook } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { useChatSessionView } from '@/components/custom/floating-chat/useChatSessionView';
import type { ChatSessionViewProps } from '@/components/custom/floating-chat/ChatSessionView';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import type { ConversationMessage, StagedProposal, ToolCallRecord } from '@/lib/llm/types';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import i18n from '@/lib/i18n';
import { initI18nEn } from '@/test/helpers';

const t = (key: string): string => (i18n.t as unknown as (k: string) => string)(key);

const PROPOSAL: StagedProposal = {
  id: 'p1',
  explanation: 'x',
  expectedEffects: 'y',
  actions: [{ type: 'add_fact', statement: 'Lives in Porto' }],
};

const proposeCall: ToolCallRecord = {
  id: 'tc-propose',
  name: 'proposeChanges',
  input: { actions: [{ type: 'add_fact', statement: 'Lives in Porto' }] },
  status: 'done',
  result: { awaiting: 'user', id: 'p1', actions: [{ type: 'add_fact', statement: 'Lives in Porto' }] },
};
const user = (id: string, content: string): ConversationMessage => ({ id, role: 'user', content });
const asst = (id: string, toolCalls: ToolCallRecord[]): ConversationMessage => ({
  id,
  role: 'assistant',
  content: 'Here you go.',
  toolCalls,
});

let announce: jest.SpyInstance;

beforeAll(initI18nEn);
beforeEach(() => {
  useFloatingChatStore.getState().reset();
  useCloudChatStore.getState().reset();
  useUserStore.setState({ userPersona: null });
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});
afterEach(() => announce.mockRestore());

function mount(messages: ConversationMessage[]) {
  const props: ChatSessionViewProps = {
    messages,
    status: 'idle',
    sendMessage: jest.fn(),
    sendHiddenTurn: jest.fn(),
    isBlocked: false,
    blockedReason: null,
    error: null,
    context: { kind: 'persona' },
    userId: 'user-1',
    conversationId: 'c1',
    isLoading: false,
  };
  const hook = renderHook((p: ChatSessionViewProps) => useChatSessionView(p), { initialProps: props });
  return { ...hook, setMessages: (next: ConversationMessage[]) => hook.rerender({ ...props, messages: next }) };
}

describe('composerHint while a card waits', () => {
  it('reads the card hint while the store proposal is pending', () => {
    useFloatingChatStore.getState().setProposal(PROPOSAL);
    const { result } = mount([user('u1', 'tune it'), asst('a1', [proposeCall])]);
    expect(result.current.composerHint).toBe(t('floatingChat.cardWaitingHint'));
  });

  it('shows no hint without a store proposal, or once it resolved', () => {
    const { result } = mount([user('u1', 'tune it'), asst('a1', [proposeCall])]);
    expect(result.current.composerHint).toBeNull();
    act(() => {
      useFloatingChatStore.getState().setProposal(PROPOSAL);
      useFloatingChatStore.getState().resolveProposal('cancelled');
    });
    expect(result.current.composerHint).toBeNull();
  });

  it('the fact-card hint wins when a fact card waits too', () => {
    useFloatingChatStore.getState().setProposal(PROPOSAL);
    const factCall: ToolCallRecord = {
      id: 'tc-facts',
      name: 'saveExtractedFacts',
      input: {},
      status: 'done',
      result: {
        staged: true,
        factsSaved: 0,
        groupResolutions: {},
        pendingFacts: [{ index: 0, options: ['Lives in Porto'], questionnaireAttribute: null }],
      },
    };
    const { result } = mount([user('u1', 'hi'), asst('a1', [proposeCall, factCall])]);
    if (result.current.unresolvedFactChoices > 0) {
      expect(result.current.composerHint).toBe(t('factChoice.pendingHint'));
    } else {
      // The fixture did not stage a card: fail loudly rather than pass on nothing.
      throw new Error('fixture produced no fact-choice card');
    }
  });
});

describe('announcing a card resolved by typing', () => {
  const applyCall: ToolCallRecord = {
    id: 'tc-apply',
    name: 'applyProposal',
    input: {},
    status: 'done',
    result: { applied: 1, changeLogIds: ['c1'] },
  };
  const cancelCall: ToolCallRecord = { ...applyCall, id: 'tc-cancel', name: 'cancelProposal', result: {} };

  it('speaks the applied line when the turn carried applyProposal', () => {
    useFloatingChatStore.getState().setProposal(PROPOSAL);
    const { setMessages } = mount([user('u1', 'tune it'), asst('a1', [proposeCall])]);
    // The typed yes lands first, the store resolves inside the tool, and the
    // call's record reaches the messages after it.
    setMessages([user('u1', 'tune it'), asst('a1', [proposeCall]), user('u2', 'yes')]);
    act(() => useFloatingChatStore.getState().resolveProposal('applied'));
    expect(announce).not.toHaveBeenCalled(); // the call has not landed yet
    setMessages([user('u1', 'tune it'), asst('a1', [proposeCall]), user('u2', 'yes'), asst('a2', [applyCall])]);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(t('articleFeedback.proposalApplied'));
  });

  it('speaks the cancelled line for cancelProposal', () => {
    useFloatingChatStore.getState().setProposal(PROPOSAL);
    const { setMessages } = mount([user('u1', 'tune it'), asst('a1', [proposeCall])]);
    setMessages([user('u1', 'tune it'), asst('a1', [proposeCall]), user('u2', 'no')]);
    act(() => useFloatingChatStore.getState().resolveProposal('cancelled'));
    setMessages([user('u1', 'tune it'), asst('a1', [proposeCall]), user('u2', 'no'), asst('a2', [cancelCall])]);
    expect(announce).toHaveBeenCalledWith(t('floatingChat.cardCancelled'));
  });

  it('stays silent when a button tap resolved it', () => {
    useFloatingChatStore.getState().setProposal(PROPOSAL);
    const { setMessages } = mount([user('u1', 'tune it'), asst('a1', [proposeCall])]);
    act(() => useFloatingChatStore.getState().resolveProposal('applied'));
    setMessages([user('u1', 'tune it'), asst('a1', [proposeCall])]);
    // A later typed turn that applies something else must not speak for the tap.
    setMessages([user('u1', 'tune it'), asst('a1', [proposeCall]), user('u2', 'also this'), asst('a2', [applyCall])]);
    expect(announce).not.toHaveBeenCalled();
  });
});
