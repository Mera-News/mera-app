// The Feed's scoring progress, drawn as the tab header's bottom edge (owner):
// screen edge to screen edge, only while a run scores. TabPages places it
// absolutely, so the header's measured height never includes it. The Feed page
// only: on Stories and Notifications it fades with the pager, like the View chip.

import { tabSwipeProgress } from '@/components/custom/nav/swipe-progress';
import { pickScoringProgress } from '@/components/custom/for-you/status-ink';
import {
  useForYouAsyncJobProcessedCount,
  useForYouAsyncJobTotalCount,
  useForYouBatchProgress,
} from '@/lib/stores/selectors';
import { themedStyles } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { chipOpacity } from './FeedViewChip';

const FeedHeaderProgress: React.FC<{ readonly pageIndex: number }> = ({ pageIndex }) => {
  const { t } = useTranslation();
  const styles = useStyles();
  const run = pickScoringProgress(
    useForYouBatchProgress(),
    useForYouAsyncJobProcessedCount(),
    useForYouAsyncJobTotalCount(),
  );
  const progress = tabSwipeProgress('feed');
  const fade = useAnimatedStyle(() => ({ opacity: chipOpacity(progress.value, pageIndex) }));
  if (!run) return null;
  return (
    <Animated.View
      testID="feed-header-progress"
      accessibilityRole="progressbar"
      accessibilityLabel={t('feedStatus.cloudProgress')}
      accessibilityValue={{ min: 0, max: run.total, now: run.done }}
      style={[styles.track, fade]}
    >
      <View style={[styles.fill, { width: `${Math.min(100, (run.done / run.total) * 100)}%` }]} />
    </Animated.View>
  );
};

const useStyles = themedStyles((c) => StyleSheet.create({
  track: { height: 2, backgroundColor: c.line },
  fill: { height: 2, backgroundColor: c.accent },
}));

export default FeedHeaderProgress;
