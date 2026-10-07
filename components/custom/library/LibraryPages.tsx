import VisitedPublicationsList from '@/components/custom/config-panel/VisitedPublicationsList';
import FactChecksPanel from '@/components/custom/fact-checks/FactChecksPanel';
import HowThisPageWorks from '@/components/custom/nav/HowThisPageWorks';
import { pageMeta } from '@/components/custom/nav/page-registry';
import TabPages from '@/components/custom/nav/TabPages';
import type { PagePill, PageRenderProps } from '@/components/custom/nav/types';
import SavedSuggestionsScreen from '@/components/custom/saved-suggestions/SavedSuggestionsScreen';
import StatsPage from '@/components/custom/share-stats/StatsPage';
import { usePageOrder } from '@/lib/navigation/page-order';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The Library tab: Saved, Checks, Visited and Stats, a fixed group (only World
 * is arranged).
 *
 * Each page is the existing screen, handed the tab's one collapsing header
 * (scroll handler, height, and for Saved's pinned export row the hidden
 * value), the list-end clearance for the tab bar and the Mera button, and the
 * "How this page works" row as its list footer. Stats takes the one-shot
 * `card` arrival param (the old share-stats deep link).
 */
export function LibraryPages() {
    const { t } = useTranslation();
    const order = usePageOrder('library');
    const listEnd = useListEndClearance();

    const pills: PagePill[] = useMemo(
        () => order.map((id) => ({ id, label: t(pageMeta(id).labelKey) })),
        [order, t],
    );

    const renderPage = useCallback(
        ({ pageId, active, header, params }: PageRenderProps) => {
            const footer = <HowThisPageWorks pageId={pageId} />;
            switch (pageId) {
                case 'saved':
                    return (
                        <SavedSuggestionsScreen
                            active={active}
                            scrollHandler={header.scrollHandler}
                            headerHeight={header.headerHeight}
                            hidden={header.hidden}
                            listEndPadding={listEnd}
                            footer={footer}
                        />
                    );
                case 'checks':
                    return (
                        <FactChecksPanel
                            active={active}
                            scrollHandler={header.scrollHandler}
                            headerHeight={header.headerHeight}
                            listEndPadding={listEnd}
                            footer={footer}
                        />
                    );
                case 'visited':
                    return (
                        <VisitedPublicationsList
                            active={active}
                            scrollHandler={header.scrollHandler}
                            headerHeight={header.headerHeight}
                            listEndPadding={listEnd}
                            footer={footer}
                        />
                    );
                case 'stats':
                    return (
                        <StatsPage
                            active={active}
                            scrollHandler={header.scrollHandler}
                            headerHeight={header.headerHeight}
                            listEndPadding={listEnd}
                            requestedCard={params?.card}
                            footer={footer}
                        />
                    );
                default:
                    return null;
            }
        },
        [listEnd],
    );

    return (
        <TabPages
            tab="library"
            pages={pills}
            renderPage={renderPage}
            testID="library-pages"
        />
    );
}

export default LibraryPages;
