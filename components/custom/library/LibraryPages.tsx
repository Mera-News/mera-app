import VisitedPublicationsList from '@/components/custom/config-panel/VisitedPublicationsList';
import FactChecksPanel from '@/components/custom/fact-checks/FactChecksPanel';
import { pageMeta } from '@/components/custom/nav/page-registry';
import TabPages from '@/components/custom/nav/TabPages';
import type { PageDot, PagePill, PageRenderProps } from '@/components/custom/nav/types';
import SavedSuggestionsScreen from '@/components/custom/saved-suggestions/SavedSuggestionsScreen';
import { usePageOrder } from '@/lib/navigation/page-order';
import { useChecksUnseen, watchFactChecks } from '@/lib/stores/fact-checks-store';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import StatsPage from '@/components/custom/library/StatsPage';
import NotificationsScreen from '@/components/custom/notifications/NotificationsScreen';
import { observeUnreadCount } from '@/lib/database/services/notification-service';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The Library tab: Saved, Fact checks, History, Stats, Notifications (the
 * inbox), a fixed group. Page ids `saved`, `checks`, `visited`, `stats`,
 * `notifications`.
 * The ? in the tab header opens the active page's explainer.
 */
/** Each page's icon on the track (outline MaterialIcons on both platforms). */
const ICONS: Readonly<Record<string, NonNullable<PagePill['icon']>>> = {
    saved: 'bookmark-border',
    checks: 'fact-check',
    visited: 'history',
    stats: 'bar-chart',
    notifications: 'notifications-none',
};

/** The Notifications pill's dot: lit while anything is unread. Seeing the
 *  page marks rows read, which clears it (and the Library tab dot). */
function useNotificationsDot(): PageDot {
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        const sub = observeUnreadCount().subscribe((n) => setVisible(n > 0));
        return () => sub.unsubscribe();
    }, []);
    return { visible };
}

/** The Fact checks pill's dot: a check finished since the page was seen. */
function useChecksDot(): PageDot {
    return { visible: useChecksUnseen() };
}

export function LibraryPages() {
    // The Library tab is mounted for the app's life, so it keeps the fact
    // checks mirror live: a check finishing elsewhere lights both dots
    // (FinalLibrary #5); opening Fact checks clears them (markSeen). The tab
    // dot itself is the tab layout's (fact checks OR unread notices).
    useEffect(() => watchFactChecks(), []);

    const { t } = useTranslation();
    const order = usePageOrder('library');
    const listEnd = useListEndClearance();

    const pills: PagePill[] = useMemo(
        () =>
            order.map((id) => ({
                id,
                label: t(pageMeta(id).labelKey),
                icon: ICONS[id],
                useDot: id === 'checks' ? useChecksDot : id === 'notifications' ? useNotificationsDot : undefined,
            })),
        [order, t],
    );

    const renderPage = useCallback(
        ({ pageId, active, header }: PageRenderProps) => {
            switch (pageId) {
                case 'saved':
                    return (
                        <SavedSuggestionsScreen
                            active={active}
                            scrollHandler={header.scrollHandler}
                            headerHeight={header.headerHeight}
                            hidden={header.hidden}
                            listEndPadding={listEnd}
                        />
                    );
                case 'checks':
                    return (
                        <FactChecksPanel
                            active={active}
                            scrollHandler={header.scrollHandler}
                            headerHeight={header.headerHeight}
                            listEndPadding={listEnd}
                        />
                    );
                case 'visited':
                    return (
                        <VisitedPublicationsList
                            active={active}
                            scrollHandler={header.scrollHandler}
                            headerHeight={header.headerHeight}
                            listEndPadding={listEnd}
                        />
                    );
                case 'stats':
                    return (
                        <StatsPage
                            active={active}
                            scrollHandler={header.scrollHandler}
                            headerHeight={header.headerHeight}
                            listEndPadding={listEnd}
                        />
                    );
                case 'notifications':
                    return <NotificationsScreen header={header} active={active} />;
                default:
                    return null;
            }
        },
        [listEnd],
    );

    return (
        <TabPages
            tab="library"
            namesFirst
            pages={pills}
            renderPage={renderPage}
            testID="library-pages"
        />
    );
}

export default LibraryPages;
