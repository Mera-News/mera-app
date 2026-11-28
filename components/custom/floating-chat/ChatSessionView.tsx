// ChatSessionView: the chat session's state (lib/chat-session, read through
// CloudPersonaChat / LocalPersonaChat) drawn by the presentational ChatThread.
// A view only: thread-item derivation, starter chips, intro message, haptics
// and lazy upward history. It may unmount mid-turn.

import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import type { PersistedMessage } from '@/lib/database/services/conversation-service';
import type { ConversationMessage } from '@/lib/llm/types';
import type { ChatContext } from '@/lib/stores/floating-chat-store';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import OnboardingPathCard from '@/components/custom/onboarding/OnboardingPathCard';
import type { SendOptions } from '@/lib/chat-session/engine';
import ChatThread from './ChatThread';
import RequestUnblockModal from './RequestUnblockModal';
import { themedStyles } from '@/lib/theme/tokens';
import { useChatSessionView } from './useChatSessionView';

const noop = () => {};

export interface ChatSessionViewProps {
  // The engine's state, from its store
  messages: ConversationMessage[];
  status: 'idle' | 'streaming';
  sendMessage: (text: string, opts?: SendOptions) => void;
  /** Starts a turn the user never sees. Used by the topic-plan discard reply. */
  sendHiddenTurn: (text: string) => void;
  isBlocked: boolean;
  blockedReason: string | null;
  error: string | null;
  /** Current chat context — drives the intro copy, starter chips, and auto-send. */
  context: ChatContext;
  /** Authenticated user id — needed for server-authoritative block/unblock flows. */
  userId: string;
  // Session plumbing
  conversationId: string | null;
  /**
   * Persisted messages of the CURRENT conversation, loaded on session mount so
   * the thread resumes after a popover close/reopen (oldest-first).
   */
  resumeMessages?: PersistedMessage[];
  isLoading: boolean;
  loadingMessage?: string;
  /** Drawn right of the composer on its row (onboarding's Next button).
   *  Absent: the composer has the row to itself. */
  composerTrailing?: React.ReactNode;
  /** The composer's placeholder. Absent: "Type a message...". */
  composerPlaceholder?: string;
}

export default function ChatSessionView(props: ChatSessionViewProps) {
  const { isLoading, loadingMessage, context, userId, conversationId, composerTrailing, composerPlaceholder } = props;
  const styles = useStyles();
  const {
    t,
    isStreaming,
    items,
    loadOlder,
    hasOlder,
    isLoadingOlder,
    historyRevealed,
    handleRevealHistory,
    starterChips,
    handleChipPress,
    blockedMessage,
    onRetry,
    bannerBlocksInput,
    effectiveBlocked,
    unblockPending,
    unblockModalOpen,
    setUnblockModalOpen,
    handleRefreshBlockStatus,
    isRefreshingBlockStatus,
    handleSend,
    composerHint,
    handleUnblockSubmitted,
    onboarding,
  } = useChatSessionView(props);

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
    <View style={styles.root}>
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
        composerActions={onboarding?.actions}
        renderOnboardingMenu={onboarding ? () => <OnboardingPathCard {...onboarding.menu} /> : undefined}
        onChipPress={handleChipPress}
        blockedMessage={blockedMessage}
        onRetry={onRetry}
        bannerBlocksInput={bannerBlocksInput}
        showUnblockControls={effectiveBlocked && !!userId}
        unblockPending={unblockPending}
        onRequestUnblock={() => setUnblockModalOpen(true)}
        onRefreshBlockStatus={handleRefreshBlockStatus}
        isRefreshingBlockStatus={isRefreshingBlockStatus}
        onSend={handleSend}
        isInputDisabled={isStreaming || effectiveBlocked}
        composerHint={composerHint}
        composerTrailing={composerTrailing}
        composerPlaceholder={
          onboarding?.placeholder ??
          composerPlaceholder ??
          (context.kind === 'follow-story' ? t('trackedStories.composerPlaceholder') : undefined)
        }
        usageNotice={
          context.kind === 'persona' ? undefined : t('floatingChat.aiUsageNoticeGeneral')
        }
      />
      {!!userId && conversationId && (
        <RequestUnblockModal
          isOpen={unblockModalOpen}
          onClose={() => setUnblockModalOpen(false)}
          conversationId={conversationId}
          userId={userId}
          onSubmitted={handleUnblockSubmitted}
        />
      )}
    </View>
  );
}

const useStyles = themedStyles((c) =>
  StyleSheet.create({
    root: { flex: 1 },
    loadingContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      padding: 24,
    },
    loadingText: {
      color: c.ink2,
      textAlign: 'center',
    },
  }),
);
