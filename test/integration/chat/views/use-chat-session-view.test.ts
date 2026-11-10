// Seam tests for useChatSessionView: the send funnel, the block gates, the
// pending-message auto-send, the intro and chips, and the topic-plan discard reply.
// Real stores, the in-memory DB and MSW; the engine callbacks are plain jest.fn props.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useChatSessionView } from '@/components/custom/floating-chat/useChatSessionView';
import type { ChatSessionViewProps } from '@/components/custom/floating-chat/ChatSessionView';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { buildTopicPlanTurnBody } from '@/lib/news-harness/persona-management/topic-plan-notes';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useFloatingChatStore, type ChatContext } from '@/lib/stores/floating-chat-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import i18n from '@/lib/i18n';
import { initI18nEn } from '@/test/helpers';

// No live engine here: Retry is on offer, and a tap is a no-op.
jest.mock('@/lib/chat-session/chat-session', () => ({
  ...jest.requireActual('@/lib/chat-session/chat-session'),
  canRetryChatTurn: () => true,
  retryChatTurn: () => {},
}));

const USER_ID = 'user-1';
const PERSONA_CONTEXT: ChatContext = { kind: 'persona' };
const ARTICLE_CONTEXT: ChatContext = {
  kind: 'article-suggestion',
  articleId: 'a1',
  suggestionId: 's1',
};

// i18n.t takes the typed key union from en.json; these tests pass plain strings.
const t = (key: string): string => (i18n.t as unknown as (k: string) => string)(key);

beforeAll(initI18nEn);

beforeEach(() => {
  useFloatingChatStore.getState().reset();
  useCloudChatStore.getState().reset();
  useUserStore.setState({ userPersona: null });
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
});

function makeProps(over: Partial<ChatSessionViewProps> = {}) {
  const sendMessage = jest.fn();
  const sendHiddenTurn = jest.fn();
  const props: ChatSessionViewProps = {
    messages: [],
    status: 'idle',
    sendMessage,
    sendHiddenTurn,
    isBlocked: false,
    blockedReason: null,
    error: null,
    context: PERSONA_CONTEXT,
    userId: USER_ID,
    conversationId: 'c1',
    isLoading: false,
    ...over,
  };
  return { props, sendMessage, sendHiddenTurn };
}

async function mount(over: Partial<ChatSessionViewProps> = {}) {
  const made = makeProps(over);
  const hook = await renderHook((p: ChatSessionViewProps) => useChatSessionView(p), {
    initialProps: made.props,
  });
  return { ...made, ...hook };
}

function seedBlockedPersona(reason: string | null) {
  useUserStore.getState().setUserPersona({
    userId: USER_ID,
    blockedByLlm: true,
    blockedByLlmReason: reason,
  } as never);
}

describe('handleSend', () => {
  it('trims the text and sends it once', async () => {
    const { result, sendMessage } = await mount();
    await act(() => result.current.handleSend('  hi  '));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('hi');
  });

  it.each(['', '   ', '\n\t'])('sends nothing for %j', async (text) => {
    const { result, sendMessage } = await mount();
    await act(() => result.current.handleSend(text));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('is a no-op while streaming', async () => {
    const { result, sendMessage } = await mount({ status: 'streaming' });
    await act(() => result.current.handleSend('hi'));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('is a no-op while isBlocked, and the banner shows the account-restricted copy', async () => {
    const { result, sendMessage } = await mount({ isBlocked: true });
    await act(() => result.current.handleSend('hi'));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.effectiveBlocked).toBe(true);
    expect(result.current.blockedMessage).toBe(t('errors.accountRestricted'));
  });

  it('is a no-op for a persisted blocked persona, and the banner shows its reason', async () => {
    seedBlockedPersona('x');
    const { result, sendMessage } = await mount();
    await waitFor(() => expect(result.current.effectiveBlocked).toBe(true));
    await act(() => result.current.handleSend('hi'));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.blockedMessage).toBe('x');
  });

  it('falls back to the account-restricted copy when the persisted block has no reason', async () => {
    seedBlockedPersona(null);
    const { result } = await mount();
    await waitFor(() => expect(result.current.effectiveBlocked).toBe(true));
    expect(result.current.blockedMessage).toBe(t('errors.accountRestricted'));
  });

  it('prefers the prop reason over the persisted one', async () => {
    seedBlockedPersona('persisted');
    const { result } = await mount({ isBlocked: true, blockedReason: 'from the server' });
    await waitFor(() => expect(result.current.effectiveBlocked).toBe(true));
    expect(result.current.blockedMessage).toBe('from the server');
  });
});

describe('pending initial message', () => {
  it('is sent exactly once across re-renders', async () => {
    useFloatingChatStore.getState().openArticleFeedback(ARTICLE_CONTEXT, 'seed');
    const { result, rerender, props, sendMessage } = await mount({ context: ARTICLE_CONTEXT });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('seed');
    await rerender({ ...props });
    await rerender({ ...props, messages: [] });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(useFloatingChatStore.getState().pendingInitialMessage).toBeNull();
    expect(result.current.introMessage).toBeNull();
  });

  it('is not consumed while loading, and goes out once loading ends', async () => {
    useFloatingChatStore.getState().openArticleFeedback(ARTICLE_CONTEXT, 'seed');
    const { rerender, props, sendMessage } = await mount({ context: ARTICLE_CONTEXT, isLoading: true });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(useFloatingChatStore.getState().pendingInitialMessage).toBe('seed');
    await rerender({ ...props, isLoading: false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('seed');
  });

  it('is not consumed while streaming, and goes out once the stream ends', async () => {
    useFloatingChatStore.getState().openArticleFeedback(ARTICLE_CONTEXT, 'seed');
    const { rerender, props, sendMessage } = await mount({
      context: ARTICLE_CONTEXT,
      status: 'streaming',
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(useFloatingChatStore.getState().pendingInitialMessage).toBe('seed');
    await rerender({ ...props, status: 'idle' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('error banner', () => {
  it('shows the generic inference copy and never the raw error string', async () => {
    const raw = 'E2EE chat failed: 400 Provider failed for model X: Decryption failed';
    const { result } = await mount({ error: raw });
    expect(result.current.blockedMessage).toBe(t('chat.inferenceError'));
    expect(result.current.blockedMessage).not.toContain('Decryption');
    expect(result.current.blockedMessage).not.toContain('E2EE chat failed');
  });
});

describe('error banner while a chat lane is out', () => {
  afterEach(() => {
    useForYouStore.getState().setLaneOutage('chat-tools', null);
    useForYouStore.getState().setLaneOutage('chat-single', null);
    useNetworkStore.setState({ isConnected: true });
  });

  it.each(['chat-tools', 'chat-single'] as const)('says the private AI is down when %s is out', async (lane) => {
    useForYouStore.getState().setLaneOutage(lane, { since: 1 });
    const { result } = await mount({ error: 'Cloud chat failed: Every model profile failed on lane chat-tools' });
    expect(result.current.blockedMessage).toBe(`${t('feed.outage.title')} ${t('feed.outage.helpBack')}`);
  });

  it('keeps the generic copy for an offline device even with a stale outage', async () => {
    useForYouStore.getState().setLaneOutage('chat-tools', { since: 1 });
    useNetworkStore.setState({ isConnected: false });
    const { result } = await mount({ error: 'boom' });
    expect(result.current.blockedMessage).toBe(t('chat.inferenceError'));
  });

  it('keeps the generic copy when only another lane is out', async () => {
    useForYouStore.getState().setLaneOutage('scoring', { since: 1 });
    const { result } = await mount({ error: 'boom' });
    expect(result.current.blockedMessage).toBe(t('chat.inferenceError'));
    useForYouStore.getState().setLaneOutage('scoring', null);
  });
});

describe('intro message', () => {
  it('shows the persona intro until the first send, then null', async () => {
    const { result, sendMessage } = await mount();
    expect(result.current.introMessage).toBe(t('personaChat.introMessage'));
    await act(() => result.current.handleSend('hello'));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(result.current.introMessage).toBeNull();
  });

  it('on this phone, the intro says On this phone is Beta', async () => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    const { result } = await mount();
    expect(result.current.introMessage).toBe(`${t('personaChat.introMessage')}\n\n${t('chat.onDeviceBetaNote')}`);
    expect(t('chat.onDeviceBetaNote')).toBe('On this phone is in Beta, so replies can be slower or less accurate.');
  });

  it('picks articleFeedback.intro for a suggestion', async () => {
    const { result } = await mount({ context: ARTICLE_CONTEXT });
    expect(result.current.introMessage).toBe(t('articleFeedback.intro'));
  });

  it('picks articleFeedback.introArticle for a plain article', async () => {
    const { result } = await mount({ context: { kind: 'article-suggestion', articleId: 'a1' } });
    expect(result.current.introMessage).toBe(t('articleFeedback.introArticle'));
  });
});

describe('starter chips', () => {
  const keys = (chips: { key: string }[]) => chips.map((c) => c.key);

  it('offers why, quick fact check and dont-want for a suggestion in cloud mode', async () => {
    const { result } = await mount({ context: ARTICLE_CONTEXT });
    expect(keys(result.current.starterChips)).toEqual(['why', 'quick-fact-check', 'dont-want']);
  });

  it('offers more-like-this instead of why for a plain article', async () => {
    const { result } = await mount({ context: { kind: 'article-suggestion', articleId: 'a1' } });
    expect(keys(result.current.starterChips)).toEqual([
      'more-like-this',
      'quick-fact-check',
      'dont-want',
    ]);
  });

  it('drops the quick fact check chip in on-device mode', async () => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    const { result } = await mount({ context: ARTICLE_CONTEXT });
    expect(keys(result.current.starterChips)).toEqual(['why', 'dont-want']);
  });

  it('offers no chips in an optimisation-plan thread', async () => {
    const { result } = await mount({ context: { kind: 'optimisation-plan' } });
    expect(result.current.starterChips).toEqual([]);
  });

  it('sends a chip message through the send funnel', async () => {
    const { result, sendMessage } = await mount({ context: ARTICLE_CONTEXT });
    const chip = result.current.starterChips[0];
    await act(() => result.current.handleChipPress(chip.message));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(chip.message);
  });
});

describe('topic-plan discard reply', () => {
  async function requestDiscardReply(statement = 'Follows chess') {
    await act(() => {
      const store = useFloatingChatStore.getState();
      store.addTopicPlanNote({ kind: 'discarded', statement, at: 1 });
      store.requestTopicPlanTurn();
    });
  }
  const expectedBody = (statement = 'Follows chess') =>
    buildTopicPlanTurnBody([{ kind: 'discarded', statement, at: 1 }], { compact: false });

  it('sends one hidden turn with the built body and marks the turn in flight', async () => {
    const { rerender, props, sendHiddenTurn, sendMessage, result } = await mount();
    await requestDiscardReply();
    expect(sendHiddenTurn).toHaveBeenCalledTimes(1);
    expect(sendHiddenTurn).toHaveBeenCalledWith(expectedBody());
    expect(sendMessage).not.toHaveBeenCalled();
    const store = useFloatingChatStore.getState();
    expect(store.topicPlanTurnInFlight).toBe(true);
    expect(store.topicPlanTurnRequest).toBeNull();
    expect(result.current.introMessage).toBeNull();
    await rerender({ ...props });
    await rerender({ ...props, messages: [] });
    expect(sendHiddenTurn).toHaveBeenCalledTimes(1);
  });

  it('waits while streaming and fires once the status returns to idle', async () => {
    const { rerender, props, sendHiddenTurn } = await mount({ status: 'streaming' });
    await requestDiscardReply();
    expect(sendHiddenTurn).not.toHaveBeenCalled();
    expect(useFloatingChatStore.getState().topicPlanTurnRequest).not.toBeNull();
    await rerender({ ...props, status: 'idle' });
    expect(sendHiddenTurn).toHaveBeenCalledTimes(1);
    expect(sendHiddenTurn).toHaveBeenCalledWith(expectedBody());
  });

  it('drops the reply but keeps the notes when the chat is blocked', async () => {
    const { sendHiddenTurn } = await mount({ isBlocked: true });
    await requestDiscardReply();
    expect(sendHiddenTurn).not.toHaveBeenCalled();
    const store = useFloatingChatStore.getState();
    expect(store.topicPlanTurnRequest).toBeNull();
    expect(store.topicPlanNotes).toHaveLength(1);
  });
});

describe('unmount', () => {
  it('resets the unresolved counts and clears the turn request', async () => {
    const { unmount } = await mount({ status: 'streaming' });
    await act(() => {
      const store = useFloatingChatStore.getState();
      store.setUnresolvedTopicPlanCount(2);
      store.setUnresolvedFactChoiceCount(1);
      store.requestTopicPlanTurn();
    });
    const before = useFloatingChatStore.getState();
    expect(before.unresolvedTopicPlanCount).toBe(2);
    expect(before.unresolvedFactChoiceCount).toBe(1);
    expect(before.topicPlanTurnRequest).not.toBeNull();
    await unmount();
    const after = useFloatingChatStore.getState();
    expect(after.unresolvedTopicPlanCount).toBe(0);
    expect(after.unresolvedFactChoiceCount).toBe(0);
    expect(after.topicPlanTurnRequest).toBeNull();
  });
});

describe('turn-failed sentence', () => {
  const rows = [
    { id: 'u1', role: 'user', content: 'hi' },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 't1', name: 'load_skill', input: { id: 'facts/residence' }, status: 'done' }],
    },
  ] as never;
  const boxOf = (items: { kind: string }[]) =>
    items.find((i) => i.kind === 'agent-steps') as { terminal: string | null } | undefined;

  it('a throw after tool rows were written shows the sentence', async () => {
    const { result } = await mount({ messages: rows, error: 'Cloud chat failed: boom' });
    expect(boxOf(result.current.items)?.terminal).toBe('turn-failed');
  });

  it('a Stop never sets error, so the box carries no sentence', async () => {
    const { result } = await mount({ messages: rows, error: null });
    expect(boxOf(result.current.items)?.terminal).toBeNull();
  });

  it('a throw with no tool rows adds no box', async () => {
    const { result } = await mount({
      messages: [
        { id: 'u1', role: 'user', content: 'hi' },
        { id: 'a1', role: 'assistant', content: '' },
      ],
      error: 'Cloud chat failed: boom',
    });
    expect(boxOf(result.current.items)).toBeUndefined();
  });
});

describe('typing item inputs', () => {
  const typing = (items: { kind: string }[]) =>
    items.find((i) => i.kind === 'typing') as
      | { kind: 'typing'; engine: string; showWords: boolean; ackShowing: boolean }
      | undefined;

  it('on-device processing marks the typing item local and shows words', async () => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    const { result } = await mount({
      status: 'streaming',
      messages: [
        { id: 'u0', role: 'user', content: 'first' },
        { id: 'a0', role: 'assistant', content: 'ok' },
        { id: 'u1', role: 'user', content: 'second' },
      ],
    });
    expect(typing(result.current.items)).toMatchObject({ engine: 'local', showWords: true });
  });

  it('cloud keeps words off from the second message on', async () => {
    const { result } = await mount({
      status: 'streaming',
      messages: [
        { id: 'u0', role: 'user', content: 'first' },
        { id: 'a0', role: 'assistant', content: 'ok' },
        { id: 'u1', role: 'user', content: 'second' },
      ],
    });
    expect(typing(result.current.items)).toMatchObject({ engine: 'cloud', showWords: false });
  });
});

describe('the failure banner while Retry is offered', () => {
  it('drops the banner text after the Retry tap and no longer offers it', async () => {
    const { result } = await mount({ error: 'boom' });
    expect(result.current.blockedMessage).toBe(t('chat.inferenceError'));
    await act(async () => result.current.onRetry?.());
    expect(result.current.blockedMessage).toBeNull();
    expect(result.current.onRetry).toBeUndefined();
  });

  it('never offers Retry for a blocked account', async () => {
    const { result } = await mount({ error: 'boom', isBlocked: true, blockedReason: 'nope' });
    expect(result.current.onRetry).toBeUndefined();
  });
});

describe('a turn the app leaving ended', () => {
  const failedTurn = { error: 'Cloud chat failed: x', messages: [{ id: 'u1', role: 'user' as const, content: 'Why this story?' }] };

  it('says so instead of blaming the service, and shares the one Retry', async () => {
    useCloudChatStore.setState({ interrupted: true });
    const { result } = await mount(failedTurn);
    expect(result.current.blockedMessage).toBe(t('chat.turnInterrupted'));
    expect(result.current.onRetry).toBeDefined();
  });

  it('a service failure keeps its own copy', async () => {
    const { result } = await mount(failedTurn);
    expect(result.current.blockedMessage).toBe(t('chat.inferenceError'));
  });

  it('a kill needs no error to offer Retry', async () => {
    useFloatingChatStore.setState({ interruptedTurn: { text: 'Why this story?', contextKind: 'persona' } });
    const { result } = await mount();
    expect(result.current.blockedMessage).toBe(t('chat.turnInterrupted'));
    expect(result.current.onRetry).toBeDefined();
  });

  it('a typed send answers the notice', async () => {
    useFloatingChatStore.setState({ interruptedTurn: { text: 'Why this story?', contextKind: 'persona' } });
    const { result } = await mount();
    await act(async () => result.current.handleSend('Something else'));
    expect(useFloatingChatStore.getState().interruptedTurn).toBeNull();
  });
});
