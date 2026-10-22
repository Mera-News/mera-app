// ChatThread — presentational chat surface. Renders a flat ChatThreadItem[] via
// the vendored chat-ai primitives, plus starter chips, a blocked banner, and the
// prompt input. Everything comes in via props (ChatThreadProps) — no data
// fetching, no stores.

import { StreamingBubble, StreamingReplyContext } from '@/components/custom/chat/ReplyHandover';
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
import { themedStyles, tint, useColors, useThemeMode } from '@/lib/theme/tokens';
import { GLASS_EDGE, GlassPlate } from '@/components/custom/GlassSurface';
import { stopChatTurn } from '@/lib/chat-session/chat-session';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import {
  useFloatingChatPendingDraft,
  useFloatingChatStore,
} from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import { GlyphSafeButton } from './glyph-safe';
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { PopoverPhaseContext } from './ChatPopover';
import AgentStepsBox from './AgentStepsBox';
import ArticleContextCard from './ArticleContextCard';
import AskChoiceCard from './AskChoiceCard';
import { notifyScrollTick } from '@/lib/visibility-tick';
import FactCard from './FactCard';
import OptimisationPlanCard from './OptimisationPlanCard';
import ProposalCard, { AppliedByTypingCard } from './ProposalCard';
import QuickFactCheckCard from './QuickFactCheckCard';
import FactChoiceCard from './FactChoiceCard';
import FactChoiceBulkRow from './FactChoiceBulkRow';
import ChatTopicsCard from './ChatTopicsCard';
import TopicPlanCard from './TopicPlanCard';
import TopicPlanSaveAllRow from './TopicPlanSaveAllRow';
import ConflictResolutionCard from './ConflictResolutionCard';
import StarterChips from './StarterChips';
import { emptyThreadIntro, hasRealMessage } from './deriveThreadItems';
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
  const themeMode = useThemeMode();
  // The session's whole-turn busy mirror (not `status`): Send is Stop until it clears.
  const turnBusy = useFloatingChatStore((st) => st.isGenerating);

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
  // (the greeting pseudo-message does not count; the intro is no message). PAGE starters
  // (draft chips) also show under a thread kept from another page, until the
  // first send of this open (navx amendment).
  const realMessage = hasRealMessage(items);
  const introText = emptyThreadIntro(items);
  const [sentThisOpen, setSentThisOpen] = useState(false);
  const draftChips = starterChips.some((c) => c.draft);
  const showChips =
    starterChips.length > 0 && (draftChips ? !sentThisOpen : !realMessage);
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

  // What Mera and the reader can do here. A centred card of plain text, so
  // VoiceOver reads it as text, never as a message from Mera.
  // Glass (owner, 2026-10-22): one static surface, so real Liquid Glass on iOS 26 is affordable here
  // (GlassSurface's chrome rule). The shadow sits on the outer frame: RN drops a shadow off a view
  // that clips itself, and the glass needs a clipping parent to round it.
  const renderIntro = (text: string) => (
    <View style={styles.introFill}>
      <View style={styles.introCard}>
        <View className={GLASS_EDGE} style={styles.introGlass}>
          <GlassPlate tint={themeMode === 'light' ? tint(colors.panel, 0.55) : undefined} />
          <Text size="sm" style={styles.introText} testID="chat-intro">
            {text}
          </Text>
        </View>
      </View>
    </View>
  );

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

      case 'intro':
        // Inline only beside revealed history; the empty thread draws it above (introText).
        return renderIntro(item.text);

      case 'message': {
        const { message } = item;
        const streamingInfo =
          item.streaming === true
            ? {
                id: message.id,
                showWords: item.showWords ?? false,
                engine: item.engine ?? 'cloud',
                handover: item.handover ?? false,
              }
            : null;
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
              {/* No avatar gutter: the header carries the one Mera mark, and a
                  reserved gutter indented every reply ~34pt from the thread's
                  left edge (the steps box, cards and input start there). The
                  bubble takes the user side's 88% max width, mirrored. */}
              {message.content.trim().length > 0 ? (
              // THE SLOT. A reply that takes the wait row's place holds the
              // row's height and plays the first-words handover
              // (ReplyHandover). The bubble is ALWAYS `StreamingBubble`: a
              // container that changed type when the stream ended remounted
              // the bubble, which flashed and re-landed it.
              <StreamingReplyContext.Provider value={streamingInfo}>
              {/* A ROW, as the avatar gutter's row was: the bubble is a flex item
                  of a definite-width row (flexShrink 1, so its 88% maxWidth
                  holds) instead of a shrink-wrapped child of a column. Without
                  it a long reply's last paragraph kept a stale text layout and
                  was clipped at the bubble's right edge. */}
              <View style={styles.replyRow}>
              <MessageContent role="assistant" as={StreamingBubble}>
                <View testID="mera-reply-slot">
                  <MessageResponse>{message.content}</MessageResponse>
                </View>
              </MessageContent>
              </View>
              </StreamingReplyContext.Provider>
              ) : null}
              {message.stopped ? (
                <Text size="xs" style={styles.stoppedLine} testID="chat-stopped">
                  {t('chat.stopped')}
                </Text>
              ) : null}
            </Message>
          );
        // Only animate in live-session bubbles; history pages load without
        // replay. A reply taking the wait row's slot does not spring in: the
        // handover is its entrance. The wrapper itself never comes or goes
        // with `handover` (it clears when the stream ends): a wrapper that
        // appeared then remounted the finished reply with the spring.
        return item.key.startsWith('live-') ? (
          <Animated.View entering={item.handover ? undefined : MESSAGE_ENTERING}>{inner}</Animated.View>
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
            answered={item.answered}
          />
        );

      case 'ask-choice-card':
        return (
          <AskChoiceCard
            question={item.question}
            options={item.options}
            saveAll={item.saveAll}
            answered={item.answered}
            // Focuses the composer and sends nothing: the user types their own reading.
            onSomethingElse={item.somethingElse ? () => promptRef.current?.focus() : null}
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

      case 'applied-by-typing':
        return <AppliedByTypingCard changeLogIds={item.changeLogIds} undoable={item.undoable} />;

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
            {/* The borderless wait row: the encryption strip, and the phase
                words on a conversation's first message, on device, or after
                a retry. Not a bubble: the acknowledgement, then the reply, is
                the turn's one bubble. */}
            <WaitBubble showWords={item.showWords} ackShowing={item.ackShowing} engine={item.engine} />
          </Message>
        );

      default:
        return null;
    }
  };

  const header =
    showChips || !realMessage ? (
      <View style={styles.header}>
        {!realMessage && usageNotice && (
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
    ) : null;

  return (
    <Conversation>
      <View style={styles.listWrap}>
        {introText !== null ? (
          // The empty thread is a plain column, not the inverted list: tree
          // order is screen order, so a screen reader reads the intro before
          // the greeting and chips, and an intro too tall for the panel opens
          // at its first line. The intro takes the free space ABOVE the other
          // rows, so the pinned card stays put when the first send swaps in
          // the list.
          <ScrollView
            contentContainerStyle={styles.emptyContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            onScroll={notifyScrollTick}
            scrollEventThrottle={16}
            onContentSizeChange={notifyScrollTick}
          >
            {renderIntro(introText)}
            {displayItems.map((item) =>
              item.kind === 'intro' ? null : <React.Fragment key={item.key}>{renderItem(item)}</React.Fragment>,
            )}
            {header}
          </ScrollView>
        ) : (
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
            header={header}
          />
        )}
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
            // While a turn runs (the whole turn, not only text arriving) Send
            // becomes Stop.
            busy={turnBusy}
            onStop={stopChatTurn}
          />
        </View>
        {composerTrailing}
      </View>
    </Conversation>
  );
};

const useStyles = themedStyles((c, mode) => StyleSheet.create({
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
  replyRow: {
    flexDirection: 'row',
    flexShrink: 1,
  },
  // ConversationContent's listContent, grown to the panel so the intro has free space to take.
  emptyContent: {
    flexGrow: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  // Takes the empty thread's free space and centres the text there.
  introFill: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 16,
  },
  // The bubble's surface and soft float (chat-ai bubble), card-shaped: centred,
  // no avatar, no side.
  introCard: {
    maxWidth: 360,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: mode === 'light' ? 0.18 : 0.4,
    shadowRadius: 10,
  },
  introGlass: {
    borderRadius: 20,
    overflow: 'hidden',
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  introText: {
    color: c.ink2,
    textAlign: 'center',
    // 1.1x the chat type scale (userText, the replies: 15/21).
    fontSize: 16.5,
    lineHeight: 23,
  },
  stoppedLine: {
    color: c.ink3,
    marginTop: 4,
    marginHorizontal: 4,
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
