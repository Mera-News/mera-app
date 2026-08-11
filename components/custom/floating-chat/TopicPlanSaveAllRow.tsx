// TopicPlanSaveAllRow — one-tap resolution for every pending TopicPlanCard in
// the thread. After a multi-fact message the assistant emits one topic-plan card
// per fact, each with its own Save / Discard; this row saves the user N taps.
// Renders only when 2+ plans are unresolved — a single pending card keeps its
// own buttons as the sole affordance.
//
// r14: the row mirrors the card's TWO terminal actions.
//   - "Save all (N)" keeps every topic and stamps each fact reviewed.
//   - "Discard all" deletes all N facts (cascading to their topics). It is
//     destructive and NOT undoable, so it takes a second tap to confirm — the
//     same two-tap contract the per-card Discard uses.
// Both go through topic-plan-actions, so bulk and single-card behaviour cannot
// drift.
//
// Resolution comes from useTopicPlanResolutions (session store + the durable
// `metadata.topicsReviewedAt` marker + fact existence), NOT the store map alone:
// this row must agree exactly with the gate that blocks the chat input, or the
// user can be left with a block and no visible way to clear it.

import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { discardTopicPlan, saveTopicPlan } from './topic-plan-actions';
import { useTopicPlanResolutions } from './useTopicPlanResolutions';

export interface TopicPlanSaveAllRowProps {
  /** factIds of every topic-plan card currently in the thread. */
  factIds: string[];
}

const TopicPlanSaveAllRow: React.FC<TopicPlanSaveAllRowProps> = ({ factIds }) => {
  const { t } = useTranslation();
  const { unresolved } = useTopicPlanResolutions(factIds);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  if (unresolved.length < 2) return null;

  const handleSaveAll = async () => {
    if (busy) return;
    setBusy(true);
    hapticSuccess();
    try {
      // Sequential: each call writes to WatermelonDB and bumps the shared fact
      // mutation counter. Parallel writes would race the same metadata JSON.
      for (const id of unresolved) await saveTopicPlan(id);
    } finally {
      setBusy(false);
    }
  };

  const handleDiscardAll = async () => {
    if (busy) return;
    if (!confirmDiscard) {
      hapticLight();
      setConfirmDiscard(true);
      return;
    }
    setBusy(true);
    hapticSuccess();
    try {
      for (const id of unresolved) await discardTopicPlan(id);
    } finally {
      setBusy(false);
      setConfirmDiscard(false);
    }
  };

  return (
    <View style={styles.row} testID="chat-save-all-row">
      {confirmDiscard && (
        <Text size="xs" style={styles.warning}>
          {t('topicPlan.discardAllWarning', { count: unresolved.length })}
        </Text>
      )}
      <View style={styles.buttons}>
        <Button
          testID="chat-discard-all"
          onPress={handleDiscardAll}
          isDisabled={busy}
          className="rounded-full bg-background-100"
          size="sm"
        >
          <ButtonText className="text-typography-700 text-sm">
            {confirmDiscard ? t('topicPlan.discardConfirm') : t('topicPlan.discardAll')}
          </ButtonText>
        </Button>
        <Button
          testID="chat-save-all"
          onPress={handleSaveAll}
          isDisabled={busy}
          className="rounded-full bg-primary-400"
          size="sm"
        >
          <ButtonText className="text-white text-sm">
            {t('topicPlan.saveAll', { count: unresolved.length })}
          </ButtonText>
        </Button>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    paddingVertical: 6,
    gap: 6,
  },
  buttons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  warning: {
    color: 'rgb(200, 200, 200)',
    textAlign: 'center',
    paddingHorizontal: 16,
  },
});

export default TopicPlanSaveAllRow;
