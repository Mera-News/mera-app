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
import i18n from '@/lib/i18n';
import { initI18nEn } from '@/test/helpers';

const USER_ID = 'user-1';
const PERSONA_CONTEXT: ChatContext = { kind: 'persona' };
const ARTICLE_CONTEXT: ChatContext = {
  kind: 'article-suggestion',
  articleId: 'a1',
  suggestionId: 's1',
};

const t = (key: string): string => i18n.t(key);

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

function mount(over: Partial<ChatSessionViewProps> = {}) {
  const made = makeProps(over);
  const hook = renderHook((p: ChatSessionViewProps) => useChatSessionView(p), {
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
  it('trims the text and sends it once', () => {
    const { result, sendMessage } = mount();
    act(() => result.current.handleSend('  hi  '));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('hi');
  });

  it.each(['', '   ', '\n\t'])('sends nothing for %j', (text) => {
    const { result, sendMessage } = mount();
    act(() => result.current.handleSend(text));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('is a no-op while streaming', () => {
    const { result, sendMessage } = mount({ status: 'streaming' });
    act(() => result.current.handleSend('hi'));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('is a no-op while isBlocked, and the banner shows the account-restricted copy', () => {
    const { result, sendMessage } = mount({ isBlocked: true });
    act(() => result.current.handleSend('hi'));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.effectiveBlocked).toBe(true);
    expect(result.current.blockedMessage).toBe(t('errors.accountRestricted'));
  });

  it('is a no-op for a persisted blocked persona, and the banner shows its reason', async () => {
    seedBlockedPersona('x');
    const { result, sendMessage } = mount();
    await waitFor(() => expect(result.current.effectiveBlocked).toBe(true));
    act(() => result.current.handleSend('hi'));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.blockedMessage).toBe('x');
  });

  it('falls back to the account-restricted copy when the persisted block has no reason', async () => {
    seedBlockedPersona(null);
    const { result } = mount();
    await waitFor(() => expect(result.current.effectiveBlocked).toBe(true));
    expect(result.current.blockedMessage).toBe(t('errors.accountRestricted'));
  });

  it('prefers the prop reason over the persisted one', async () => {
    seedBlockedPersona('persisted');
    const { result } = mount({ isBlocked: true, blockedReason: 'from the server' });
    await waitFor(() => expect(result.current.effectiveBlocked).toBe(true));
    expect(result.current.blockedMessage).toBe('from the server');
  });
});

describe('pending initial message', () => {
  it('is sent exactly once across re-renders', () => {
    useFloatingChatStore.getState().openArticleFeedback(ARTICLE_CONTEXT, 'seed');
    const { result, rerender, props, sendMessage } = mount({ context: ARTICLE_CONTEXT });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('seed');
    rerender({ ...props });
    rerender({ ...props, messages: [] });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(useFloatingChatStore.getState().pendingInitialMessage).toBeNull();
    expect(result.current.introMessage).toBeNull();
  });

  it('is not consumed while loading, and goes out once loading ends', () => {
    useFloatingChatStore.getState().openArticleFeedback(ARTICLE_CONTEXT, 'seed');
    const { rerender, props, sendMessage } = mount({ context: ARTICLE_CONTEXT, isLoading: true });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(useFloatingChatStore.getState().pendingInitialMessage).toBe('seed');
    rerender({ ...props, isLoading: false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('seed');
  });

  it('is not consumed while streaming, and goes out once the stream ends', () => {
    useFloatingChatStore.getState().openArticleFeedback(ARTICLE_CONTEXT, 'seed');
    const { rerender, props, sendMessage } = mount({
      context: ARTICLE_CONTEXT,
      status: 'streaming',
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(useFloatingChatStore.getState().pendingInitialMessage).toBe('seed');
    rerender({ ...props, status: 'idle' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('error banner', () => {
  it('shows the generic inference copy and never the raw error string', () => {
    const raw = 'E2EE chat failed: 400 Provider failed for model X: Decryption failed';
    const { result } = mount({ error: raw });
    expect(result.current.blockedMessage).toBe(t('chat.inferenceError'));
    expect(result.current.blockedMessage).not.toContain('Decryption');
    expect(result.current.blockedMessage).not.toContain('E2EE chat failed');
  });
});

describe('intro message', () => {
  it('shows the persona intro until the first send, then null', () => {
    const { result, sendMessage } = mount();
    expect(result.current.introMessage).toBe(t('personaChat.introMessage'));
    act(() => result.current.handleSend('hello'));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(result.current.introMessage).toBeNull();
  });

  it('picks articleFeedback.intro for a suggestion', () => {
    const { result } = mount({ context: ARTICLE_CONTEXT });
    expect(result.current.introMessage).toBe(t('articleFeedback.intro'));
  });

  it('picks articleFeedback.introArticle for a plain article', () => {
    const { result } = mount({ context: { kind: 'article-suggestion', articleId: 'a1' } });
    expect(result.current.introMessage).toBe(t('articleFeedback.introArticle'));
  });
});

describe('starter chips', () => {
  const keys = (chips: { key: string }[]) => chips.map((c) => c.key);

  it('offers why, quick fact check and dont-want for a suggestion in cloud mode', () => {
    const { result } = mount({ context: ARTICLE_CONTEXT });
    expect(keys(result.current.starterChips)).toEqual(['why', 'quick-fact-check', 'dont-want']);
  });

  it('offers more-like-this instead of why for a plain article', () => {
    const { result } = mount({ context: { kind: 'article-suggestion', articleId: 'a1' } });
    expect(keys(result.current.starterChips)).toEqual([
      'more-like-this',
      'quick-fact-check',
      'dont-want',
    ]);
  });

  it('drops the quick fact check chip in on-device mode', () => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    const { result } = mount({ context: ARTICLE_CONTEXT });
    expect(keys(result.current.starterChips)).toEqual(['why', 'dont-want']);
  });

  it('offers no chips in an optimisation-plan thread', () => {
    const { result } = mount({ context: { kind: 'optimisation-plan' } });
    expect(result.current.starterChips).toEqual([]);
  });

  it('sends a chip message through the send funnel', () => {
    const { result, sendMessage } = mount({ context: ARTICLE_CONTEXT });
    const chip = result.current.starterChips[0];
    act(() => result.current.handleChipPress(chip.message));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(chip.message);
  });
});

describe('topic-plan discard reply', () => {
  function requestDiscardReply(statement = 'Follows chess') {
    act(() => {
      const store = useFloatingChatStore.getState();
      store.addTopicPlanNote({ kind: 'discarded', statement, at: 1 });
      store.requestTopicPlanTurn();
    });
  }
  const expectedBody = (statement = 'Follows chess') =>
    buildTopicPlanTurnBody([{ kind: 'discarded', statement, at: 1 }], { compact: false });

  it('sends one hidden turn with the built body and marks the turn in flight', () => {
    const { rerender, props, sendHiddenTurn, sendMessage, result } = mount();
    requestDiscardReply();
    expect(sendHiddenTurn).toHaveBeenCalledTimes(1);
    expect(sendHiddenTurn).toHaveBeenCalledWith(expectedBody());
    expect(sendMessage).not.toHaveBeenCalled();
    const store = useFloatingChatStore.getState();
    expect(store.topicPlanTurnInFlight).toBe(true);
    expect(store.topicPlanTurnRequest).toBeNull();
    expect(result.current.introMessage).toBeNull();
    rerender({ ...props });
    rerender({ ...props, messages: [] });
    expect(sendHiddenTurn).toHaveBeenCalledTimes(1);
  });

  it('waits while streaming and fires once the status returns to idle', () => {
    const { rerender, props, sendHiddenTurn } = mount({ status: 'streaming' });
    requestDiscardReply();
    expect(sendHiddenTurn).not.toHaveBeenCalled();
    expect(useFloatingChatStore.getState().topicPlanTurnRequest).not.toBeNull();
    rerender({ ...props, status: 'idle' });
    expect(sendHiddenTurn).toHaveBeenCalledTimes(1);
    expect(sendHiddenTurn).toHaveBeenCalledWith(expectedBody());
  });

  it('drops the reply but keeps the notes when the chat is blocked', () => {
    const { sendHiddenTurn } = mount({ isBlocked: true });
    requestDiscardReply();
    expect(sendHiddenTurn).not.toHaveBeenCalled();
    const store = useFloatingChatStore.getState();
    expect(store.topicPlanTurnRequest).toBeNull();
    expect(store.topicPlanNotes).toHaveLength(1);
  });
});

describe('unmount', () => {
  it('resets the unresolved counts and clears the turn request', () => {
    const { unmount } = mount({ status: 'streaming' });
    act(() => {
      const store = useFloatingChatStore.getState();
      store.setUnresolvedTopicPlanCount(2);
      store.setUnresolvedFactChoiceCount(1);
      store.requestTopicPlanTurn();
    });
    const before = useFloatingChatStore.getState();
    expect(before.unresolvedTopicPlanCount).toBe(2);
    expect(before.unresolvedFactChoiceCount).toBe(1);
    expect(before.topicPlanTurnRequest).not.toBeNull();
    unmount();
    const after = useFloatingChatStore.getState();
    expect(after.unresolvedTopicPlanCount).toBe(0);
    expect(after.unresolvedFactChoiceCount).toBe(0);
    expect(after.topicPlanTurnRequest).toBeNull();
  });
});
