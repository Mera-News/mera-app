// TopicPlanSaveAllRow — one-tap settle for every pending TopicPlanCard in the
// thread. After a multi-fact message the assistant emits one topic-plan card per
// fact, each with its own "Looks good"; this row saves the user N taps. Renders
// only when 2+ plans are unsettled — a single pending card keeps its own button
// as the sole affordance. Settling is the same store-level acknowledgement the
// per-card button performs (topics stay active either way), so "saving all"
// never mutates topics.
//
// Subscribes to the settled map itself (mirroring TopicPlanCard) so ChatThread
// stays presentational; the thread passes only the factIds it is rendering.

import { Button, ButtonText } from '@/components/ui/button';
import { hapticSuccess } from '@/lib/haptics';
import {
  useFloatingChatSettledTopicPlans,
  useFloatingChatStore,
} from '@/lib/stores/floating-chat-store';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

export interface TopicPlanSaveAllRowProps {
  /** factIds of every topic-plan card currently in the thread. */
  factIds: string[];
}

const TopicPlanSaveAllRow: React.FC<TopicPlanSaveAllRowProps> = ({ factIds }) => {
  const { t } = useTranslation();
  const settledMap = useFloatingChatSettledTopicPlans();
  const pending = factIds.filter((id) => settledMap[id] !== true);

  if (pending.length < 2) return null;

  const handleSaveAll = () => {
    hapticSuccess();
    const { setTopicPlanSettled } = useFloatingChatStore.getState();
    pending.forEach((id) => setTopicPlanSettled(id));
  };

  return (
    <View style={styles.row} testID="chat-save-all-row">
      <Button
        testID="chat-save-all"
        onPress={handleSaveAll}
        className="rounded-full bg-primary-400"
        size="sm"
      >
        <ButtonText className="text-white text-sm">
          {t('topicPlan.saveAll', { count: pending.length })}
        </ButtonText>
      </Button>
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    paddingVertical: 6,
  },
});

export default TopicPlanSaveAllRow;
