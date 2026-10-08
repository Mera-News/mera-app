// ChatThread — presentational chat surface. Renders a flat ChatThreadItem[] via
// the vendored chat-ai primitives, plus starter chips, a blocked banner, and the
// prompt input. Everything comes in via props (ChatThreadProps) — no data
// fetching, no stores.

import MeraStreamAvatar, { AVATAR_GUTTER_WIDTH } from '@/components/custom/chat/MeraStreamAvatar';
import ChatPhaseLine from '@/components/custom/chat/ChatPhaseLine';
import { WAIT_ROW_TEXT_HEIGHT } from '@/components/custom/chat/chat-phases';
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
import { themedStyles, tint, useColors } from '@/lib/theme/tokens';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import {
  useFloatingChatPendingDraft,
  useFloatingChatStore,
} from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import { GlyphSafeButton } from './glyph-safe';
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { PopoverPhaseContext } from './ChatPopover';
import AgentStepsBox from './AgentStepsBox';
import ArticleContextCard from './ArticleContextCard';
import AskChoiceCard from './AskChoiceCard';
import { notifyScrollTick } from '@/lib/visibility-tick';
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
import type { ChatThreadItem, ChatThreadProps, StarterChip } from './types';

// Short, snappy spring for freshly-arrived message bubbles. Applied ONLY to
// live-session items (keys prefixed `live-`); prepended history pages (`hist-`)
// must not replay this animation when they load in behind the current session.
const MESSAGE_ENTERING = FadeInDown.springify().damping(20).stiffness(220).mass(0.5);

const HISTORY_ITEM: ChatThreadItem = { kind: 'history-button', key: 'history-button' };

/** A fact card still waiting for the user's answer. */
function isPendingCard(item: ChatThreadItem): boolean {
  return item.kind === 'fact-choice-card' && !item.dismissed && !item.stale;
}

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
  usageNotice,
  composerHint = null,
  composerTrailing,
  composerPlaceholder,
}) => {
  const styles = useStyles();
  const { t } = useTranslation();
  const colors = useColors();

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

  // A starter or openMeraChat put text in the composer. Consumed here, once the
  // composer exists, so it lands in whichever conversation this mount shows.
  const pendingDraft = useFloatingChatPendingDraft();
  useEffect(() => {
    if (pendingDraft === null) return;
    const draft = useFloatingChatStore.getState().consumePendingDraft();
    if (draft) promptRef.current?.setText(draft);
  }, [pendingDraft]);

  // Starter chips show only when the thread has no real user/assistant messages
  // (the intro pseudo-message, id 'intro', does not count). PAGE starters
  // (draft chips) also show under a thread kept from another page, until the
  // first send of this open (navx amendment).
  const hasRealMessage = items.some(
    (item) => item.kind === 'message' && item.message.id !== 'intro',
  );
  const [sentThisOpen, setSentThisOpen] = useState(false);
  const draftChips = starterChips.some((c) => c.draft);
  const showChips =
    starterChips.length > 0 && (draftChips ? !sentThisOpen : !hasRealMessage);
  const handleChip = useCallback(
    (chip: StarterChip) => {
      if (!chip.draft) {
        onChipPress(chip.message);
        return;
      }
      promptRef.current?.setText(chip.message);
      promptRef.current?.focus();
    },
    [onChipPress],
  );

  // A TYPED REPLY WHILE A CARD WAITS leaves the card pending, and the card is
  // brought back into view so the reader sees it is still open (owner ruling
  // ux1, F7). Scrolled after the send lands, when the new bubble has pushed
  // the card up the list.
  const listRef = useRef<FlatList<ChatThreadItem>>(null);
  const displayItems = showHistoryButton ? [HISTORY_ITEM, ...items] : items;
  const revealPendingRef = useRef(false);
  const send = useCallback(
    (text: string) => {
      revealPendingRef.current = displayItems.some(isPendingCard);
      setSentThisOpen(true);
      onSend(text);
    },
    [displayItems, onSend],
  );
  useEffect(() => {
    if (!revealPendingRef.current) return;
    let at = -1;
    for (let i = displayItems.length - 1; i >= 0; i--) {
      if (isPendingCard(displayItems[i])) { at = i; break; }
    }
    if (at === -1) return;
    revealPendingRef.current = false;
    // Reversed data: the newest item is index 0.
    listRef.current?.scrollToIndex({
      index: displayItems.length - 1 - at,
      viewPosition: 0.5,
      animated: true,
    });
  }, [displayItems]);

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
                {/* A SPACER when the mark is not showing, so the bubble keeps
                    one left edge from the first token to the settled reply.
                    It used to shift left the moment streaming ended. */}
                {item.streaming === true ? (
                  <MeraStreamAvatar />
                ) : (
                  <View style={styles.avatarSpacer} testID="mera-avatar-spacer" />
                )}
                <MessageContent role="assistant">
                  {/* THE SLOT. While streaming the reply holds at least the
                      wait row's height, so it takes the row's place at the
                      first token without moving the thread (ux1 C2). */}
                  <View
                    testID="mera-reply-slot"
                    style={item.streaming === true ? styles.replySlotStreaming : undefined}
                  >
                    <MessageResponse>{message.content}</MessageResponse>
                  </View>
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
            saveAll={item.saveAll}
            answered={item.answered}
            // The thread's existing send, i.e. ChatSessionView.handleSend —
            // the one funnel every gate already sits on.
            onSend={onSend}
            // Never through onSend: the model must not see this tap (ux2 D9).
            // LAZY: the actions reach WatermelonDB, which must stay out of
            // every suite that renders the thread.
            onSaveAsWritten={
              item.saveAsWritten
                ? () => {
                    const { commitSaveAsWritten } =
                      require('./fact-choice-actions') as typeof import('./fact-choice-actions');
                    void commitSaveAsWritten(item.saveAsWritten!);
                  }
                : null
            }
          />
        );

      case 'fact-card':
        return <FactCard action={item.action} statements={item.statements} pendingDelete={item.pendingDelete} />;

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
        return (
          <ChatTopicsCard
            factId={item.factId}
            factStatement={item.factStatement}
            topicSkillId={item.topicSkillId}
          />
        );

      case 'conflict-card':
        return <ConflictResolutionCard conflict={item.conflict} />;

      case 'quick-fact-check-card':
        return <QuickFactCheckCard entry={item.entry} />;

      case 'history-button':
        return (
          <View style={styles.historyButtonRow}>
            {/* Childless button over a hidden visual: the history glyph inside
                a labelled button still surfaced as its own StaticText. */}
            <GlyphSafeButton
              visualStyle={styles.historyButton}
              onPress={() => {
                hapticLight();
                onRevealHistory();
              }}
              accessibilityLabel={t('floatingChat.viewPreviousMessages')}
              testID="chat-view-previous-messages"
            >
              <MaterialIcons {...DECORATIVE_ICON_A11Y} name="history" size={16} color={colors.ink2} />
              <Text size="xs" style={styles.historyButtonText}>
                {t('floatingChat.viewPreviousMessages')}
              </Text>
            </GlyphSafeButton>
          </View>
        );

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
      <View style={styles.listWrap}>
        <ConversationContent
          items={displayItems}
          listRef={listRef}
          // Visibility ticks: TranslatableDynamic translates only once it
          // measures itself on screen, and waits for a tick to re-measure.
          // Without these, cards below the fold never translated.
          onScroll={notifyScrollTick}
          scrollEventThrottle={16}
          onContentSizeChange={notifyScrollTick}
          renderItem={renderItem}
          onLoadOlder={onLoadOlder}
          hasOlder={hasOlder}
          isLoadingOlder={isLoadingOlder}
          header={
            showChips || !hasRealMessage ? (
              <View style={styles.header}>
                {!hasRealMessage && usageNotice && (
                  <View style={styles.noticeRow}>
                    <MaterialIcons {...DECORATIVE_ICON_A11Y} name="info-outline" size={14} color={colors.ink3} />
                    <Text size="xs" style={styles.noticeText}>
                      {usageNotice}
                    </Text>
                  </View>
                )}
                {showChips && (
                  <StarterChips chips={starterChips} onChipPress={handleChip} />
                )}
              </View>
            ) : null
          }
        />
      </View>

      {blockedMessage && (
        <View style={styles.blockedBanner}>
          <MaterialIcons {...DECORATIVE_ICON_A11Y} name="block" size={20} color={colors.negative} />
          <View style={styles.blockedBody}>
            <Text size="sm" style={styles.blockedText}>
              {blockedMessage}
            </Text>
            {showUnblockControls && (
              <View style={styles.unblockRow}>
                {unblockPending ? (
                  <>
                    <View style={styles.pendingPill}>
                      <MaterialIcons {...DECORATIVE_ICON_A11Y} name="hourglass-empty" size={14} color={colors.ink2} />
                      <Text size="xs" style={styles.pendingText}>
                        {t('floatingChat.requestUnblock.pendingButton')}
                      </Text>
                    </View>
                    <GlyphSafeButton
                      visualStyle={styles.refreshPill}
                      onPress={() => {
                        hapticLight();
                        onRefreshBlockStatus();
                      }}
                      disabled={isRefreshingBlockStatus}
                      accessibilityState={{ disabled: isRefreshingBlockStatus }}
                      accessibilityLabel={t('floatingChat.requestUnblock.refreshButton')}
                      testID="chat-unblock-refresh"
                    >
                      <MaterialIcons {...DECORATIVE_ICON_A11Y} name="refresh" size={14} color={colors.negative} />
                      <Text size="xs" style={styles.refreshText}>
                        {t('floatingChat.requestUnblock.refreshButton')}
                      </Text>
                    </GlyphSafeButton>
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

      {composerHint && !blockedMessage ? (
        <View style={styles.hintRow} testID="chat-composer-hint">
          <Text size="xs" style={styles.hintText} accessibilityLiveRegion="polite">
            {composerHint}
          </Text>
        </View>
      ) : null}

      <View style={composerTrailing ? styles.composerRow : undefined}>
        <View style={composerTrailing ? styles.composerFill : undefined}>
          <PromptInput
            ref={promptRef}
            onSubmit={send}
            placeholder={composerPlaceholder ?? t('floatingChat.inputPlaceholder')}
            // NOT `blockedMessage !== null`. A transport error sets that banner
            // too, and the error is only cleared by starting a turn, so gating
            // on the banner meant a failed turn disabled the composer for good,
            // with the banner telling the user to try again.
            disabled={isInputDisabled || bannerBlocksInput}
          />
        </View>
        {composerTrailing}
      </View>
    </Conversation>
  );
};

const useStyles = themedStyles((c) => StyleSheet.create({
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
  // 16pt sides like the rest of the panel; at 4 the notice ran into the
  // panel's rounded edge (audit F9).
  composerRow: { flexDirection: 'row', alignItems: 'center' },
  composerFill: { flex: 1 },
  replySlotStreaming: {
    minHeight: WAIT_ROW_TEXT_HEIGHT,
  },
  avatarSpacer: {
    width: AVATAR_GUTTER_WIDTH,
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
    borderColor: c.panelBorder,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: c.surface,
  },
  historyButtonText: {
    color: c.ink2,
  },
  userText: {
    color: c.ink,
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
    backgroundColor: c.surfaceRaised,
  },
  dividerLabel: {
    color: c.ink3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  // Neutral, not the red banner: nothing has gone wrong, a card is simply
  // waiting. rgb(185,185,185) on the panel measures ~9:1.
  hintRow: {
    marginHorizontal: 16,
    marginBottom: 6,
  },
  hintText: {
    color: c.ink2,
  },
  blockedBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: tint(c.negative, 0.12),
  },
  blockedBody: {
    flex: 1,
    gap: 10,
  },
  blockedText: {
    color: c.negative,
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
    backgroundColor: tint(c.negative, 0.18),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tint(c.negative, 0.5),
  },
  requestText: {
    color: c.negative,
    fontWeight: '600',
  },
  pendingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: c.surface,
  },
  pendingText: {
    color: c.ink2,
  },
  refreshPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tint(c.negative, 0.5),
  },
  refreshText: {
    color: c.negative,
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
    color: c.ink3,
    lineHeight: 16,
  },
}));

export default ChatThread;
