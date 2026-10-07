// The Feed tab's pages: Feed, Interests, Stories, a fixed group (only World
// is arranged). The Feed page is keep-mounted in the pager (PAGE_META), so
// its reading session survives any swipe or reorder.
//
// The status icon sits in the header's leading slot on every page of the tab;
// a tap slides the counts card in over the list (StatusCardSlideIn), mounted
// here once, OUTSIDE TabPages (which all four tabs share).

import FeedStatusIcon from '@/components/custom/for-you/FeedStatusIcon';
import InterestsPage from '@/components/custom/for-you/InterestsPage';
import StatusCardSlideIn from '@/components/custom/for-you/StatusCardSlideIn';
import FeedScreen from '@/components/custom/feed/FeedScreen';
import { PAGE_META } from '@/components/custom/nav/page-registry';
import TabPages from '@/components/custom/nav/TabPages';
import type { PageDot, PagePill, PageRenderProps } from '@/components/custom/nav/types';
import TrackedStoriesScreen from '@/components/custom/tracked-stories/TrackedStoriesScreen';
import { usePageOrder } from '@/lib/navigation/page-order';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

/** Lazy, so the pill strip's graph never loads the SQLite singleton at import. */
function trackedService(): typeof import('@/lib/database/services/tracked-story-service') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/database/services/tracked-story-service');
}

/** Stories' dot: something new in a followed story (a dot, never a count). */
export function useStoriesDot(): PageDot {
  const [unseen, setUnseen] = useState(0);
  useEffect(() => {
    const sub = trackedService()
      .observeUnseenTotal()
      .subscribe({ next: setUnseen, error: () => setUnseen(0) });
    return () => sub.unsubscribe();
  }, []);
  return { visible: unseen > 0 };
}

export function FeedPages() {
  const { t } = useTranslation();
  const order = usePageOrder('feed');
  const pills: PagePill[] = useMemo(
    () =>
      order.map((id) => ({
        id,
        label: t(PAGE_META[id].labelKey),
        icon: id === 'feed' ? 'article' : id === 'stories' ? 'layers' : undefined,
        useDot: id === 'stories' ? useStoriesDot : undefined,
      })),
    [order, t],
  );

  const renderPage = useCallback(({ pageId, active, header }: PageRenderProps) => {
    switch (pageId) {
      case 'feed':
        return <FeedScreen active={active} header={header} />;
      case 'interests':
        return <InterestsPage active={active} header={header} />;
      case 'stories':
        return (
          <TrackedStoriesScreen
            embedded
            active={active}
            scrollHandler={header.scrollHandler}
            headerHeight={header.headerHeight}
          />
        );
      default:
        return null;
    }
  }, []);

  const [statusShown, setStatusShown] = useState(false);
  const toggleStatus = useCallback(() => setStatusShown((v) => !v), []);
  const hideStatus = useCallback(() => setStatusShown(false), []);
  const leading = useMemo(() => <FeedStatusIcon onPress={toggleStatus} />, [toggleStatus]);

  return (
    <View style={{ flex: 1 }}>
      <TabPages tab="feed" pages={pills} renderPage={renderPage} leading={leading} testID="feed-pages" />
      <StatusCardSlideIn visible={statusShown} onHide={hideStatus} />
    </View>
  );
}

export default FeedPages;
