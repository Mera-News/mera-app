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
// Removal routes through the SAME audited seam TopicPlanCard uses —
// applyPersonaAction({ action_type: 'retire_topic' }) then revertChange for the
// undo — so bulk and single behaviour cannot drift and the change log stays
// honest.

import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Text } from '@/components/ui/text';
import { retryTopicGeneration } from '@/lib/chat-tools/tool-handlers';
import { applyPersonaAction } from '@/lib/database/services/persona-action-executor';
import { getFacts } from '@/lib/database/services/fact-service';
import { revertChange } from '@/lib/database/services/persona-change-log-service';
import { observeByFact, reactivate } from '@/lib/database/services/topic-service';
import type TopicModel from '@/lib/database/models/Topic';
import { hapticLight } from '@/lib/haptics';
import { useFloatingChatFactMutationVersion } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, { withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)';

/** New copy landing with this unit's locale fragment; cast removed after the
 *  splice, which is what makes the key's existence a compile-time check. */
type PendingLocaleKey = 'topicPlan.title';

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
  retired: boolean;
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
  const [genError, setGenError] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  // topicId -> change-log id of its retire, so Undo reverts the exact row.
  const retireLogIds = useRef<Map<string, string>>(new Map());

  // One live subscription per fact; rows are merged into a single list keyed by
  // fact so the round-robin below can see each fact's own order.
  useEffect(() => {
    const perFact = new Map<string, Chip[]>();
    const subs = factIds.map((factId) =>
      observeByFact(factId).subscribe((models: TopicModel[]) => {
        perFact.set(
          factId,
          models
            .filter((m) => m.status === 'active' || m.status === 'retired')
            .map((m) => ({
              id: m.id,
              text: m.text,
              factId,
              retired: m.status === 'retired',
            })),
        );
        setRows(factIds.flatMap((id) => perFact.get(id) ?? []));
      }),
    );
    return () => subs.forEach((s) => s.unsubscribe());
  }, [factIdKey, factIds]);

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

  const visible = useMemo(
    () => (merged ? interleaveByFact(rows, factIds, MERGED_TOPIC_CEILING) : rows),
    [rows, factIds, merged],
  );

  const handleRemove = async (chip: Chip) => {
    if (busyId) return;
    setBusyId(chip.id);
    void hapticLight();
    try {
      const res = await applyPersonaAction(
        { action_type: 'retire_topic', topicId: chip.id },
        'user',
      );
      if (res.changeLogId) retireLogIds.current.set(chip.id, res.changeLogId);
    } finally {
      setBusyId(null);
    }
  };

  const handleUndoRemove = async (chip: Chip) => {
    if (busyId) return;
    setBusyId(chip.id);
    try {
      const logId = retireLogIds.current.get(chip.id);
      if (logId) {
        await revertChange(logId);
        retireLogIds.current.delete(chip.id);
      } else {
        // No logged retire to invert (a reopened thread) — reactivate directly.
        await reactivate(chip.id);
      }
    } finally {
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
            {t('chatTopics.none' as PendingLocaleKey, {
              defaultValue: 'Saved. No topics to add right now.',
            })}
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
                {chips.map((chip) => (
                  <View
                    key={chip.id}
                    style={[styles.chip, chip.retired && styles.chipRetired]}
                  >
                    {/* Topic texts are the RETRIEVAL keys — English, sent to the
                        server as-is. Only the RENDERING is translated; remove and
                        undo act on `chip.id` and the text is never written back. */}
                    <TranslatableDynamic
                      text={chip.text}
                      size="xs"
                      style={{
                        ...styles.chipText,
                        ...(chip.retired ? styles.chipTextRetired : {}),
                      }}
                      numberOfLines={1}
                    />
                    <Pressable
                      onPress={() =>
                        chip.retired ? handleUndoRemove(chip) : handleRemove(chip)
                      }
                      disabled={busyId === chip.id}
                      hitSlop={12}
                      style={styles.chipButton}
                      accessibilityRole="button"
                      accessibilityLabel={
                        chip.retired ? t('topicPlan.undo') : t('topicPlan.delete')
                      }
                      testID={`chat-topic-chip-${chip.retired ? 'undo' : 'remove'}-${chip.id}`}
                    >
                      <MaterialIcons
                        name={chip.retired ? 'undo' : 'close'}
                        size={14}
                        color={chip.retired ? ACCENT : 'rgb(190, 190, 190)'}
                      />
                    </Pressable>
                  </View>
                ))}
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
  chipRetired: { opacity: 0.6, borderStyle: 'dashed' },
  chipText: { color: 'rgb(220, 220, 220)', flexShrink: 1 },
  chipTextRetired: { textDecorationLine: 'line-through' },
  chipButton: { padding: 6 },
});

export default ChatTopicsCard;
