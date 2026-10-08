// The Feed page: one page, two views (FinalFeed #2, #3, #5).
//
// Exactly ONE list is mounted: the view the reader chose (`feed_view`, loaded
// before first render by the startup gate). A switch writes the choice first,
// then swaps the list, so the kept list always follows the stored choice and a
// view the reader did not choose never stays mounted. The page itself is
// keep-mounted in the pager (PAGE_META.feed), so the chosen list survives
// swipes and tab switches.
//
// The counts card is each list's first item (useStatsCardItem); the View
// chip sits in the tab header, by the ?.

import InterestsPage from '@/components/custom/for-you/InterestsPage';
import WhatsNewSheet from '@/components/custom/for-you/WhatsNewSheet';
import type { PageHeaderBinding } from '@/components/custom/nav/types';
import React, { useEffect } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { resetStatusCard } from '@/components/custom/for-you/feed-status-card';

import FeedScreen from './FeedScreen';
import { useFeedView } from './feed-view-prefs';

export interface FeedPageProps {
  readonly active: boolean;
  readonly header: PageHeaderBinding;
}

const FeedPage: React.FC<FeedPageProps> = ({ active, header }) => {
  // Leaving the Feed page drops a card the status icon asked for.
  const focused = useIsFocused();
  useEffect(() => {
    if (!(active && focused)) resetStatusCard();
  }, [active, focused]);
  const view = useFeedView();

  return (
    <>
      {view === 'sectioned' ? (
        <InterestsPage active={active} header={header} />
      ) : (
        <FeedScreen active={active} header={header} />
      )}
      {/* One-time "What's new" sheet: gated on the PAGE being active, so a
          reader who keeps Sectioned still gets it decided. After the list, so
          the list stays the first child. */}
      {active ? <WhatsNewSheet /> : null}
    </>
  );
};

export default FeedPage;
