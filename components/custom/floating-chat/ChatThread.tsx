// ChatThread — presentational chat surface. Renders a flat ChatThreadItem[] via
// the vendored chat-ai primitives, plus starter chips, a blocked banner, and the
// prompt input. Everything comes in via props (ChatThreadProps) — no data
// fetching, no stores.

import AiDisclosureCaption from '@/components/custom/AiDisclosureCaption';
import MeraStreamAvatar from '@/components/custom/chat/MeraStreamAvatar';
import ChatPhaseLine from '@/components/custom/chat/ChatPhaseLine';
import WaitBubble from '@/components/custom/chat/WaitBubble';
import { Text } from '@/components/ui/text';
import {
  Conversation,
  ConversationContent,
  Message,
  MessageContent,
  MessageResponse,
  PromptInput,
  type PromptInputHandle,
} from '@/components/ui/chat-ai';
import { hapticLight } from '@/lib/haptics';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useContext, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { PopoverPhaseContext } from './ChatPopover';
import AgentStepsBox from './AgentStepsBox';
import ArticleContextCard from './ArticleContextCard';
import AskChoiceCard from './AskChoiceCard';
import FactCard from './FactCard';
import OptimisationPlanCard from './OptimisationPlanCard';
import ProposalCard from './ProposalCard';
import QuickFactCheckCard from './QuickFactCheckCard';
import FactChoiceCard from './FactChoiceCard';
import FactChoiceBulkRow from './FactChoiceBulkRow';
import ChatTopicsCard from './ChatTopicsCard';
import TopicPlanCard from './TopicPlanCard';
import TopicPlanSaveAllRow from './TopicPlanSaveAllRow';
import ConflictResolutionCard from './ConflictResolutionCard';
import StarterChips from './StarterChips';
import type { ChatThreadItem, ChatThreadProps } from './types';

// Short, snappy spring for freshly-arrived message bubbles. Applied ONLY to
// live-session items (keys prefixed `live-`); prepended history pages (`hist-`)
// must not replay this animation when they load in behind the current session.
const MESSAGE_ENTERING = FadeInDown.springify().damping(20).stiffness(220).mass(0.5);

const ChatThread: React.FC<ChatThreadProps> = ({
  items,
  isStreaming: _isStreaming,
  onLoadOlder,
  hasOlder,
  isLoadingOlder,
  showHistoryButton,
  onRevealHistory,
  starterChips,
  onChipPress,
  blockedMessage,
  bannerBlocksInput,
  showUnblockControls,
  unblockPending,
  onRequestUnblock,
  onRefreshBlockStatus,
  isRefreshingBlockStatus,
  onSend,
  isInputDisabled,
}) => {
  const { t } = useTranslation();

  // Autofocus the input once the popover's open morph fully settles. Focusing
  // mid-morph fights the scale transform and janks the keyboard slide-up, so we
  // wait for phase 'open'. If the session finishes loading after the morph, this
  // ChatThread mounts with phase already 'open' and the effect still fires.
  const phase = useContext(PopoverPhaseContext);
  const promptRef = useRef<PromptInputHandle>(null);
  useEffect(() => {
    if (phase === 'open') {
      promptRef.current?.focus();
    }
  }, [phase]);

  // Starter chips show only when the thread has no real user/assistant messages
  // (the intro pseudo-message, id 'intro', does not count).
  const hasRealMessage = items.some(
    (item) => item.kind === 'message' && item.message.id !== 'intro',
  );
  const showChips = !hasRealMessage && starterChips.length > 0;

  // Every topic-plan card in the thread — TopicPlanSaveAllRow filters these
  // against the settled map itself, keeping this component store-free.
  const topicPlanFactIds = items
    .filter((item): item is Extract<ChatThreadItem, { kind: 'topic-plan-card' }> =>
      item.kind === 'topic-plan-card',
    )
    .map((item) => item.factId);

  // The newest proposal card is the only one that can be pending; older ones
  // render expired. ProposalCard combines this with the store to decide status.
  let lastProposalKey: string | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'proposal-card') {
      lastProposalKey = items[i].key;
      break;
    }
  }

  const renderItem = (item: ChatThreadItem): React.ReactElement | null => {
    switch (item.kind) {
      case 'article-context-card':
        return (
          <ArticleContextCard
            title={item.title}
            articleId={item.articleId}
            suggestionId={item.suggestionId}
          />
        );

      case 'message': {
        const { message } = item;
        const inner =
          message.role === 'user' ? (
            <Message role="user">
              <MessageContent role="user">
                <Text size="sm" style={styles.userText}>
                  {message.content}
                </Text>
              </MessageContent>
            </Message>
          ) : (
            <Message role="assistant">
              {/* BESIDE the bubble, not above it. `Message` is a plain column,
                  so an avatar dropped in as a sibling stacks on top; the row
                  is what makes the gutter `AVATAR_SIZE` was always documented
                  to be. Bottom-aligned, Messenger style. It stays for the LIVE
                  message while it streams, so the mark does not blink out the
                  instant the first token lands and back in on the next turn. */}
              <View style={styles.gutterRow}>
                {item.streaming === true && <MeraStreamAvatar />}
                <MessageContent role="assistant">
                  <MessageResponse>{message.content}</MessageResponse>
                </MessageContent>
              </View>
            </Message>
          );
        // Only animate in live-session bubbles; history pages load without replay.
        return item.key.startsWith('live-') ? (
          <Animated.View entering={MESSAGE_ENTERING}>{inner}</Animated.View>
        ) : (
          inner
        );
      }

      case 'agent-steps':
        return (
          <AgentStepsBox
            steps={item.steps}
            collapsed={item.collapsed}
            doneCount={item.doneCount}
            failedCount={item.failedCount}
            terminal={item.terminal}
            interrupted={item.interrupted}
          />
        );

      case 'ask-choice-card':
        return (
          <AskChoiceCard
            question={item.question}
            options={item.options}
            answered={item.answered}
            // The thread's existing send, i.e. ChatSessionView.handleSend —
            // the one funnel every gate already sits on.
            onSend={onSend}
          />
        );

      case 'fact-card':
        return <FactCard action={item.action} statements={item.statements} />;

      case 'optimisation-plan-card':
        return <OptimisationPlanCard />;

      case 'proposal-card':
        return <ProposalCard proposal={item.proposal} isLast={item.key === lastProposalKey} />;

      case 'topic-plan-card':
        return <TopicPlanCard factId={item.factId} factStatement={item.factStatement} />;

      case 'fact-choice-card':
        return (
          <FactChoiceCard
            resultKey={item.resultKey}
            baseResult={item.baseResult}
            groupIndex={item.groupIndex}
            groupId={item.groupId}
            options={item.options}
            questionnaireAttribute={item.questionnaireAttribute}
            dismissed={item.dismissed}
            stale={item.stale}
            replacesFactId={item.replacesFactId}
            topicSkillId={item.topicSkillId}
          />
        );

      case 'fact-choice-bulk-row':
        return (
          <FactChoiceBulkRow
            resultKey={item.resultKey}
            baseResult={item.baseResult}
            groups={item.groups}
          />
        );

      case 'chat-topics-card':
        return <ChatTopicsCard factId={item.factId} factStatement={item.factStatement} />;

      case 'conflict-card':
        return <ConflictResolutionCard conflict={item.conflict} />;

      case 'quick-fact-check-card':
        return <QuickFactCheckCard entry={item.entry} />;

      case 'divider':
        return (
          <View style={styles.dividerRow}>
            <View style={styles.hairline} />
            <Text size="xs" style={styles.dividerLabel}>
              {item.label}
            </Text>
            <View style={styles.hairline} />
          </View>
        );

      case 'typing':
        return (
          <Message role="assistant">
            {/* Messenger-style gutter. The mark is present for the whole wait
                and for the streaming bubble that follows, then goes when the
                turn settles. */}
            <View style={styles.gutterRow}>
              <MeraStreamAvatar />
              {/* Outlined, unfilled and breathing, so a provisional bubble
                  never reads as something that was said. */}
              <WaitBubble>
                {/* A sentence that tracks the real phase, not a rotating word.
                    The word was decorative and said the same thing whether the
                    device was queued behind prewarm, fetching an attestation
                    key or waiting out the model's 3-8s time to first token, so
                    a long wait read as a frozen screen. The line subscribes to
                    the phase store itself, so a phase tick re-renders one
                    Text rather than this whole thread. */}
                <ChatPhaseLine />
              </WaitBubble>
            </View>
          </Message>
        );

      default:
        return null;
    }
  };

  return (
    <Conversation>
      {/* EU AI Act Art. 50(1) interaction notice (Group C1) — fixed chrome,
          NOT list content. `ConversationContent`'s `header` prop is an
          inverted FlatList's `ListHeaderComponent`, which is list content: it
          scrolls away once the user scrolls up, and once real messages exist
          it renders between the newest bubble and the prompt input rather
          than at the top of the surface. A "persistent" disclosure has to
          survive scrolling and sit at a fixed spot, so it lives here instead
          — a sibling rendered once above the list for every chat entry point
          (floating bubble → ChatSessionView, persona chat → CloudPersonaChat
          / LocalPersonaChat, onboarding step 1 → PersonaUpdateChatStep →
          CloudPersonaChat — all of which mount this ChatThread). */}
      <View style={styles.aiInteractionRow}>
        <AiDisclosureCaption text={t('floatingChat.aiInteractionNotice')} />
      </View>
      <View style={styles.listWrap}>
        <ConversationContent
          items={items}
          renderItem={renderItem}
          onLoadOlder={onLoadOlder}
          hasOlder={hasOlder}
          isLoadingOlder={isLoadingOlder}
          header={
            showHistoryButton || showChips || !hasRealMessage ? (
              <View style={styles.header}>
                {showHistoryButton && (
                  <View style={styles.historyButtonRow}>
                    <Pressable
                      style={styles.historyButton}
                      onPress={() => {
                        hapticLight();
                        onRevealHistory();
                      }}
                    >
                      <MaterialIcons name="history" size={16} color="rgb(160, 160, 160)" />
                      <Text size="xs" style={styles.historyButtonText}>
                        {t('floatingChat.viewPreviousMessages')}
                      </Text>
                    </Pressable>
                  </View>
                )}
                {!hasRealMessage && (
                  <View style={styles.noticeRow}>
                    <MaterialIcons name="info-outline" size={14} color="rgb(140, 140, 140)" />
                    <Text size="xs" style={styles.noticeText}>
                      {t('floatingChat.aiUsageNotice')}
                    </Text>
                  </View>
                )}
                {showChips && (
                  <StarterChips chips={starterChips} onChipPress={onChipPress} />
                )}
              </View>
            ) : null
          }
        />
      </View>

      {blockedMessage && (
        <View style={styles.blockedBanner}>
          <MaterialIcons name="block" size={20} color="#F87171" />
          <View style={styles.blockedBody}>
            <Text size="sm" style={styles.blockedText}>
              {blockedMessage}
            </Text>
            {showUnblockControls && (
              <View style={styles.unblockRow}>
                {unblockPending ? (
                  <>
                    <View style={styles.pendingPill}>
                      <MaterialIcons name="hourglass-empty" size={14} color="rgb(180, 180, 180)" />
                      <Text size="xs" style={styles.pendingText}>
                        {t('floatingChat.requestUnblock.pendingButton')}
                      </Text>
                    </View>
                    <Pressable
                      style={styles.refreshPill}
                      onPress={() => {
                        hapticLight();
                        onRefreshBlockStatus();
                      }}
                      disabled={isRefreshingBlockStatus}
                    >
                      <MaterialIcons name="refresh" size={14} color="#F87171" />
                      <Text size="xs" style={styles.refreshText}>
                        {t('floatingChat.requestUnblock.refreshButton')}
                      </Text>
                    </Pressable>
                  </>
                ) : (
                  <Pressable
                    style={styles.requestPill}
                    onPress={() => {
                      hapticLight();
                      onRequestUnblock();
                    }}
                  >
                    <Text size="xs" style={styles.requestText}>
                      {t('floatingChat.requestUnblock.button')}
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        </View>
      )}

      <TopicPlanSaveAllRow factIds={topicPlanFactIds} />

      <PromptInput
        ref={promptRef}
        onSubmit={onSend}
        placeholder={t('floatingChat.inputPlaceholder')}
        // NOT `blockedMessage !== null`. A transport error sets that banner
        // too, and the error is only cleared by starting a turn — so gating on
        // the banner meant a failed turn disabled the composer permanently,
        // with the banner telling the user to try again.
        disabled={isInputDisabled || bannerBlocksInput}
      />
    </Conversation>
  );
};

const styles = StyleSheet.create({
  // Avatar gutter. `Message` aligns its children but does not lay them out in
  // a row, so without this the mark sits ABOVE the bubble rather than beside
  // it — which is what shipped, despite both call sites saying "beside".
  // `flex-end` puts the mark at the bubble's bottom edge; `flexShrink` lets
  // the bubble keep its own maxWidth instead of overflowing the row.
  gutterRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    flexShrink: 1,
  },
  listWrap: {
    flex: 1,
  },
  header: {
    gap: 4,
  },
  aiInteractionRow: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  historyButtonRow: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  historyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  historyButtonText: {
    color: 'rgb(160, 160, 160)',
  },
  userText: {
    color: 'rgb(210, 210, 210)',
    // Match the assistant markdown / input type scale for a uniform chat UI.
    fontSize: 15,
    lineHeight: 21,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  hairline: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
  dividerLabel: {
    color: 'rgb(120, 120, 120)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  blockedBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
  },
  blockedBody: {
    flex: 1,
    gap: 10,
  },
  blockedText: {
    color: '#F87171',
  },
  unblockRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  requestPill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: 'rgba(248, 113, 113, 0.18)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(248, 113, 113, 0.5)',
  },
  requestText: {
    color: '#F87171',
    fontWeight: '600',
  },
  pendingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  pendingText: {
    color: 'rgb(180, 180, 180)',
  },
  refreshPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(248, 113, 113, 0.5)',
  },
  refreshText: {
    color: '#F87171',
  },
  noticeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  noticeText: {
    flex: 1,
    color: 'rgb(140, 140, 140)',
    lineHeight: 16,
  },
});

export default ChatThread;
