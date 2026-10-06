import type { ExploreWindowHours } from '@/components/custom/explore/ExploreWindowToggle';
import ScopeArticleList from '@/components/custom/explore/ScopeArticleList';
import HowThisPageWorks from '@/components/custom/nav/HowThisPageWorks';
import { PAGE_META, alpha2OfPage } from '@/components/custom/nav/page-registry';
import TabPages from '@/components/custom/nav/TabPages';
import type {
    ArrangeConfig,
    ArrangeCountryOption,
    PagePill,
    PageRenderProps,
} from '@/components/custom/nav/types';
import { Text } from '@/components/ui/text';
import AccountService from '@/lib/account-service';
import {
    addWorldCountry,
    markWorldIntroDone,
    removeWorldCountry,
    useWorldIntroDone,
    useWorldPages,
} from '@/lib/explore/world-pages';
import { setPageOrder } from '@/lib/navigation/page-order';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { router } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { commitWorldDraft, searchCountryOptions, toCountryOptions } from './world-arrange';

const DEFAULT_WINDOW: ExploreWindowHours = 24;

/**
 * The World tab: World, then one page per country, in the reader's order
 * (`useWorldPages`, lib/explore/world-pages). Each page is a
 * `ScopeArticleList` (direct server-paginated top headlines, nothing scored
 * or stored) led by its own 6/12/24/48h window, session state per page.
 *
 * Arrange (the pen) adds a country through the overlay's search, removes one
 * with its ×, and reorders; nothing is written before ✓ (`commitWorldDraft`).
 * Removing a place-derived country only hides its page; the place stays.
 *
 * The search icon in the header opens the full-screen Search route, a root
 * push, so this tab stays mounted underneath and Cancel lands where it was.
 */
export function WorldPages() {
    const { t } = useTranslation();
    const { pages, loaded } = useWorldPages();
    const introDone = useWorldIntroDone();
    const listEndClearance = useListEndClearance();

    // Session-only, per page; a page keeps its window while warm in the pager.
    const [windows, setWindows] = useState<Readonly<Record<string, ExploreWindowHours>>>({});
    const setWindowFor = useCallback((pageId: string, hours: ExploreWindowHours) => {
        setWindows((prev) => (prev[pageId] === hours ? prev : { ...prev, [pageId]: hours }));
    }, []);

    const pills: PagePill[] = useMemo(
        () =>
            pages.map((p) =>
                p.id === 'world'
                    ? { id: p.id, label: t(PAGE_META.world.labelKey) }
                    : { id: p.id, label: p.scope.label, flagAlpha2: alpha2OfPage(p.id) ?? undefined },
            ),
        [pages, t],
    );

    // The add field's country list, fetched once the pen first opens (it is a
    // network call; offline it stays empty and the field finds nothing).
    const [countryOptions, setCountryOptions] = useState<ArrangeCountryOption[]>([]);
    const countriesRequested = useRef(false);
    const loadCountries = useCallback(() => {
        if (countriesRequested.current) return;
        countriesRequested.current = true;
        AccountService.getAllCountries()
            .then((codes) => setCountryOptions(toCountryOptions(codes)))
            .catch(() => {
                // AccountService already reported it; allow a retry next open.
                countriesRequested.current = false;
            });
    }, []);

    const arrange: ArrangeConfig = useMemo(() => {
        const present = new Set(pages.map((p) => alpha2OfPage(p.id)).filter((a): a is string => !!a));
        const byId = new Map(pages.map((p) => [p.id as string, p]));
        return {
            onOpen: () => {
                void markWorldIntroDone();
                loadCountries();
            },
            onSave: (draft) =>
                commitWorldDraft(draft, {
                    addCountry: addWorldCountry,
                    removeCountry: removeWorldCountry,
                    saveOrder: (ids) => setPageOrder('world', ids),
                }),
            world: {
                search: (query) => searchCountryOptions(countryOptions, query, present),
                footnoteFor: (id) => {
                    const page = byId.get(id);
                    return page?.origin === 'place'
                        ? t('world.arrange.placesNote', { country: page.scope.label })
                        : null;
                },
                removable: (id) => id !== 'world',
            },
        };
    }, [pages, countryOptions, loadCountries, t]);

    const trailing = useMemo(
        () => ({ kind: 'search' as const, onPress: () => router.push('/logged-in/search') }),
        [],
    );

    // World alone, and the pen never opened here: say what World is and
    // where countries come from. Derived; the only stored bit is "pen opened".
    const showIntro = pages.length === 1 && introDone === false;

    const renderPage = useCallback(
        ({ pageId, active, header }: PageRenderProps) => {
            const page = pages.find((p) => p.id === pageId);
            if (!page) return null;
            const hours = windows[pageId] ?? DEFAULT_WINDOW;
            return (
                <ScopeArticleList
                    // A window change is a fresh list: new first page, cursor
                    // and generation. The pager keys the panel by page id.
                    key={hours}
                    scope={page.scope}
                    windowHours={hours}
                    onWindowChange={(next) => setWindowFor(pageId, next)}
                    listHeaderExtra={
                        page.id === 'world' && showIntro ? (
                            <Text size="md" className="text-gray-300" testID="world-intro">
                                {t('world.newStateLine')}
                            </Text>
                        ) : undefined
                    }
                    active={active}
                    // Gate the QUERY, not the mount: before locations emit, the
                    // country pages are the device-country fallback.
                    enabled={loaded}
                    headerHeight={header.headerHeight}
                    scrollHandler={header.scrollHandler}
                    bottomClearance={listEndClearance}
                    // Country pages get World's copy (pageMeta).
                    footer={<HowThisPageWorks pageId={pageId} />}
                />
            );
        },
        [pages, windows, setWindowFor, showIntro, loaded, listEndClearance, t],
    );

    return (
        <TabPages
            tab="world"
            pages={pills}
            renderPage={renderPage}
            trailing={trailing}
            arrange={arrange}
            testID="world-pages"
        />
    );
}

export default WorldPages;
