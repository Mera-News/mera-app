// ChatSessionView — bridges an inference hook result (useLocalLLM /
// useCloudPersonaChat) to the presentational ChatThread. Owns the glue only:
// thread-item derivation, starter chips, intro message, haptics, the
// isGenerating store flag, persistence, and lazy upward history.

import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useChatHistory } from '@/lib/hooks/useChatHistory';
import { useChatPersistence } from '@/lib/hooks/useChatPersistence';
import type { PersistedMessage } from '@/lib/database/services/conversation-service';
import { hapticMedium, hapticSuccess } from '@/lib/haptics';
import type { ConversationMessage } from '@/lib/llm/types';
import { useFloatingChatStore, type ChatContext } from '@/lib/stores/floating-chat-store';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import ChatThread from './ChatThread';
import { deriveThreadItems } from './deriveThreadItems';
import type { StarterChip } from './types';

const noop = () => {};

export interface ChatSessionViewProps {
  // Inference hook result (shared shape of useLocalLLM / useCloudPersonaChat)
  messages: ConversationMessage[];
  status: 'idle' | 'streaming';
  sendMessage: (text: string) => void;
  isBlocked: boolean;
  blockedReason: string | null;
  error: string | null;
  /** Current chat context — drives the intro copy, starter chips, and auto-send. */
  context: ChatContext;
  // Session plumbing
  conversationId: string | null;
  /**
   * Persisted messages of the CURRENT conversation, loaded on session mount so
   * the thread resumes after a popover close/reopen (oldest-first).
   */
  resumeMessages?: PersistedMessage[];
  isLoading: boolean;
  loadingMessage?: string;
}

export default function ChatSessionView({
  messages,
  status,
  sendMessage,
  isBlocked,
  blockedReason,
  error,
  context,
  conversationId,
  resumeMessages,
  isLoading,
  loadingMessage,
}: ChatSessionViewProps) {
  const { t } = useTranslation();
  const isStreaming = status === 'streaming';
  const resume = useMemo(() => resumeMessages ?? [], [resumeMessages]);

  // Intro copy depends on the context: the article-feedback surfaces open with a
  // "what can I do for you" line (article vs. suggestion variant); everything
  // else keeps the persona intro.
  const introText =
    context.kind === 'article-suggestion'
      ? t(context.suggestionId ? 'articleFeedback.intro' : 'articleFeedback.introArticle')
      : t('personaChat.introMessage');

  // Intro pseudo-message until the first send of this session.
  const [introMessage, setIntroMessage] = useState<string | null>(introText);

  // Seed persistence with the resumed ids so retained cloud-store messages
  // aren't re-persisted on reopen. Stable across renders for the same session.
  const seedIds = useMemo(() => resume.map((m) => m.id), [resume]);

  // Persist the live session; lazily page in older history on scroll-up.
  useChatPersistence(messages, status, conversationId, seedIds);
  const { history, loadOlder, hasOlder, isLoadingOlder } = useChatHistory(
    conversationId ?? undefined,
  );

  const items = useMemo(
    () =>
      deriveThreadItems({
        live: messages,
        history,
        introMessage,
        isStreaming,
        earlierConversationLabel: t('floatingChat.earlierConversation'),
        resume,
      }),
    [messages, history, introMessage, isStreaming, t, resume],
  );

  // Mirror generation state into the floating-chat store (bubble shimmer etc).
  // Store writes must never happen inline during render.
  useEffect(() => {
    useFloatingChatStore.getState().setGenerating(isStreaming);
    return () => {
      useFloatingChatStore.getState().setGenerating(false);
    };
  }, [isStreaming]);

  // Success haptic when a new fact card lands in the LIVE session. History
  // cards are excluded so paging in old conversations doesn't buzz.
  const liveFactCardCount = useMemo(
    () =>
      items.filter((item) => item.kind === 'fact-card' && item.key.startsWith('card-')).length,
    [items],
  );
  const prevFactCardCountRef = useRef(0);
  useEffect(() => {
    if (liveFactCardCount > prevFactCardCountRef.current) {
      void hapticSuccess();
    }
    prevFactCardCountRef.current = liveFactCardCount;
  }, [liveFactCardCount]);

  const starterChips: StarterChip[] = useMemo(() => {
    if (context.kind === 'article-suggestion') {
      // A real suggestion can be explained ("why?"); a plain article can't, so
      // it offers "more like this" instead. Both offer the "don't want" chip.
      const firstChip: StarterChip = context.suggestionId
        ? {
            key: 'why',
            label: t('articleFeedback.chipWhy'),
            message: t('articleFeedback.chipWhyMessage'),
          }
        : {
            key: 'more-like-this',
            label: t('articleFeedback.chipMoreLikeThis'),
            message: t('articleFeedback.chipMoreLikeThisMessage'),
          };
      return [
        firstChip,
        {
          key: 'dont-want',
          label: t('articleFeedback.chipDontWant'),
          message: t('articleFeedback.chipDontWantMessage'),
        },
      ];
    }
    return [
      {
        key: 'add-location',
        label: t('floatingChat.chipAddLocation'),
        message: t('floatingChat.chipAddLocationMessage'),
      },
      {
        key: 'show-facts',
        label: t('floatingChat.chipShowFacts'),
        message: t('floatingChat.chipShowFactsMessage'),
      },
      {
        key: 'help-setup',
        label: t('floatingChat.chipHelpSetup'),
        message: t('floatingChat.chipHelpSetupMessage'),
      },
    ];
  }, [t, context]);

  const handleSend = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming || isBlocked) return;
      void hapticMedium();
      setIntroMessage(null);
      sendMessage(trimmed);
    },
    [isStreaming, isBlocked, sendMessage],
  );

  // Chips send their canned message through the same path (haptic included).
  const handleChipPress = useCallback(
    (message: string) => {
      handleSend(message);
    },
    [handleSend],
  );

  // Auto-send the pending initial message once per session (thumbs tap on an
  // article detail screen seeds it). The atomic consume + ref guard ensures it
  // fires exactly once even across re-renders; a fresh nonce remounts this view
  // for each new thumbs tap, resetting the ref. Bubble-tap opens set no pending
  // message, so this is a no-op there (intro + chips show instead).
  const autoSentRef = useRef(false);
  useEffect(() => {
    if (isLoading || isStreaming || autoSentRef.current) return;
    const pending = useFloatingChatStore.getState().consumePendingInitialMessage();
    if (pending) {
      autoSentRef.current = true;
      handleSend(pending);
    }
  }, [isLoading, isStreaming, handleSend]);

  // "View previous messages" gate: history stays hidden until the user reveals
  // it, at which point the normal scroll-up paging resumes.
  const [historyRevealed, setHistoryRevealed] = useState(false);
  const handleRevealHistory = useCallback(() => {
    setHistoryRevealed(true);
    loadOlder();
  }, [loadOlder]);

  // Surface inference errors directly — there's no recovery action the user
  // can take in-app (ported from PersonaChatUI).
  const blockedMessage = isBlocked
    ? blockedReason
    : error
      ? `${t('chat.inferenceError')} (${error})`
      : null;

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Spinner size="large" />
        <Text size="sm" style={styles.loadingText}>
          {loadingMessage ?? t('chat.startingChat')}
        </Text>
      </View>
    );
  }

  return (
    <ChatThread
      items={items}
      isStreaming={isStreaming}
      // Scroll-up paging is wired only after the history reveal; before that the
      // pill button is the single entry point (hasOlder=false disables the
      // FlatList's onEndReached auto-load).
      onLoadOlder={historyRevealed ? loadOlder : noop}
      hasOlder={historyRevealed ? hasOlder : false}
      isLoadingOlder={isLoadingOlder}
      showHistoryButton={hasOlder && !historyRevealed}
      onRevealHistory={handleRevealHistory}
      starterChips={starterChips}
      onChipPress={handleChipPress}
      blockedMessage={blockedMessage}
      onSend={handleSend}
      isInputDisabled={isStreaming || isBlocked}
    />
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  loadingText: {
    color: 'rgb(160, 160, 160)',
    textAlign: 'center',
  },
});
