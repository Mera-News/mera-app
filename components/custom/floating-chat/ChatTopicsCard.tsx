// ChatTopicsCard — topics for facts accepted IN CHAT, shown as removable chips.
//
// Distinct from TopicPlanCard on purpose, and the difference is the flow, not
// the styling. Topic generation ALREADY mints the `topics` rows before either
// card can render, so TopicPlanCard's "Save" was never the thing that saved
// them: it stamped a review marker and, until it was tapped, BLOCKED the chat
// input. This card drops both. The topics are saved when they appear, the chips
// are how you remove one, and the composer is never gated on it.
//
// That gate removal is load-bearing, not a simplification: the composer must
// never be blocked on an item the user cannot act on, and this card spends most
// of its life in a state ("finding topics", or a failed generation) where there
// is nothing to act on at all.
//
// Removal is a REAL DELETE with a short undo, not a retire. The chip X stages
// the delete through topic-decline-service, which owns the window, the commit
// and the decline row; this card owns only what is on screen. Two consequences
// that are easy to get wrong:
//
//   - the row leaves `observeByFact` IMMEDIATELY on stage, so a card rendering
//     straight off the observable would lose the chip the instant it is tapped
//     and take the Undo with it. The chip is held in `pendingDelete` and
//     re-inserted AT ITS OWN INDEX, so nothing reflows under the reader.
//   - this card never owns the commit timer and never hardcodes the window.
//     `UNDO_WINDOW_MS` is imported; the local timer only decides how long the
//     Undo affordance is offered, and if it never fires the service still
//     commits on its own clock, on app start and on foreground.

import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Text } from '@/components/ui/text';
import StatusIndicator from '@/components/custom/chat/StatusIndicator';
import { retryTopicGeneration } from '@/lib/chat-tools/tool-handlers';
import { observeTopicsStatus } from '@/lib/database/services/fact-service';
import {
  deleteTopicWithDecline,
  undoPendingDelete,
  UNDO_WINDOW_MS,
} from '@/lib/database/services/topic-decline-service';
import { generateMoreTopicsForFact } from '@/lib/database/services/topic-planning-service';
import { observeByFact } from '@/lib/database/services/topic-service';
import type TopicModel from '@/lib/database/models/Topic';
import { hapticLight } from '@/lib/haptics';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, { withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)';

/**
 * How long a still-PENDING generation runs before the card offers a way out.
 *
 * This is NOT the old 60s timeout, which decided the card's state: it flipped a
 * running generation to a terminal-looking one, which is exactly why "no rows
 * yet" and "no rows ever" were indistinguishable. This decides nothing. The
 * status stays `pending`, the spinner keeps spinning, and the only change is
 * that a Try again appears beside it. Do not fold it back into a state machine.
 */
export const OFFER_RETRY_AFTER_MS = 75_000;

function cardEntering() {
  'worklet';
  const duration = 280;
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 12 }, { scale: 0.97 }] },
    animations: {
      opacity: withTiming(1, { duration }),
      transform: [
        { translateY: withTiming(0, { duration }) },
        { scale: withTiming(1, { duration }) },
      ],
    },
  };
}

interface Chip {
  id: string;
  text: string;
  factId: string;
}

export interface ChatTopicsCardProps {
  factId: string;
  factStatement: string;
}

const ChatTopicsCard: React.FC<ChatTopicsCardProps> = ({ factId, factStatement }) => {
  const { t } = useTranslation();

  const [rows, setRows] = useState<Chip[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Chips staged for deletion, still shown so the Undo is reachable. The
   *  index is remembered so the chip stays in its own footprint. */
  const [pendingDelete, setPendingDelete] = useState<
    { chip: Chip; index: number }[]
  >([]);
  const undoTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [status, setStatus] = useState<'pending' | 'done' | 'error' | 'gone'>('pending');
  const [offerRetry, setOfferRetry] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isFindingMore, setIsFindingMore] = useState(false);

  // One live subscription per fact; rows are merged into a single list keyed by
  // fact so the round-robin below can see each fact's own order.
  useEffect(() => {
    // ACTIVE only. A staged delete leaves the observable at once and is
    // re-inserted from `pendingDelete` below; `retired` is no longer a state
    // this card can produce.
    const sub = observeByFact(factId).subscribe((models: TopicModel[]) => {
      setRows(
        models
          .filter((m) => m.status === 'active')
          .map((m) => ({ id: m.id, text: m.text, factId })),
      );
    });
    return () => sub.unsubscribe();
  }, [factId]);

  // Only the DISPLAY timers. Dropping them on unmount cannot lose a delete:
  // the service holds the staged row on disk and commits it regardless.
  useEffect(() => {
    const timers = undoTimers.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // Generation status, OBSERVED. This replaces a one-shot getFacts() keyed on
  // a mutation nonce — a poll, not an observation: a generation that finished
  // without bumping the counter never reached the card.
  useEffect(() => {
    const sub = observeTopicsStatus(factId).subscribe((next) => setStatus(next));
    return () => sub.unsubscribe();
  }, [factId]);

  // An escape hatch, not a state change: see OFFER_RETRY_AFTER_MS.
  useEffect(() => {
    if (status !== 'pending') {
      setOfferRetry(false);
      return;
    }
    const timer = setTimeout(() => setOfferRetry(true), OFFER_RETRY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [status, isRetrying]);

  const live = rows;

  /** Live chips plus the staged-for-deletion ones, each back at its own index
   *  so removing a chip does not reflow the ones around it. */
  const visible = useMemo(() => {
    if (pendingDelete.length === 0) return live;
    const out = [...live];
    // Ascending, so each insertion lands before the next index is used.
    for (const { chip, index } of [...pendingDelete].sort((a, b) => a.index - b.index)) {
      if (out.some((c) => c.id === chip.id)) continue;
      out.splice(Math.min(index, out.length), 0, chip);
    }
    return out;
  }, [live, pendingDelete]);

  // `handleRemove` needs the index a chip occupied at the moment it was
  // tapped, and reading it from a ref keeps that handler out of the memo's
  // dependency list.
  const visibleRef = useRef<Chip[]>([]);
  visibleRef.current = visible;

  const isPendingDelete = useCallback(
    (id: string) => pendingDelete.some((p) => p.chip.id === id),
    [pendingDelete],
  );

  /** Stop offering Undo for one chip. Display only — the service commits on
   *  its own clock whether or not this ever runs. */
  const dropPending = useCallback((topicId: string) => {
    const timer = undoTimers.current.get(topicId);
    if (timer) clearTimeout(timer);
    undoTimers.current.delete(topicId);
    setPendingDelete((prev) => prev.filter((p) => p.chip.id !== topicId));
  }, []);

  const handleRemove = async (chip: Chip) => {
    if (busyId) return;
    setBusyId(chip.id);
    void hapticLight();
    try {
      // A screen-reader user needs longer than 5s to hear the change, find the
      // Undo and act on it. The service clamps whatever it is given, and the
      // SAME value drives the display timer below so the affordance never
      // outlives the window the service is actually honouring.
      const screenReader = await AccessibilityInfo.isScreenReaderEnabled().catch(() => false);
      const undoWindowMs = screenReader ? 15_000 : UNDO_WINDOW_MS;

      const index = Math.max(
        0,
        visibleRef.current.findIndex((c) => c.id === chip.id),
      );
      await deleteTopicWithDecline(chip.id, { undoWindowMs });
      setPendingDelete((prev) => [...prev, { chip, index }]);
      AccessibilityInfo.announceForAccessibility(
        `${t('chatTopics.removed')}. ${t('topicPlan.undo')}`,
      );

      const timer = setTimeout(() => dropPending(chip.id), undoWindowMs);
      undoTimers.current.set(chip.id, timer);
    } finally {
      setBusyId(null);
    }
  };

  const handleUndoRemove = async (chip: Chip) => {
    if (busyId) return;
    setBusyId(chip.id);
    void hapticLight();
    try {
      // The boolean is informational: false means the window had already
      // closed. Either way the chip stops showing its undo state and
      // `observeByFact` is the authority on whether the row came back — so a
      // lost race can never resurrect a chip whose row is really gone.
      await undoPendingDelete(chip.id);
    } finally {
      dropPending(chip.id);
      setBusyId(null);
    }
  };

  const handleFindMore = async () => {
    if (isFindingMore) return;
    setIsFindingMore(true);
    void hapticLight();
    try {
      await generateMoreTopicsForFact(factId, factStatement);
    } finally {
      setIsFindingMore(false);
    }
  };

  const handleRetry = async () => {
    if (isRetrying) return;
    setIsRetrying(true);
    setOfferRetry(false);
    void hapticLight();
    try {
      await retryTopicGeneration(factId, factStatement);
    } finally {
      setIsRetrying(false);
    }
  };

  const empty = visible.length === 0;
  const showRetry = status === 'error' || (status === 'pending' && offerRetry);

  // A fact that has been deleted takes its topics with it. A one-line
  // tombstone, never a card that silently disappears mid-scroll: an
  // unexplained gap is harder to read than a plain sentence.
  if (status === 'gone') {
    return (
      <Animated.View entering={cardEntering} style={styles.tombstone} testID="chat-topics-gone">
        <Text size="xs" style={styles.statusText}>
          {t('chatTopics.goneTombstone')}
        </Text>
      </Animated.View>
    );
  }

  return (
    <Animated.View entering={cardEntering} style={styles.card} testID="chat-topics-card">
      <Pressable
        onPress={() => {
          void hapticLight();
          setExpanded((v) => !v);
        }}
        style={styles.header}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={expanded ? t('chatTopics.collapseA11y') : t('chatTopics.expandA11y')}
        testID={`chat-topics-header-${factId}`}
      >
        <View style={styles.headerRow}>
          <MaterialIcons
            name={expanded ? 'expand-more' : 'chevron-right'}
            size={18}
            color={ACCENT}
          />
          <Text size="sm" bold style={styles.title}>
            {t('chatTopics.accordionTitle')}
          </Text>

          {/* Status is read out in WORDS as well as drawn, so the spinner and
              the tick are never the only signal. */}
          <StatusIndicator
            status={status === 'error' ? 'error' : status === 'pending' ? 'pending' : 'done'}
            testID={`chat-topics-status-${factId}`}
          />

          {showRetry && (
            <Pressable
              onPress={handleRetry}
              disabled={isRetrying}
              hitSlop={16}
              style={styles.retryButton}
              accessibilityRole="button"
              accessibilityLabel={t('floatingChat.topicGenRetry')}
              testID="chat-topics-retry"
            >
              <Text size="xs" bold style={styles.retryText}>
                {t('floatingChat.topicGenRetry')}
              </Text>
            </Pressable>
          )}
        </View>

        {/* The fact statement is its own node rather than an interpolation:
            it goes through TranslatableDynamic, which returns a component. */}
        <TranslatableDynamic
          text={factStatement}
          size="xs"
          italic
          style={styles.factLine}
          numberOfLines={2}
        />

        {/* A failure is stated while COLLAPSED too. A problem you have to open
            a drawer to discover is one nobody sees. */}
        {status === 'error' && (
          <Text size="xs" style={styles.statusText} numberOfLines={2}>
            {t('floatingChat.topicGenFailed')}
          </Text>
        )}
      </Pressable>

      {expanded && (
        <View style={styles.body}>
          {empty ? (
            <Text size="xs" style={styles.statusText} testID="chat-topics-empty">
              {status === 'pending' ? t('chatTopics.finding') : t('chatTopics.none')}
            </Text>
          ) : (
            <View style={styles.chips}>
              {visible.map((chip) => {
                const removing = isPendingDelete(chip.id);
                return (
                  <View key={chip.id} style={[styles.chip, removing && styles.chipRemoving]}>
                    {/* The removed chip KEEPS its text, dimmed and struck. A
                        blank "Removed" slot makes the user guess what they
                        just deleted, at the one moment they may want it back.
                        Topic texts are the RETRIEVAL keys: only the rendering
                        is translated, and the text is never written back. */}
                    <TranslatableDynamic
                      text={chip.text}
                      size="xs"
                      style={{
                        ...styles.chipText,
                        ...(removing ? styles.chipTextRemoving : {}),
                      }}
                      numberOfLines={1}
                    />
                    <Pressable
                      onPress={() => (removing ? handleUndoRemove(chip) : handleRemove(chip))}
                      disabled={busyId === chip.id}
                      hitSlop={16}
                      style={styles.chipButton}
                      accessibilityRole="button"
                      accessibilityLabel={removing ? t('topicPlan.undo') : t('topicPlan.delete')}
                      testID={`chat-topic-chip-${removing ? 'undo' : 'remove'}-${chip.id}`}
                    >
                      <MaterialIcons
                        name={removing ? 'undo' : 'close'}
                        size={14}
                        color={removing ? ACCENT : 'rgb(190, 190, 190)'}
                      />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}

          <Pressable
            onPress={handleFindMore}
            disabled={isFindingMore}
            hitSlop={12}
            style={styles.moreButton}
            accessibilityRole="button"
            accessibilityState={{ disabled: isFindingMore }}
            accessibilityLabel={t('chatTopics.findMore')}
            testID={`chat-topics-more-${factId}`}
          >
            <Text size="xs" bold style={styles.retryText}>
              {isFindingMore ? t('chatTopics.findingMore') : t('chatTopics.findMore')}
            </Text>
          </Pressable>
        </View>
      )}
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(231, 138, 83, 0.08)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ACCENT,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  // 48dp target on the header row.
  header: { minHeight: 48, justifyContent: 'center', gap: 4 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  body: { gap: 10, paddingTop: 2 },
  tombstone: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  moreButton: {
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ACCENT,
    paddingHorizontal: 14,
  },
  title: { color: ACCENT },
  factLine: { color: 'rgb(190, 190, 190)' },
  section: { gap: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  statusText: { flex: 1, color: 'rgb(200, 200, 200)' },
  retryButton: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ACCENT,
  },
  retryText: { color: ACCENT },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 10,
    paddingRight: 4,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(231, 138, 83, 0.45)',
    backgroundColor: 'rgba(231, 138, 83, 0.10)',
    maxWidth: '100%',
  },
  chipRemoving: { opacity: 0.6, borderStyle: 'dashed' },
  chipText: { color: 'rgb(220, 220, 220)', flexShrink: 1 },
  chipTextRemoving: { textDecorationLine: 'line-through' },
  // 16pt hitSlop around a 26pt box clears the 48dp target on both platforms.
  chipButton: { padding: 6, minWidth: 26, minHeight: 26, alignItems: 'center', justifyContent: 'center' },
});

export default ChatTopicsCard;
