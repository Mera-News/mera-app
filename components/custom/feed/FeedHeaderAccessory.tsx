// The Feed page's header accessory (TabPages `renderAccessory`): under the
// Feed | Stories track, hiding with the header. The View chip, right-aligned,
// then the ONE counts card whenever it shows (feed-status-card.ts): an empty
// Feed whose state needs it, the daily limit, or the status icon's request.

import DashboardStatsCard from '@/components/custom/for-you/DashboardStatsCard';
import { useFeedStatusCard } from '@/components/custom/for-you/feed-status-card';
import InlineChoiceChip from '@/components/custom/nav/InlineChoiceChip';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { type FeedView, setFeedView, useFeedView } from './feed-view-prefs';

const VIEWS: readonly FeedView[] = ['continuous', 'sectioned'];

const FeedHeaderAccessory: React.FC = () => {
  const { t } = useTranslation();
  const view = useFeedView();
  const limited = useFeedStatusMode() === 'limited';
  const requested = useFeedStatusCard((s) => s.requested);
  const emptyWants = useFeedStatusCard((s) => s.emptyWants);
  const labelOf = useCallback(
    (v: FeedView) => (v === 'sectioned' ? t('feed.view.sectioned') : t('feed.view.continuous')),
    [t],
  );
  return (
    <View style={styles.wrap} testID="feed-header-accessory">
      <View style={styles.chipRow}>
        <InlineChoiceChip
          options={VIEWS}
          value={view}
          labelOf={labelOf}
          a11yLabelOf={(v) => t('feed.view.a11y', { view: labelOf(v) })}
          onChange={setFeedView}
          testID="feed-view-chip"
        />
      </View>
      {limited || requested || emptyWants ? <DashboardStatsCard testID="feed-status-card" /> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  chipRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', minHeight: 34 },
});

export default FeedHeaderAccessory;
