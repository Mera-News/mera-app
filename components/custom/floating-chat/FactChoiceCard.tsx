// FactChoiceCard — propose-before-save. Mera OFFERS readings; nothing exists yet.
//
// This card is the step that used to be missing. `saveExtractedFacts` wrote the
// fact and fired topic generation before returning, so the TopicPlanCard that
// followed was an undo, not a confirmation — and a misread input was already a
// fact by the time the user saw it. ("I'm interested in sporting football club"
// became "Interested in sporting a football club": one inserted article decided
// that `sporting` was a verb, and topic generation, left with no entity, fell
// back to the user's city.)
//
// NOTHING IS WRITTEN UNTIL A TAP. The commit runs `commitFactChoices`, which is
// the old handler's body — same `addFact` with the same questionnaire argument,
// same conflict detection, same topic-generation trigger — and then REWRITES the
// tool result so the fact card, conflict cards and TopicPlanCard downstream all
// derive exactly as they did before. That rewrite is why this card needs no
// changes anywhere in the emission logic.
//
// Deliberately NOT built on ProposalCard: `forcedExtractionTools()` returns []
// while a staged proposal exists, and facts are extracted on nearly every turn,
// so routing this through the proposal slot would disable the forced-extraction
// safety net for the whole pending window.

import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { commitFactChoices } from '@/lib/chat-tools/fact-commit';
import { patchMessageToolCallResult } from '@/lib/database/services/conversation-service';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import logger from '@/lib/logger';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
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
      transform: [{ translateY: withTiming(0, { duration }) }, { scale: withTiming(1, { duration }) }],
    },
  };
}

export interface FactChoiceCardProps {
  /** `${messageId}::${toolCallIndex}` — where the commit writes its override. */
  resultKey: string;
  groupIndex: number;
  options: string[];
  questionnaireAttribute: string | null;
  /** From an earlier conversation: render inert, never commit. */
  stale?: boolean;
}

export const FactChoiceCard: React.FC<FactChoiceCardProps> = ({
  resultKey,
  groupIndex,
  options,
  questionnaireAttribute,
  stale = false,
}) => {
  const { t } = useTranslation();
  // Index 0 is Mera's preferred reading, preselected — so the unambiguous case
  // (one option) really is one tap.
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const resolutions = useFloatingChatStore((s) => s.toolCallResults);
  const resolved = resolutions[resultKey] as Record<string, unknown> | undefined;

  // Once ANY group in this tool call has been committed or dismissed, the whole
  // result has been rewritten and this card is answered.
  const isResolved = resolved !== undefined;
  const single = options.length === 1;

  const writeResult = async (result: Record<string, unknown>) => {
    // In-memory override first: it is what makes the card react instantly and
    // what every downstream card reads this render.
    useFloatingChatStore.getState().setToolCallResult(resultKey, result);
    // Durable half. A missing row is NOT an error — an assistant message
    // persists only once the turn finalises, so a fast tap can land first;
    // useChatPersistence merges the override in at write time for that race.
    const [messageId, indexRaw] = resultKey.split('::');
    const index = Number(indexRaw);
    if (messageId && Number.isInteger(index)) {
      void patchMessageToolCallResult(messageId, index, result).catch(() => false);
    }
  };

  const handleAdd = async () => {
    if (busy || stale || isResolved) return;
    setBusy(true);
    void hapticLight();
    try {
      const statement = options[selected] ?? options[0];
      const { savedFacts, conflicts } = await commitFactChoices([
        {
          statement,
          // Passed through so `resolveUserLocationFact` keeps recognising a
          // residence fact. Dropping it here would silently strip `userLocation`
          // from every future topic run.
          questionnaire: questionnaireAttribute ? { attribute: questionnaireAttribute } : undefined,
        },
      ]);
      await writeResult({
        success: true,
        factsSaved: savedFacts.length,
        savedFacts,
        conflicts,
      });
      void hapticSuccess();
    } catch (err) {
      logger.error('[FactChoiceCard] commit failed', err, { resultKey, groupIndex });
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = async () => {
    if (busy || stale || isResolved) return;
    setBusy(true);
    void hapticLight();
    try {
      // Nothing was ever written, so there is nothing to undo — this only
      // settles the card so the composer unblocks.
      await writeResult({
        success: true,
        factsSaved: 0,
        savedFacts: [],
        conflicts: [],
        dismissed: true,
      });
    } finally {
      setBusy(false);
    }
  };

  if (isResolved && (resolved as { dismissed?: boolean }).dismissed) {
    return (
      <Animated.View entering={cardEntering} style={[styles.card, styles.cardSettled]}>
        <View style={styles.headerRow}>
          <MaterialIcons name="close" size={18} color={ACCENT} />
          <Text size="sm" bold style={styles.title}>
            {t('factChoice.dismissedTitle')}
          </Text>
        </View>
        <Text size="xs" style={styles.settledSub}>
          {t('factChoice.dismissedSummary')}
        </Text>
      </Animated.View>
    );
  }
  // A committed group is replaced by the fact + topic-plan cards the rewritten
  // result now emits, so it renders nothing of its own.
  if (isResolved) return null;

  return (
    <Animated.View entering={cardEntering} style={[styles.card, stale && styles.cardSettled]}>
      <View style={styles.headerRow}>
        <MaterialIcons name="help-outline" size={18} color={ACCENT} />
        <Text size="sm" bold style={styles.title}>
          {single ? t('factChoice.titleSingle') : t('factChoice.titleChoose')}
        </Text>
      </View>

      <View style={styles.rows}>
        {options.map((option, idx) => {
          const isSel = idx === selected;
          const interactive = !single && !stale && !busy;
          return (
            <Pressable
              key={`${resultKey}-${groupIndex}-${idx}`}
              onPress={interactive ? () => setSelected(idx) : undefined}
              disabled={!interactive}
              accessibilityRole={single ? 'text' : 'radio'}
              accessibilityState={{ selected: isSel }}
              testID={`fact-choice-option-${groupIndex}-${idx}`}
              style={[styles.optionRow, isSel && !single && styles.optionRowSelected]}
            >
              {!single && (
                <MaterialIcons
                  name={isSel ? 'radio-button-checked' : 'radio-button-unchecked'}
                  size={18}
                  color={isSel ? ACCENT : 'rgb(150, 150, 150)'}
                />
              )}
              {/* Statements are English by the agent's LANGUAGE rule and are what
                  reaches addFact. Only the RENDERING is translated — the commit
                  reads `options[selected]`, never what is drawn here. */}
              <TranslatableDynamic text={option} size="sm" style={styles.optionText} numberOfLines={3} />
            </Pressable>
          );
        })}
      </View>

      {stale ? (
        <Text size="xs" style={styles.settledSub}>
          {t('factChoice.expired')}
        </Text>
      ) : (
        <View style={styles.buttonRow}>
          <Button
            testID={`fact-choice-dismiss-${groupIndex}`}
            onPress={handleDismiss}
            isDisabled={busy}
            className="flex-1 rounded-full bg-background-100"
            size="sm"
          >
            <ButtonText className="text-typography-700 text-sm">{t('factChoice.dismiss')}</ButtonText>
          </Button>
          <Button
            testID={`fact-choice-add-${groupIndex}`}
            onPress={handleAdd}
            isDisabled={busy}
            className="flex-1 rounded-full bg-primary-400"
            size="sm"
          >
            <ButtonText className="text-white text-sm">{t('factChoice.add')}</ButtonText>
          </Button>
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
  cardSettled: { opacity: 0.75, gap: 6 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: ACCENT },
  settledSub: { color: 'rgb(170, 170, 170)' },
  rows: { gap: 6 },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  optionRowSelected: {
    borderColor: ACCENT,
    backgroundColor: 'rgba(231, 138, 83, 0.10)',
  },
  optionText: { flex: 1, color: 'rgb(210, 210, 210)' },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 2 },
});

export default FactChoiceCard;
