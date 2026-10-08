// The Feed page: one page, two views (FinalFeed #2, #3, #5).
//
// Exactly ONE list is mounted: the view the reader chose (`feed_view`, loaded
// before first render by the startup gate). A switch writes the choice first,
// then swaps the list, so the kept list always follows the stored choice and a
// view the reader did not choose never stays mounted. The page itself is
// keep-mounted in the pager (PAGE_META.feed), so the chosen list survives
// swipes and tab switches.
//
// Each list draws the View chip's row (right-aligned, nothing at its start;
// the page's ? is in the tab header) as the FIRST item of its own list, never
// as a sibling before it (react-native-screens walks to the first child scroll
// view). The row never changes height, open or closed.

import InterestsPage from '@/components/custom/for-you/InterestsPage';
import WhatsNewSheet from '@/components/custom/for-you/WhatsNewSheet';
import InlineChoiceChip from '@/components/custom/nav/InlineChoiceChip';
import type { PageHeaderBinding } from '@/components/custom/nav/types';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import FeedScreen from './FeedScreen';
import { type FeedView, setFeedView, useFeedView } from './feed-view-prefs';

const VIEWS: readonly FeedView[] = ['continuous', 'sectioned'];

export interface FeedPageProps {
  readonly active: boolean;
  readonly header: PageHeaderBinding;
}

const FeedPage: React.FC<FeedPageProps> = ({ active, header }) => {
  const { t } = useTranslation();
  const view = useFeedView();
  const { reveal } = header;

  const labelOf = useCallback(
    (v: FeedView) => (v === 'sectioned' ? t('feed.view.sectioned') : t('feed.view.continuous')),
    [t],
  );
  const onChange = useCallback(
    (next: FeedView) => {
      setFeedView(next);
      // The new list mounts at its top; bring the header back with it.
      reveal();
    },
    [reveal],
  );

  const titleRow = useMemo(
    () => (
      <View style={styles.chipRow} testID="feed-title-row">
        <InlineChoiceChip
          options={VIEWS}
          value={view}
          labelOf={labelOf}
          a11yLabelOf={(v) => t('feed.view.a11y', { view: labelOf(v) })}
          onChange={onChange}
          testID="feed-view-chip"
        />
      </View>
    ),
    [t, view, labelOf, onChange],
  );

  return (
    <>
      {view === 'sectioned' ? (
        <InterestsPage active={active} header={header} listHeader={titleRow} />
      ) : (
        <FeedScreen active={active} header={header} listHeader={titleRow} />
      )}
      {/* One-time "What's new" sheet: gated on the PAGE being active, so a
          reader who keeps Sectioned still gets it decided. After the list, so
          the list stays the first child. */}
      {active ? <WhatsNewSheet /> : null}
    </>
  );
};

const styles = StyleSheet.create({
  // PageTitleRow's height, so the first card does not move.
  chipRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', minHeight: 34 },
});

export default FeedPage;
