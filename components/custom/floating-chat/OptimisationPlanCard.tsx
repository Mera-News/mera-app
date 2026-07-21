// OptimisationPlanCard — the interactive daily feed tune-up (Round-4 C5).
//
// Loads the single pending plan from optimisation-plan-service and renders it as
// two sections: "Tune-ups" (autoChanges, default checked) and "Needs your input"
// (reviewItems as radio groups with the LLM's recommended default pre-selected,
// its rationale, and any liked-story conflicts). "Apply plan" applies exactly the
// checked/selected ops and settles the card; "Not now" just closes the popover
// (the plan stays pending); "Discard plan" (with a confirm) drops it entirely.
//
// Ops are NEVER built here — the service owns the deterministic candidate
// registry and validates every op before it touches the persona. This card only
// collects the user's checkbox/radio selections.

import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { hapticSuccess, hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { toastManager } from '@/lib/toast-manager';
import {
  acceptPlan,
  dismissPlan,
  getPendingPlan,
  type PendingPlan,
} from '@/lib/database/services/optimisation-plan-service';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
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

type LoadState = 'loading' | 'ready' | 'empty';

const OptimisationPlanCard: React.FC = () => {
  const { t } = useTranslation();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [plan, setPlan] = useState<PendingPlan | null>(null);

  // Selection state. checkedAuto: fingerprint → checked (default true).
  // reviewChoice: fingerprint → chosen option index (default the LLM default).
  const [checkedAuto, setCheckedAuto] = useState<Record<string, boolean>>({});
  const [reviewChoice, setReviewChoice] = useState<Record<string, number>>({});

  const [applying, setApplying] = useState(false);
  const [settledCount, setSettledCount] = useState<number | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await getPendingPlan();
        if (cancelled) return;
        if (!p || (p.autoChanges.length === 0 && p.reviewItems.length === 0)) {
          setLoadState('empty');
          return;
        }
        setPlan(p);
        setCheckedAuto(Object.fromEntries(p.autoChanges.map((a) => [a.fingerprint, true])));
        setReviewChoice(
          Object.fromEntries(p.reviewItems.map((r) => [r.fingerprint, r.defaultIndex])),
        );
        setLoadState('ready');
      } catch (err) {
        logger.captureException(err, {
          tags: { component: 'OptimisationPlanCard', method: 'load' },
        });
        if (!cancelled) setLoadState('empty');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleApply = async () => {
    if (!plan || applying) return;
    setApplying(true);
    try {
      const uncheckedAuto = plan.autoChanges
        .filter((a) => !checkedAuto[a.fingerprint])
        .map((a) => a.fingerprint);
      const res = await acceptPlan({ uncheckedAuto, reviewChoices: reviewChoice });
      setSettledCount(res.appliedOps);
      void hapticSuccess();
      toastManager.showSuccess(
        t('optimisationPlan.appliedTitle'),
        t('optimisationPlan.appliedToast', { count: res.appliedOps }),
      );
    } catch (err) {
      logger.captureException(err, {
        tags: { component: 'OptimisationPlanCard', method: 'apply' },
      });
    } finally {
      setApplying(false);
    }
  };

  const handleNotNow = () => {
    void hapticLight();
    useFloatingChatStore.getState().collapse();
  };

  const handleDiscard = async () => {
    try {
      await dismissPlan();
    } catch (err) {
      logger.captureException(err, {
        tags: { component: 'OptimisationPlanCard', method: 'discard' },
      });
    }
    void hapticLight();
    useFloatingChatStore.getState().collapse();
  };

  // --- Empty / settled states ---------------------------------------------
  if (loadState === 'loading') {
    return null;
  }
  if (loadState === 'empty') {
    return (
      <Animated.View entering={cardEntering} style={styles.card}>
        <Text size="sm" style={styles.emptyText}>
          {t('optimisationPlan.empty')}
        </Text>
      </Animated.View>
    );
  }
  if (settledCount !== null) {
    return (
      <Animated.View entering={cardEntering} style={[styles.card, styles.cardSettled]}>
        <View style={styles.headerRow}>
          <MaterialIcons name="check-circle" size={18} color={ACCENT} />
          <Text size="sm" bold style={styles.title}>
            {t('optimisationPlan.appliedTitle')}
          </Text>
        </View>
        <Text size="sm" style={styles.subtitle}>
          {t('optimisationPlan.appliedToast', { count: settledCount })}
        </Text>
      </Animated.View>
    );
  }

  if (!plan) return null;

  return (
    <Animated.View entering={cardEntering} style={styles.card}>
      <View style={styles.headerRow}>
        <MaterialIcons name="auto-fix-high" size={18} color={ACCENT} />
        <Text size="sm" bold style={styles.title}>
          {t('optimisationPlan.cardTitle')}
        </Text>
      </View>
      <Text size="xs" style={styles.subtitle}>
        {t('optimisationPlan.cardSubtitle')}
      </Text>

      {/* --- Auto section --- */}
      {plan.autoChanges.length > 0 && (
        <View style={styles.section}>
          <Text size="xs" bold style={styles.sectionLabel}>
            {t('optimisationPlan.autoSection')}
          </Text>
          {plan.autoChanges.map((a) => {
            const checked = checkedAuto[a.fingerprint] ?? true;
            return (
              <Pressable
                key={a.fingerprint}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                onPress={() =>
                  setCheckedAuto((prev) => ({ ...prev, [a.fingerprint]: !checked }))
                }
                style={styles.row}
              >
                <MaterialIcons
                  name={checked ? 'check-box' : 'check-box-outline-blank'}
                  size={18}
                  color={checked ? ACCENT : 'rgb(140, 140, 140)'}
                  style={styles.rowIcon}
                />
                <Text size="sm" style={styles.rowLabel}>
                  {a.summary}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* --- Review section --- */}
      {plan.reviewItems.length > 0 && (
        <View style={styles.section}>
          <Text size="xs" bold style={styles.sectionLabel}>
            {t('optimisationPlan.reviewSection')}
          </Text>
          {plan.reviewItems.map((item) => {
            const chosen = reviewChoice[item.fingerprint] ?? item.defaultIndex;
            return (
              <View key={item.fingerprint} style={styles.reviewItem}>
                <Text size="sm" bold style={styles.question}>
                  {item.question}
                </Text>
                {item.rationale.length > 0 && (
                  <Text size="xs" style={styles.rationale}>
                    {item.rationale}
                  </Text>
                )}
                {item.conflictsWith.length > 0 && (
                  <View style={styles.conflictBox}>
                    <Text size="xs" bold style={styles.conflictLabel}>
                      {t('optimisationPlan.conflictsLabel')}
                    </Text>
                    {item.conflictsWith.map((c, i) => (
                      <Text key={i} size="xs" style={styles.conflictText}>
                        • {c.title}
                      </Text>
                    ))}
                  </View>
                )}
                {item.options.map((opt, idx) => {
                  const selected = idx === chosen;
                  return (
                    <Pressable
                      key={idx}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      onPress={() =>
                        setReviewChoice((prev) => ({ ...prev, [item.fingerprint]: idx }))
                      }
                      style={[styles.row, styles.optionRow, selected && styles.optionRowSelected]}
                    >
                      <MaterialIcons
                        name={selected ? 'radio-button-checked' : 'radio-button-unchecked'}
                        size={18}
                        color={selected ? ACCENT : 'rgb(140, 140, 140)'}
                        style={styles.rowIcon}
                      />
                      <Text size="sm" style={styles.rowLabel}>
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            );
          })}
        </View>
      )}

      {/* --- Footer --- */}
      <View style={styles.buttonRow}>
        <Button
          onPress={handleNotNow}
          className="flex-1 rounded-full bg-background-100"
          size="sm"
        >
          <ButtonText className="text-typography-700 text-sm">
            {t('optimisationPlan.notNow')}
          </ButtonText>
        </Button>
        <Button
          onPress={handleApply}
          isDisabled={applying}
          className="flex-1 rounded-full bg-primary-400"
          size="sm"
        >
          <ButtonText className="text-white text-sm">
            {t('optimisationPlan.apply')}
          </ButtonText>
        </Button>
      </View>

      {/* --- Discard (subtle, with confirm) --- */}
      {confirmingDiscard ? (
        <View style={styles.discardConfirmRow}>
          <Text size="xs" style={styles.discardConfirmText}>
            {t('optimisationPlan.discardConfirm')}
          </Text>
          <View style={styles.discardConfirmButtons}>
            <Pressable onPress={() => setConfirmingDiscard(false)} style={styles.discardPill}>
              <Text size="xs" style={styles.discardKeepText}>
                {t('optimisationPlan.discardConfirmNo')}
              </Text>
            </Pressable>
            <Pressable onPress={handleDiscard} style={styles.discardPill}>
              <Text size="xs" style={styles.discardYesText}>
                {t('optimisationPlan.discardConfirmYes')}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          onPress={() => setConfirmingDiscard(true)}
          style={styles.discardLink}
          accessibilityRole="button"
        >
          <Text size="xs" style={styles.discardLinkText}>
            {t('optimisationPlan.discard')}
          </Text>
        </Pressable>
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
  cardSettled: {
    opacity: 0.85,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: ACCENT,
  },
  subtitle: {
    color: 'rgb(190, 190, 190)',
  },
  emptyText: {
    color: 'rgb(180, 180, 180)',
    fontStyle: 'italic',
  },
  section: {
    gap: 8,
  },
  sectionLabel: {
    color: 'rgb(200, 200, 200)',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  rowIcon: {
    marginTop: 1,
  },
  rowLabel: {
    flex: 1,
    color: 'rgb(215, 215, 215)',
  },
  reviewItem: {
    gap: 6,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255, 255, 255, 0.12)',
  },
  question: {
    color: 'rgb(225, 225, 225)',
  },
  rationale: {
    color: 'rgb(165, 165, 165)',
  },
  conflictBox: {
    gap: 2,
    padding: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(248, 113, 113, 0.10)',
  },
  conflictLabel: {
    color: '#F0A38A',
  },
  conflictText: {
    color: 'rgb(200, 180, 175)',
  },
  optionRow: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'transparent',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  optionRowSelected: {
    borderColor: ACCENT,
    backgroundColor: 'rgba(231, 138, 83, 0.10)',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 2,
  },
  discardLink: {
    alignItems: 'center',
    paddingVertical: 2,
  },
  discardLinkText: {
    color: 'rgb(140, 140, 140)',
    textDecorationLine: 'underline',
  },
  discardConfirmRow: {
    gap: 8,
    padding: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  discardConfirmText: {
    color: 'rgb(190, 190, 190)',
  },
  discardConfirmButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  discardPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  discardKeepText: {
    color: 'rgb(180, 180, 180)',
  },
  discardYesText: {
    color: '#F87171',
    fontWeight: '600',
  },
});

export default OptimisationPlanCard;
