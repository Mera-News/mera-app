// The Feed tab's pages: Feed, Interests, Stories, in the reader's order
// (page-order.ts). The Feed page is keep-mounted in the pager (PAGE_META), so
// its reading session survives any swipe or reorder.

import InterestsPage from '@/components/custom/for-you/InterestsPage';
import FeedScreen from '@/components/custom/feed/FeedScreen';
import { PAGE_META } from '@/components/custom/nav/page-registry';
import TabPages from '@/components/custom/nav/TabPages';
import type { ArrangeConfig, PageDot, PagePill, PageRenderProps } from '@/components/custom/nav/types';
import TrackedStoriesScreen from '@/components/custom/tracked-stories/TrackedStoriesScreen';
import { setPageOrder, usePageOrder } from '@/lib/navigation/page-order';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

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

const ARRANGE: ArrangeConfig = {
  onSave: (draft) => setPageOrder('feed', draft.order),
};

export function FeedPages() {
  const { t } = useTranslation();
  const order = usePageOrder('feed');
  const pills: PagePill[] = useMemo(
    () =>
      order.map((id) => ({
        id,
        label: t(PAGE_META[id].labelKey),
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

  return <TabPages tab="feed" pages={pills} renderPage={renderPage} trailing="bell" arrange={ARRANGE} testID="feed-pages" />;
}

export default FeedPages;
