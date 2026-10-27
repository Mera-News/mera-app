import ScopeArticleList, { /* EXPLORE_WINDOWS_HOURS, */ type ExploreWindowHours } from '@/components/custom/explore/ScopeArticleList';
// import InlineChoiceChip from '@/components/custom/nav/InlineChoiceChip';
import { PAGE_META, alpha2OfPage } from '@/components/custom/nav/page-registry';
import TabPages from '@/components/custom/nav/TabPages';
import type {
    ArrangeConfig,
    PagePill,
    PageRenderProps,
} from '@/components/custom/nav/types';
import { addWorldCountry, removeWorldCountry, useWorldPages } from '@/lib/explore/world-pages';
import { setWorldPageOrder } from '@/lib/navigation/page-order';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArticleService } from '@/lib/article-service';
import { effectivePick, topicLabel } from '@/lib/explore/topic-filter';
import type { CanonicalTopic, CanonicalTopicFacet } from '@/lib/generated/graphql-types';
import { useIsOnline } from '@/lib/stores/network-store';
import WorldTopicPill from './WorldTopicPill';
import { allCountryOptions, commitWorldDraft, searchCountryOptions } from './world-arrange';

const DEFAULT_WINDOW: ExploreWindowHours = 24;

/**
 * The World tab: World, then one page per country, in the reader's order
 * (`useWorldPages`, lib/explore/world-pages). Each page is a
 * `ScopeArticleList` (direct server-paginated top headlines, nothing scored
 * or stored). Every page shows the last 24 hours. The 6/12/24/48h window
 * chip (and the empty state's "Show 48 hours") is COMMENTED OUT, not deleted
 * (owner: liked, but buggy); restore the commented lines to bring it back, and
 * `world.explainer.window` in page-registry's explainers. The header title
 * reads "Top headlines" (owner), not "Explore".
 *
 * Arrange (a long press on a page name) adds a country through the overlay's
 * search, removes one with its ×, and reorders; nothing is written before ✓
 * (`commitWorldDraft`). The add search offers every country, saved pages
 * included: the overlay's draft filter hides what is still in the draft, so a
 * country × 'd in this draft can be found and brought back.
 * Removing a place-derived country only hides its page; the place stays.
 *
 * The search icon in the header opens the full-screen Search route, a root
 * push, so this tab stays mounted underneath and Cancel lands where it was.
 */
export function WorldPages() {
    const { t } = useTranslation();
    const { pages, loaded } = useWorldPages();
    const listEndClearance = useListEndClearance();
    const online = useIsOnline();

    // Topic filter. The pick is tab-session state only: never stored, never in a URL, never logged.
    const [pick, setPick] = useState<string | null>(null);
    const [topics, setTopics] = useState<readonly CanonicalTopic[]>([]);
    const [pageFacets, setPageFacets] = useState<Readonly<Record<string, readonly CanonicalTopicFacet[]>>>({});
    const [activeId, setActiveId] = useState<string | null>(null);
    const [latched, setLatched] = useState(false);
    useEffect(() => {
        let live = true;
        ArticleService.getCanonicalTopics().then(
            (r) => live && setTopics(r),
            () => live && setTopics([]),
        );
        return () => {
            live = false;
        };
    }, []);
    useEffect(() => {
        if (latched) setPick(null);
    }, [latched]);

    // Window chip off (owner): every page is DEFAULT_WINDOW. Restore with the chip below.
    // // Session-only, per page; a page keeps its window while warm in the pager.
    // const [windows, setWindows] = useState<Readonly<Record<string, ExploreWindowHours>>>({});
    // const setWindowFor = useCallback((pageId: string, hours: ExploreWindowHours) => {
    //     setWindows((prev) => (prev[pageId] === hours ? prev : { ...prev, [pageId]: hours }));
    // }, []);

    const pills: PagePill[] = useMemo(
        () =>
            pages.map((p) =>
                p.id === 'world'
                    ? { id: p.id, label: t(PAGE_META.world.labelKey), icon: 'public' as const }
                    : { id: p.id, label: p.scope.label, flagAlpha2: alpha2OfPage(p.id) ?? undefined },
            ),
        [pages, t],
    );

    const arrange: ArrangeConfig = useMemo(() => {
        const byId = new Map(pages.map((p) => [p.id as string, p]));
        return {
            onSave: (draft) =>
                commitWorldDraft(draft, {
                    addCountry: addWorldCountry,
                    removeCountry: removeWorldCountry,
                    saveOrder: setWorldPageOrder,
                }),
            search: (query) => searchCountryOptions(allCountryOptions(), query),
            footnoteFor: (id) => {
                const page = byId.get(id);
                return page?.origin === 'place'
                    ? t('world.arrange.placesNote', { country: page.scope.label })
                    : null;
            },
            removable: (id) => id !== 'world',
        };
    }, [pages, t]);

    const openSearch = useCallback(() => router.push('/logged-in/search'), []);

    const reportFacets = useCallback(
        (pageId: string) =>
            (facets: readonly CanonicalTopicFacet[], supported: boolean, active: boolean) => {
                if (!supported) return setLatched(true);
                setPageFacets((prev) => (prev[pageId] === facets ? prev : { ...prev, [pageId]: facets }));
                if (active) setActiveId(pageId);
            },
        [],
    );
    const pickTopic = topics.find((tp) => tp.id === pick);
    const pickName = pickTopic ? topicLabel(t, pickTopic) : null;

    const renderPage = useCallback(
        ({ pageId, active, header }: PageRenderProps) => {
            const page = pages.find((p) => p.id === pageId);
            if (!page) return null;
            const hours = DEFAULT_WINDOW; // windows[pageId] ?? DEFAULT_WINDOW;
            // A page not yet answered has no facets: ask with the pick as is.
            const facets = pageFacets[pageId];
            const topicId = facets ? effectivePick(pick, facets) : pick;
            return (
                <ScopeArticleList
                    // A window or topic change is a fresh list: new first page, cursor
                    // and generation. The pager keys the panel by page id.
                    key={`${hours}:${topicId ?? ''}`}
                    topicId={topicId}
                    pickLabel={pickName}
                    onFacets={reportFacets(pageId)}
                    scope={page.scope}
                    windowHours={hours}
                    // onWindowChange={(next) => setWindowFor(pageId, next)}
                    active={active}
                    // Gate the QUERY, not the mount: before locations emit, the
                    // country pages are the device-country fallback.
                    enabled={loaded}
                    headerHeight={header.headerHeight}
                    scrollHandler={header.scrollHandler}
                    bottomClearance={listEndClearance}
                />
            );
        },
        [pages, /* windows, setWindowFor, */ loaded, listEndClearance, pageFacets, pick, pickName, reportFacets],
    );

    // const renderTitleChip = useCallback(
    //     (pageId: string) => (
    //         <InlineChoiceChip
    //             options={EXPLORE_WINDOWS_HOURS}
    //             value={windows[pageId] ?? DEFAULT_WINDOW}
    //             labelOf={(h) => t(`explore.window.label${h}`)}
    //             a11yLabelOf={(h) => t(`explore.window.a11y${h}`)}
    //             onChange={(next) => setWindowFor(pageId, next)}
    //             testID="explore-window"
    //         />
    //     ),
    //     [windows, setWindowFor, t],
    // );

    const activeFacets = activeId ? pageFacets[activeId] : undefined;
    const showPill =
        online && !latched && topics.length > 0 && !!activeFacets && (activeFacets.some((f) => f.count > 0) || !!pick);

    return (
        <>
        <TabPages
            tab="world"
            pages={pills}
            renderPage={renderPage}
            onSearch={openSearch}
            arrange={arrange}
            title={t('sources.topHeadlines')}
            // renderTitleChip={renderTitleChip}
            testID="world-pages"
        />
        {showPill && activeFacets ? (
            <WorldTopicPill topics={topics} facets={activeFacets} pick={pick} onPick={setPick} />
        ) : null}
        </>
    );
}

export default WorldPages;
