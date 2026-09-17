// AskChoiceCard — 2 or 3 tap chips from an `ask_choice` call.
//
// AN OFFER, NEVER A MODAL GATE. The composer stays fully live beside it, so
// typing past the question is always possible; `ask_choice` ends the model's
// turn, and a card that blocked the input would strand the user behind a
// question they did not want to answer.
//
// A tap sends the option text VERBATIM through the thread's existing `onSend`,
// which is ChatSessionView.handleSend — the single funnel every text send goes
// through, and where the blocked/streaming/entitlement gates live. Starter
// chips already work this way. Never call a send path directly.
//
// IT WRITES NOTHING TO THE TURN STATE. The loop reads the structured payload
// for the tapped option off `agentTurnState.pendingChoice`; a card that
// cleared that on tap would delete the very thing the loop is about to read,
// which is the failure the shared turn state exists to prevent.

import { Text } from '@/components/ui/text';
import { hapticLight } from '@/lib/haptics';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)';

function cardEntering() {
  'worklet';
  const duration = 240;
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 8 }] },
    animations: {
      opacity: withTiming(1, { duration }),
      transform: [{ translateY: withTiming(0, { duration }) }],
    },
  };
}

export interface AskChoiceCardProps {
  question: string | null;
  options: string[];
  answered: boolean;
  onSend: (text: string) => void;
}

export const AskChoiceCard: React.FC<AskChoiceCardProps> = ({
  question,
  options,
  answered,
  onSend,
}) => {
  const { t } = useTranslation();

  return (
    <Animated.View entering={cardEntering} style={styles.wrap} testID="ask-choice-card">
      {/* Only when the bubble did not already carry the question as prose. */}
      {question !== null && (
        <Text size="sm" style={styles.question}>
          {question}
        </Text>
      )}

      <View style={styles.chips}>
        {options.map((option, idx) => (
          <Pressable
            key={`${idx}-${option}`}
            onPress={() => {
              if (answered) return;
              void hapticLight();
              // Verbatim: the loop matches the tap back to its option by text.
              onSend(option);
            }}
            disabled={answered}
            style={[styles.chip, answered && styles.chipAnswered]}
            accessibilityRole="button"
            accessibilityState={{ disabled: answered }}
            accessibilityLabel={answered ? `${option}, ${t('askChoice.answeredA11y')}` : option}
            testID={`ask-choice-option-${idx}`}
          >
            <Text
              size="xs"
              style={answered ? styles.chipTextAnswered : styles.chipText}
              numberOfLines={2}
            >
              {option}
            </Text>
          </Pressable>
        ))}
      </View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  wrap: { gap: 8, paddingVertical: 2 },
  question: { color: 'rgb(210, 210, 210)' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    // 48dp target: long options wrap to two lines, so this is a floor.
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ACCENT,
    backgroundColor: 'rgba(231, 138, 83, 0.10)',
    maxWidth: '100%',
  },
  // Spent, not gone: the thread keeps the record of what was offered.
  chipAnswered: {
    opacity: 0.55,
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  chipText: { color: 'rgb(226, 226, 226)', flexShrink: 1 },
  chipTextAnswered: { color: 'rgb(170, 170, 170)', flexShrink: 1 },
});

export default AskChoiceCard;
