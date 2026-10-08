// The Feed page's View chip (owner): in the Feed tab header's LEFT slot,
// icon-only (the chosen style's glyph and ⌄; its menu titled "View", hanging
// from the chip's leading edge). The Feed page only: on Stories and
// Notifications it fades out with the pager's progress and takes no touch.
// The Feed tab has no status icon; the counts card's Mera mark says when Mera
// is working.

import InlineChoiceChip from '@/components/custom/nav/InlineChoiceChip';
import { useCurrentSurface } from '@/components/custom/nav/current-surface';
import { tabSwipeProgress } from '@/components/custom/nav/swipe-progress';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { type FeedView, setFeedView, useFeedView } from './feed-view-prefs';

const VIEWS: readonly FeedView[] = ['continuous', 'sectioned'];
/** The style glyphs, distinct at chip size: one card in a running stream
 *  (`view-day`) for Continuous; blocks of different sizes, grouped
 *  (`dashboard`), for Sectioned. The menu rows use the same pair. */
const VIEW_ICON = { continuous: 'view-day', sectioned: 'dashboard' } as const;
const iconOf = (v: FeedView) => VIEW_ICON[v];

/** How visible the chip is with the Feed tab's pager at `progress`: whole on
 *  the Feed page (`at`), gone one page away. */
export function chipOpacity(progress: number, at: number): number {
  'worklet';
  return Math.max(0, 1 - Math.abs(progress - at));
}

const FeedViewChip: React.FC<{ readonly pageIndex: number }> = ({ pageIndex }) => {
  const { t } = useTranslation();
  const view = useFeedView();
  const onFeed = useCurrentSurface() === 'feed';
  const progress = tabSwipeProgress('feed');
  const fade = useAnimatedStyle(() => ({ opacity: chipOpacity(progress.value, pageIndex) }));
  const labelOf = useCallback(
    (v: FeedView) => (v === 'sectioned' ? t('feed.view.sectioned') : t('feed.view.continuous')),
    [t],
  );
  return (
    <Animated.View
      style={fade}
      pointerEvents={onFeed ? 'box-none' : 'none'}
      accessibilityElementsHidden={!onFeed}
      importantForAccessibility={onFeed ? 'auto' : 'no-hide-descendants'}
      testID="feed-view-chip-slot"
    >
      <InlineChoiceChip
        options={VIEWS}
        value={view}
        labelOf={labelOf}
        a11yLabelOf={(v) => t('feed.view.a11y', { view: labelOf(v) })}
        onChange={setFeedView}
        iconOf={iconOf}
        menuTitle={t('feed.view.title')}
        menuAlign="leading"
        testID="feed-view-chip"
      />
    </Animated.View>
  );
};

export default FeedViewChip;
