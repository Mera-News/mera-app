import VisitedPublicationsList from '@/components/custom/config-panel/VisitedPublicationsList';
import FactChecksPanel from '@/components/custom/fact-checks/FactChecksPanel';
import { pageMeta } from '@/components/custom/nav/page-registry';
import TabPages from '@/components/custom/nav/TabPages';
import type { PageDot, PagePill, PageRenderProps } from '@/components/custom/nav/types';
import SavedSuggestionsScreen from '@/components/custom/saved-suggestions/SavedSuggestionsScreen';
import { setTabDot } from '@/components/custom/nav/current-surface';
import { usePageOrder } from '@/lib/navigation/page-order';
import { useChecksUnseen, watchFactChecks } from '@/lib/stores/fact-checks-store';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import React, { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The Library tab: Saved, Fact checks, History (FinalLibrary), a fixed group.
 * Page ids stay `saved`, `checks`, `visited`; the Stats live under History.
 * Each page draws its own title row with the ?, as its list's first item.
 */
/** The Fact checks pill's dot: a check finished since the page was seen. */
function useChecksDot(): PageDot {
    return { visible: useChecksUnseen() };
}

export function LibraryPages() {
    // The Library tab is mounted for the app's life, so it keeps the fact
    // checks mirror live: a check finishing elsewhere lights both dots
    // (FinalLibrary #5); opening Fact checks clears them (markSeen).
    useEffect(() => watchFactChecks(), []);
    const checksUnseen = useChecksUnseen();
    useEffect(() => setTabDot('library', checksUnseen), [checksUnseen]);

    const { t } = useTranslation();
    const order = usePageOrder('library');
    const listEnd = useListEndClearance();

    const pills: PagePill[] = useMemo(
        () =>
            // ponytail: drops 'stats' until S1 removes it from the fixed order.
            order.filter((id) => id !== 'stats').map((id) => ({
                id,
                label: t(pageMeta(id).labelKey),
                useDot: id === 'checks' ? useChecksDot : undefined,
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
                            onExplain={header.openExplainer}
                        />
                    );
                case 'checks':
                    return (
                        <FactChecksPanel
                            active={active}
                            scrollHandler={header.scrollHandler}
                            headerHeight={header.headerHeight}
                            listEndPadding={listEnd}
                            onExplain={header.openExplainer}
                        />
                    );
                case 'visited':
                    return (
                        <VisitedPublicationsList
                            active={active}
                            scrollHandler={header.scrollHandler}
                            headerHeight={header.headerHeight}
                            listEndPadding={listEnd}
                            onExplain={header.openExplainer}
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
