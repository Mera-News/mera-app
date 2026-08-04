// TopicPlanCard — the in-chat topic-planning widget (Wave 11 U-B2). Appears
// after a fact-save and lets the user curate the topics Mera will track for that
// fact. Rows arrive asynchronously as topic generation completes, so the card
// subscribes to the fact's live topic rows (observeByFact) and shows a subtle
// "generating…" state until the first rows land.
//
// Row actions are DETERMINISTIC (no proposal rail) but still invertible:
//   - DELETE routes through applyPersonaAction({ action_type: 'retire_topic' }),
//     which appends a retire_topic persona_change_log row. The row then shows an
//     UNDO affordance; UNDO calls revertChange(changeLogId) — the ONE consistent
//     invert mechanism (revertChange reactivates the topic + logs a revert_change
//     row, keeping the audit trail honest). Fallback to reactivate() only if no
//     change-log id came back.
// ACCEPT-ALL settles the widget (everything stays active). GENERATE-MORE mints
// additional topics excluding the existing texts (topic-planning-service).

import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import { applyPersonaAction } from '@/lib/database/services/persona-action-executor';
import { revertChange } from '@/lib/database/services/persona-change-log-service';
import { observeByFact, reactivate } from '@/lib/database/services/topic-service';
import { generateMoreTopicsForFact } from '@/lib/database/services/topic-planning-service';
import { getFacts } from '@/lib/database/services/fact-service';
import { retryTopicGeneration } from '@/lib/chat-tools/tool-handlers';
import type TopicModel from '@/lib/database/models/Topic';
import {
  useFloatingChatFactMutationVersion,
  useFloatingChatSettledTopicPlans,
  useFloatingChatStore,
} from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, { withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)';

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

interface TopicRow {
  id: string;
  text: string;
  status: TopicModel['status'];
}

export interface TopicPlanCardProps {
  factId: string;
  factStatement: string;
}

const TopicPlanCard: React.FC<TopicPlanCardProps> = ({ factId, factStatement }) => {
  const { t } = useTranslation();
  const settledMap = useFloatingChatSettledTopicPlans();
  const settled = settledMap[factId] === true;

  const [rows, setRows] = useState<TopicRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [topicGenError, setTopicGenError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  // topicId → change-log id of its retire, so UNDO can revert the exact row.
  const retireLogIds = useRef<Map<string, string>>(new Map());

  // The owning fact's `topicGenError` — the SAME metadata marker FactAccordion
  // reads to stop its spinner. Without it this card shows "generating" purely
  // because no rows exist, so a failed generation spins forever. Facts aren't
  // observable through a WatermelonDB query here, so this reuses the app's
  // existing fact-refresh seam (FactsList / ProfileScreen do the same):
  // notifyFactMutation bumps factMutationVersion, which fires on both the
  // success and the failure path of topic generation.
  const factMutationVersion = useFloatingChatFactMutationVersion();
  useEffect(() => {
    let cancelled = false;
    getFacts()
      .then((facts) => {
        if (cancelled) return;
        const fact = facts.find((f) => f.id === factId);
        setTopicGenError(fact?.metadata?.topicGenError?.[0] ?? null);
      })
      .catch(() => { /* keep the last known state */ });
    return () => {
      cancelled = true;
    };
  }, [factId, factMutationVersion]);

  useEffect(() => {
    const sub = observeByFact(factId).subscribe((models) => {
      setRows(
        models.map((m) => ({
          id: m.id,
          text: m.text,
          status: m.status,
        })),
      );
      setLoaded(true);
    });
    return () => sub.unsubscribe();
  }, [factId]);

  // Suppressed rows never surface here; active + retired (locally deleted) do.
  const visible = rows.filter((r) => r.status === 'active' || r.status === 'retired');
  const activeCount = visible.filter((r) => r.status === 'active').length;
  // Failed beats generating: zero rows AND a recorded error is terminal, and a
  // retry in flight is genuinely "generating" again.
  const showFailed = visible.length === 0 && !!topicGenError && !isRetrying;
  const showGenerating = visible.length === 0 && !showFailed;

  const handleDelete = async (row: TopicRow) => {
    if (busyId) return;
    setBusyId(row.id);
    hapticLight();
    try {
      const res = await applyPersonaAction(
        { action_type: 'retire_topic', topicId: row.id },
        'user',
      );
      if (res.changeLogId) retireLogIds.current.set(row.id, res.changeLogId);
    } finally {
      setBusyId(null);
    }
  };

  const handleUndo = async (row: TopicRow) => {
    if (busyId) return;
    setBusyId(row.id);
    try {
      const logId = retireLogIds.current.get(row.id);
      if (logId) {
        await revertChange(logId);
        retireLogIds.current.delete(row.id);
      } else {
        // No logged retire to invert (e.g. re-opened thread) — reactivate directly.
        await reactivate(row.id);
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleAcceptAll = () => {
    hapticSuccess();
    useFloatingChatStore.getState().setTopicPlanSettled(factId);
  };

  // Re-runs the same batch generation for this fact. The button is disabled
  // while in flight; tool-handlers additionally drops a retry when one is
  // already running for this factId, so no double-tap can fire two batches.
  const handleRetry = async () => {
    if (isRetrying) return;
    setIsRetrying(true);
    setTopicGenError(null);
    hapticLight();
    try {
      await retryTopicGeneration(factId, factStatement);
    } finally {
      setIsRetrying(false);
    }
  };

  const handleGenerateMore = async () => {
    if (isGenerating) return;
    setIsGenerating(true);
    hapticLight();
    try {
      await generateMoreTopicsForFact(factId, factStatement);
    } finally {
      setIsGenerating(false);
    }
  };

  // Settled: compact summary, no controls.
  if (settled) {
    return (
      <Animated.View entering={cardEntering} style={[styles.card, styles.cardSettled]}>
        <View style={styles.headerRow}>
          <MaterialIcons name="check-circle" size={18} color={ACCENT} />
          <Text size="sm" bold style={styles.title}>
            {t('topicPlan.settledTitle')}
          </Text>
        </View>
        <Text size="xs" style={styles.settledSub}>
          {t('topicPlan.settledSummary', { count: activeCount })}
        </Text>
      </Animated.View>
    );
  }

  return (
    <Animated.View entering={cardEntering} style={styles.card}>
      <View style={styles.headerRow}>
        <MaterialIcons name="account-tree" size={18} color={ACCENT} />
        <Text size="sm" bold style={styles.title}>
          {t('topicPlan.title')}
        </Text>
      </View>
      {/* The owning fact, English by the agent's LANGUAGE rule. Display only —
          `factStatement` reaches retryTopicGeneration / generateMoreTopicsForFact
          straight from the PROP, never from what is rendered here, so topic
          generation keeps seeing the English statement. */}
      <TranslatableDynamic
        text={factStatement}
        size="xs"
        italic
        style={styles.factLine}
        numberOfLines={2}
      />

      {showFailed ? (
        <View style={styles.failedRow} testID="topic-plan-failed">
          <MaterialIcons name="error-outline" size={18} color={ACCENT} />
          <Text size="xs" style={styles.failedText}>
            {t('floatingChat.topicGenFailed')}
          </Text>
          <Pressable
            onPress={handleRetry}
            disabled={isRetrying}
            hitSlop={8}
            testID="topic-plan-retry"
            style={styles.retryButton}
            accessibilityRole="button"
            accessibilityLabel={t('floatingChat.topicGenRetry')}
          >
            <Text size="xs" bold style={styles.retryText}>
              {t('floatingChat.topicGenRetry')}
            </Text>
          </Pressable>
        </View>
      ) : showGenerating ? (
        <View style={styles.generatingRow}>
          <ActivityIndicator size="small" color={ACCENT} />
          <Text size="xs" style={styles.generatingText}>
            {loaded ? t('topicPlan.generating') : t('topicPlan.loading')}
          </Text>
        </View>
      ) : (
        <View style={styles.rows}>
          {visible.map((row) => {
            const retired = row.status === 'retired';
            const rowBusy = busyId === row.id;
            return (
              <View key={row.id} style={[styles.topicRow, retired && styles.topicRowRetired]}>
                {/* Topic texts are the RETRIEVAL keys — English, and sent to
                    the server as-is. Only the rendering is translated: delete /
                    undo act on `row.id`, and the row is never written back. */}
                <TranslatableDynamic
                  text={row.text}
                  size="sm"
                  style={{
                    ...styles.topicText,
                    ...(retired ? styles.topicTextRetired : {}),
                  }}
                  numberOfLines={2}
                />
                {retired ? (
                  <Pressable
                    onPress={() => handleUndo(row)}
                    disabled={rowBusy}
                    hitSlop={8}
                    style={styles.iconButton}
                    accessibilityLabel={t('topicPlan.undo')}
                  >
                    <MaterialIcons name="undo" size={18} color={ACCENT} />
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={() => handleDelete(row)}
                    disabled={rowBusy}
                    hitSlop={8}
                    style={styles.iconButton}
                    accessibilityLabel={t('topicPlan.delete')}
                  >
                    <MaterialIcons name="close" size={18} color="rgb(150, 150, 150)" />
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>
      )}

      <View style={styles.buttonRow}>
        <Button
          onPress={handleGenerateMore}
          isDisabled={isGenerating}
          className="flex-1 rounded-full bg-background-100"
          size="sm"
        >
          <ButtonText className="text-typography-700 text-sm">
            {isGenerating ? t('topicPlan.generatingMore') : t('topicPlan.generateMore')}
          </ButtonText>
        </Button>
        <Button
          onPress={handleAcceptAll}
          className="flex-1 rounded-full bg-primary-400"
          size="sm"
        >
          <ButtonText className="text-white text-sm">{t('topicPlan.acceptAll')}</ButtonText>
        </Button>
      </View>
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
  cardSettled: {
    opacity: 0.75,
    gap: 6,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: ACCENT },
  // `fontStyle` moved to TranslatableDynamic's `italic` PROP — the wrapper
  // resolves it to a class, and leaving it as a raw style depends on gluestack
  // merging `style` after its className-derived styles.
  factLine: { color: 'rgb(180, 180, 180)' },
  settledSub: { color: 'rgb(170, 170, 170)' },
  generatingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  generatingText: { color: 'rgb(170, 170, 170)' },
  failedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  failedText: { flex: 1, color: 'rgb(200, 200, 200)' },
  retryButton: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ACCENT,
  },
  retryText: { color: ACCENT },
  rows: { gap: 6 },
  topicRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 2,
  },
  topicRowRetired: { opacity: 0.55 },
  topicText: { flex: 1, color: 'rgb(210, 210, 210)' },
  topicTextRetired: { textDecorationLine: 'line-through', color: 'rgb(150, 150, 150)' },
  iconButton: { padding: 4 },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 2 },
});

export default TopicPlanCard;
