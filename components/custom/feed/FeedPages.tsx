// The Feed tab's pages, everything new for the reader: Feed (two views,
// FeedPage), Stories and Notifications (the inbox), a fixed group (only World
// is arranged). The track is icon-only with the selected page's name
// (`iconsOnly`), whatever the width. The Feed page is keep-mounted in the pager (PAGE_META), so
// its reading session survives any swipe or reorder.
//
// The status icon sits in the header's leading slot on every page of the tab;
// a tap brings the Feed page forward, reveals the header and opens the ONE
// counts card in the Feed page's header accessory (feed-status-card.ts).

import FeedStatusIcon from '@/components/custom/for-you/FeedStatusIcon';
import { tapStatusIcon } from '@/components/custom/for-you/feed-status-card';
import { navigateToPage } from '@/components/custom/nav/navigate-to-page';
import { useCurrentSurfaceStore } from '@/components/custom/nav/current-surface';
import FeedPage from '@/components/custom/feed/FeedPage';
import FeedHeaderAccessory from '@/components/custom/feed/FeedHeaderAccessory';
import { PAGE_META } from '@/components/custom/nav/page-registry';
import TabPages from '@/components/custom/nav/TabPages';
import type { PageDot, PagePill, PageRenderProps } from '@/components/custom/nav/types';
import type { PageId } from '@/components/custom/nav/page-registry';
import TrackedStoriesScreen from '@/components/custom/tracked-stories/TrackedStoriesScreen';
import { setTabDot } from '@/components/custom/nav/current-surface';
import { usePageOrder } from '@/lib/navigation/page-order';
import { buildFeedList } from '@/lib/stores/feed-list-selector';
import { useForYouSuggestions } from '@/lib/stores/selectors';
import { useIsFocused } from '@react-navigation/native';
import NotificationsScreen from '@/components/custom/notifications/NotificationsScreen';
import { observeUnreadCount } from '@/lib/database/services/notification-service';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

const NO_EXCLUSIONS: Set<string> = new Set();

/** Each page's icon on the (icon-only) track. */
const ICONS: Readonly<Record<string, NonNullable<PagePill['icon']>>> = {
  feed: 'article',
  stories: 'layers',
  notifications: 'notifications-none',
};

/** The Notifications pill's dot: lit while anything is unread. Seeing the
 *  page marks rows read, which clears it (and the Feed tab dot's share). */
function useNotificationsDot(): PageDot {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const sub = observeUnreadCount().subscribe((n) => setVisible(n > 0));
    return () => sub.unsubscribe();
  }, []);
  return { visible };
}

/**
 * The Feed tab's dot (FinalFeed #13): the reader left while the Feed was still
 * empty, and its first stories landed while they were elsewhere. Keyed on the
 * candidate pool (the store, which fills without focus), not on the list,
 * which ingests only while active. Cleared on opening the tab. Counted only
 * while the tab is unfocused, so the Feed's own render pays nothing.
 */
function useFeedTabDot(): void {
  const focused = useIsFocused();
  const suggestions = useForYouSuggestions();
  const emptyAtLeave = useRef<boolean | null>(null);
  useEffect(() => {
    if (!focused) return;
    setTabDot('feed', false);
    emptyAtLeave.current = null;
  }, [focused]);
  useEffect(() => {
    if (focused) return;
    const empty =
      buildFeedList(suggestions, NO_EXCLUSIONS, Date.now(), null, { includeReasonPending: true }).length === 0;
    if (emptyAtLeave.current === null) emptyAtLeave.current = empty;
    else if (emptyAtLeave.current && !empty) setTabDot('feed', true);
  }, [focused, suggestions]);
}

export function FeedPages() {
  useFeedTabDot();
  const { t } = useTranslation();
  const order = usePageOrder('feed');
  const pills: PagePill[] = useMemo(
    () =>
      order.map((id) => ({
        id,
        label: t(PAGE_META[id].labelKey),
        icon: ICONS[id],
        // Feed's own pill has no dot: no on-device "new since seen" signal
        // exists for it outside the list (the tab dot covers its first stories).
        useDot: id === 'stories' ? useStoriesDot : id === 'notifications' ? useNotificationsDot : undefined,
      })),
    [order, t],
  );

  const renderPage = useCallback(({ pageId, active, header }: PageRenderProps) => {
    switch (pageId) {
      case 'feed':
        return <FeedPage active={active} header={header} />;
      case 'stories':
        return (
          <TrackedStoriesScreen
            active={active}
            scrollHandler={header.scrollHandler}
            headerHeight={header.headerHeight}
          />
        );
      case 'notifications':
        return <NotificationsScreen header={header} active={active} />;
      default:
        return null;
    }
  }, [t]);

  const onStatus = useCallback(() => {
    // From Stories, bring the Feed page forward first; the card lives there.
    if (useCurrentSurfaceStore.getState().surface !== 'feed') navigateToPage('feed');
    tapStatusIcon();
  }, []);
  const leading = useMemo(() => <FeedStatusIcon onPress={onStatus} />, [onStatus]);
  // The Feed page's View chip and counts card ride in the header.
  const renderAccessory = useCallback((pageId: PageId) => (pageId === 'feed' ? <FeedHeaderAccessory /> : null), []);

  return (
    <View style={{ flex: 1 }}>
      <TabPages
        tab="feed"
        pages={pills}
        renderPage={renderPage}
        leading={leading}
        renderAccessory={renderAccessory}
        iconsOnly
        testID="feed-pages"
      />
    </View>
  );
}

export default FeedPages;
