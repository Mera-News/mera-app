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
import { retryTopicGeneration } from '@/lib/chat-tools/tool-handlers';
import { getFacts } from '@/lib/database/services/fact-service';
import {
  deleteTopicWithDecline,
  undoPendingDelete,
  UNDO_WINDOW_MS,
} from '@/lib/database/services/topic-decline-service';
import { observeByFact } from '@/lib/database/services/topic-service';
import type TopicModel from '@/lib/database/models/Topic';
import { hapticLight } from '@/lib/haptics';
import { useFloatingChatFactMutationVersion } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, { withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)';

/**
 * How many topics the MERGED card shows across all its facts.
 *
 * A group ceiling, not a per-fact one: "Add all" over four facts would otherwise
 * stack twenty-odd chips into a chat bubble nobody reads. Filled ROUND-ROBIN so
 * every accepted fact is represented before any fact gets a second chip — taking
 * the first N in fact order would silently give the whole budget to fact one.
 *
 * Display only. Every generated topic is saved and active regardless; this
 * bounds what the card draws, never what the feed uses.
 */
export const MERGED_TOPIC_CEILING = 6;

/**
 * How long a card waits for topics before it stops saying "finding" and offers
 * a retry.
 *
 * Generation is a cloud batch inside a live chat turn; the hedge plus the
 * model's own tail can legitimately take tens of seconds. This is well past
 * that, because the cost of being early (a retry button over a request that was
 * about to succeed) is worse than the cost of being late.
 */
const GENERATING_TIMEOUT_MS = 60_000;

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
  facts: { factId: string; factStatement: string }[];
  merged: boolean;
}

/** Round-robin across facts, preserving each fact's own ranked order. */
export function interleaveByFact(rows: Chip[], factOrder: string[], ceiling: number): Chip[] {
  const byFact = new Map<string, Chip[]>();
  for (const id of factOrder) byFact.set(id, []);
  for (const row of rows) byFact.get(row.factId)?.push(row);

  const out: Chip[] = [];
  let depth = 0;
  let added = true;
  while (out.length < ceiling && added) {
    added = false;
    for (const id of factOrder) {
      const bucket = byFact.get(id);
      const row = bucket?.[depth];
      if (!row) continue;
      out.push(row);
      added = true;
      if (out.length >= ceiling) break;
    }
    depth += 1;
  }
  return out;
}

const ChatTopicsCard: React.FC<ChatTopicsCardProps> = ({ facts, merged }) => {
  const { t } = useTranslation();
  const factIds = useMemo(() => facts.map((f) => f.factId), [facts]);
  const factIdKey = factIds.join(',');

  const [rows, setRows] = useState<Chip[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Chips staged for deletion, still shown so the Undo is reachable. The
   *  index is remembered so the chip stays in its own footprint. */
  const [pendingDelete, setPendingDelete] = useState<
    { chip: Chip; index: number }[]
  >([]);
  const undoTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [genError, setGenError] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  // One live subscription per fact; rows are merged into a single list keyed by
  // fact so the round-robin below can see each fact's own order.
  useEffect(() => {
    const perFact = new Map<string, Chip[]>();
    const subs = factIds.map((factId) =>
      observeByFact(factId).subscribe((models: TopicModel[]) => {
        perFact.set(
          factId,
          // ACTIVE only. A staged delete leaves the observable at once and is
          // re-inserted from `pendingDelete` below; `retired` is no longer a
          // state this card can produce.
          models
            .filter((m) => m.status === 'active')
            .map((m) => ({ id: m.id, text: m.text, factId })),
        );
        setRows(factIds.flatMap((id) => perFact.get(id) ?? []));
      }),
    );
    return () => subs.forEach((s) => s.unsubscribe());
  }, [factIdKey, factIds]);

  // Only the DISPLAY timers. Dropping them on unmount cannot lose a delete:
  // the service holds the staged row on disk and commits it regardless.
  useEffect(() => {
    const timers = undoTimers.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // `topicGenError` is the same metadata marker TopicPlanCard and FactAccordion
  // read. Without it an empty card spins forever on a failed generation, because
  // "no rows yet" and "no rows ever" look identical.
  const factMutationVersion = useFloatingChatFactMutationVersion();
  useEffect(() => {
    let cancelled = false;
    getFacts()
      .then((all) => {
        if (cancelled) return;
        setGenError(
          factIds.some(
            (id) => (all.find((f) => f.id === id)?.metadata?.topicGenError?.length ?? 0) > 0,
          ),
        );
      })
      .catch(() => {
        /* keep the last known state */
      });
    return () => {
      cancelled = true;
    };
  }, [factIdKey, factIds, factMutationVersion]);

  // A generation that neither lands nor records an error would otherwise leave
  // the card spinning for the life of the thread.
  useEffect(() => {
    if (rows.length > 0) return;
    const timer = setTimeout(() => setTimedOut(true), GENERATING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [rows.length, isRetrying]);

  const live = useMemo(
    () => (merged ? interleaveByFact(rows, factIds, MERGED_TOPIC_CEILING) : rows),
    [rows, factIds, merged],
  );

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
        `${t('chatTopics.removed' as 'topicPlan.undo')}. ${t('topicPlan.undo')}`,
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

  const handleRetry = async () => {
    if (isRetrying) return;
    setIsRetrying(true);
    setGenError(false);
    setTimedOut(false);
    void hapticLight();
    try {
      // Sequential: each call writes metadata and bumps the shared mutation
      // counter, and tool-handlers drops a retry for a fact already in flight.
      for (const fact of facts) await retryTopicGeneration(fact.factId, fact.factStatement);
    } finally {
      setIsRetrying(false);
    }
  };

  const empty = visible.length === 0;
  const showEmptyTerminal = empty && (genError || timedOut) && !isRetrying;
  const showGenerating = empty && !showEmptyTerminal;

  return (
    <Animated.View entering={cardEntering} style={styles.card} testID="chat-topics-card">
      <View style={styles.headerRow}>
        <MaterialIcons name="account-tree" size={18} color={ACCENT} />
        <Text size="sm" bold style={styles.title}>
          {t('topicPlan.title')}
        </Text>
      </View>

      {showGenerating ? (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={ACCENT} />
          <Text size="xs" style={styles.statusText}>
            {t('topicPlan.generating')}
          </Text>
        </View>
      ) : showEmptyTerminal ? (
        <View style={styles.statusRow} testID="chat-topics-empty">
          <Text size="xs" style={styles.statusText}>
            {t('chatTopics.none')}
          </Text>
          <Pressable
            onPress={handleRetry}
            disabled={isRetrying}
            hitSlop={12}
            style={styles.retryButton}
            accessibilityRole="button"
            accessibilityLabel={t('floatingChat.topicGenRetry')}
            testID="chat-topics-retry"
          >
            <Text size="xs" bold style={styles.retryText}>
              {t('floatingChat.topicGenRetry')}
            </Text>
          </Pressable>
        </View>
      ) : (
        facts.map((fact) => {
          const chips = visible.filter((c) => c.factId === fact.factId);
          if (chips.length === 0) return null;
          return (
            <View key={fact.factId} style={styles.section}>
              {/* Only the MERGED card names its facts: a single-fact card sits
                  directly under that fact's own Saved card, so repeating the
                  statement would say the same thing twice in a row. */}
              {merged && (
                <TranslatableDynamic
                  text={fact.factStatement}
                  size="xs"
                  italic
                  style={styles.factLine}
                  numberOfLines={2}
                />
              )}
              <View style={styles.chips}>
                {chips.map((chip) => {
                  const removing = isPendingDelete(chip.id);
                  return (
                  <View
                    key={chip.id}
                    style={[styles.chip, removing && styles.chipRemoving]}
                  >
                    {/* Topic texts are the RETRIEVAL keys — English, sent to the
                        server as-is. Only the RENDERING is translated; remove and
                        undo act on `chip.id` and the text is never written back. */}
                    {/* The removed chip KEEPS its text, dimmed and struck. A
                        blank "Removed" slot makes the user guess what they
                        just deleted, at the one moment they may want it back. */}
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
                      onPress={() =>
                        removing ? handleUndoRemove(chip) : handleRemove(chip)
                      }
                      disabled={busyId === chip.id}
                      hitSlop={16}
                      style={styles.chipButton}
                      accessibilityRole="button"
                      accessibilityLabel={
                        removing ? t('topicPlan.undo') : t('topicPlan.delete')
                      }
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
            </View>
          );
        })
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
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: ACCENT },
  factLine: { color: 'rgb(190, 190, 190)' },
  section: { gap: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  statusText: { flex: 1, color: 'rgb(200, 200, 200)' },
  retryButton: {
    minHeight: 44,
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
