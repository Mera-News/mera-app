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
//   - HIGH-PRIORITY (star) routes through mutationRailsService.setTopicHighPriority
//     — score-only boost, never touches weight; logs an invertible set_high_priority row.
// ACCEPT-ALL settles the widget (everything stays active). GENERATE-MORE mints
// additional topics excluding the existing texts (topic-planning-service).

import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import { applyPersonaAction } from '@/lib/database/services/persona-action-executor';
import { setTopicHighPriority } from '@/lib/database/services/mutation-rails-service';
import { revertChange } from '@/lib/database/services/persona-change-log-service';
import { observeByFact, reactivate } from '@/lib/database/services/topic-service';
import { generateMoreTopicsForFact } from '@/lib/database/services/topic-planning-service';
import type TopicModel from '@/lib/database/models/Topic';
import {
  useFloatingChatSettledTopicPlans,
  useFloatingChatStore,
} from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, { withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)';
const STAR_ON = 'rgb(245, 197, 66)';

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
  highPriority: boolean;
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
  // topicId → change-log id of its retire, so UNDO can revert the exact row.
  const retireLogIds = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const sub = observeByFact(factId).subscribe((models) => {
      setRows(
        models.map((m) => ({
          id: m.id,
          text: m.text,
          status: m.status,
          highPriority: m.highPriority,
        })),
      );
      setLoaded(true);
    });
    return () => sub.unsubscribe();
  }, [factId]);

  // Suppressed rows never surface here; active + retired (locally deleted) do.
  const visible = rows.filter((r) => r.status === 'active' || r.status === 'retired');
  const activeCount = visible.filter((r) => r.status === 'active').length;
  const showGenerating = visible.length === 0;

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

  const handleToggleHighPriority = async (row: TopicRow) => {
    if (busyId) return;
    setBusyId(row.id);
    hapticLight();
    try {
      await setTopicHighPriority(row.id, !row.highPriority, 'user');
    } finally {
      setBusyId(null);
    }
  };

  const handleAcceptAll = () => {
    hapticSuccess();
    useFloatingChatStore.getState().setTopicPlanSettled(factId);
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
      <Text size="xs" style={styles.factLine} numberOfLines={2}>
        {factStatement}
      </Text>

      {showGenerating ? (
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
                <Text
                  size="sm"
                  style={[styles.topicText, retired && styles.topicTextRetired]}
                  numberOfLines={2}
                >
                  {row.text}
                </Text>
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
                  <View style={styles.rowActions}>
                    <Pressable
                      onPress={() => handleToggleHighPriority(row)}
                      disabled={rowBusy}
                      hitSlop={8}
                      style={styles.iconButton}
                      accessibilityLabel={t('topicPlan.highPriority')}
                    >
                      <MaterialIcons
                        name={row.highPriority ? 'star' : 'star-border'}
                        size={18}
                        color={row.highPriority ? STAR_ON : 'rgb(150, 150, 150)'}
                      />
                    </Pressable>
                    <Pressable
                      onPress={() => handleDelete(row)}
                      disabled={rowBusy}
                      hitSlop={8}
                      style={styles.iconButton}
                      accessibilityLabel={t('topicPlan.delete')}
                    >
                      <MaterialIcons name="close" size={18} color="rgb(150, 150, 150)" />
                    </Pressable>
                  </View>
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
  factLine: { color: 'rgb(180, 180, 180)', fontStyle: 'italic' },
  settledSub: { color: 'rgb(170, 170, 170)' },
  generatingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  generatingText: { color: 'rgb(170, 170, 170)' },
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
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  iconButton: { padding: 4 },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 2 },
});

export default TopicPlanCard;
