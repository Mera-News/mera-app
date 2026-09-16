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
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import logger from '@/lib/logger';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useRef, useState } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { resolveGroup } from './fact-choice-actions';
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
  /** `${messageId}::${toolCallIndex}` — the tool result this group lives in. */
  resultKey: string;
  /** The tool call's staged result. The store holds overrides only, so the
   *  first tap of a turn has nothing to merge into without this. */
  baseResult: Record<string, unknown>;
  groupIndex: number;
  /** This group's own slot inside that result. NOT the array position. */
  groupId: string;
  options: string[];
  questionnaireAttribute: string | null;
  /** The user skipped this group: render the one-line state with Undo. */
  dismissed?: boolean;
  /** From an earlier conversation: render inert, never commit. */
  stale?: boolean;
}

export const FactChoiceCard: React.FC<FactChoiceCardProps> = ({
  resultKey,
  baseResult,
  groupIndex,
  groupId,
  options,
  questionnaireAttribute,
  dismissed = false,
  stale = false,
}) => {
  const { t } = useTranslation();
  // Index 0 is Mera's preferred reading, preselected — so the unambiguous case
  // (one option) really is one tap.
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<View>(null);

  // `dismissed` and the derived pending/saved split come from the DERIVER, which
  // reads this group's own slot. This component deliberately no longer decides
  // "am I answered" from the presence of a value at `resultKey`: that check was
  // shared by every sibling card, so the first tap settled all of them.
  const single = options.length === 1;

  // Replacing a card in place moves content under the reader's finger, so the
  // new state has to be announced rather than silently swapped. Focus lands on
  // the card that changed, not on the list.
  const announce = () => {
    const node = findNodeHandle(cardRef.current);
    if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
  };

  const handleAdd = async () => {
    if (busy || stale || dismissed) return;
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
      // Only THIS group's slot changes. Every sibling keeps its own state.
      resolveGroup(
        resultKey,
        groupId,
        { status: 'saved', statements: [statement], savedFacts, conflicts },
        baseResult,
      );
      void hapticSuccess();
      announce();
    } catch (err) {
      logger.error('[FactChoiceCard] commit failed', err, { resultKey, groupId, groupIndex });
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    if (busy || stale || dismissed) return;
    void hapticLight();
    // Nothing was ever written, so there is nothing to undo in the DATA — this
    // records the choice so the composer unblocks. The card keeps its options so
    // Undo can restore it exactly.
    resolveGroup(
      resultKey,
      groupId,
      { status: 'dismissed', options, questionnaireAttribute },
      baseResult,
    );
    announce();
  };

  const handleUndo = () => {
    if (busy || stale) return;
    void hapticLight();
    // Removing the entry returns the group to pending, which re-blocks the
    // composer — correct: an unanswered question is unanswered again.
    resolveGroup(resultKey, groupId, undefined, baseResult);
    announce();
  };

  if (dismissed) {
    return (
      <Animated.View
        ref={cardRef}
        entering={cardEntering}
        style={[styles.card, styles.cardSettled]}
        accessible
        accessibilityLiveRegion="polite"
        testID={`fact-choice-dismissed-${groupIndex}`}
      >
        <View style={styles.headerRow}>
          <MaterialIcons name="close" size={18} color={ACCENT} />
          <Text size="sm" bold style={styles.title}>
            {t('factChoice.dismissedTitle')}
          </Text>
          {!stale && (
            <Pressable
              onPress={handleUndo}
              hitSlop={12}
              style={styles.undoButton}
              accessibilityRole="button"
              accessibilityLabel={t('topicPlan.undo')}
              testID={`fact-choice-undo-${groupIndex}`}
            >
              <Text size="xs" bold style={styles.undoText}>
                {t('topicPlan.undo')}
              </Text>
            </Pressable>
          )}
        </View>
        <Text size="xs" style={styles.settledSub}>
          {t('factChoice.dismissedSummary')}
        </Text>
      </Animated.View>
    );
  }

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
  // Opacity alone would drag the body text under 4.5:1 on the dark ground, so a
  // settled card dims its CHROME and the text below keeps its own contrast.
  cardSettled: { gap: 6, borderColor: 'rgba(231, 138, 83, 0.45)' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: ACCENT, flex: 1 },
  // 'rgb(170,170,170)' on this card's ground measures ~4.1:1 — under the 4.5:1
  // floor for body text. This is the settled state's only prose, so it is the
  // one place that mattered.
  settledSub: { color: 'rgb(200, 200, 200)' },
  undoButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ACCENT,
  },
  undoText: { color: ACCENT },
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
