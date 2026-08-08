import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import {
    GlassPlate,
    GLASS_AVAILABLE,
    GLASS_HEADER_SCRIM,
    GLASS_HEADER_TINT,
} from '@/components/custom/GlassSurface';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { setSetting } from '@/lib/database/services/setting-service';
import { observeAll as observeAllLocations } from '@/lib/database/services/location-service';
import { getBrowseCountries, removeBrowseCountry } from '@/lib/explore/browse-countries';
import { getDeviceCountryAlpha2 } from '@/lib/explore/device-country';
import {
    alpha2ToAlpha3,
    deriveExploreScopes,
    electPrimaryCountry,
    type ExploreScope,
    type ScopeLocationInput,
} from '@/lib/explore/scopes';
import { addSuppressedScopeId, getSuppressedScopeIds } from '@/lib/explore/suppressed-scopes';
import { useCollapsibleHeader } from '@/lib/hooks/use-collapsible-header';
import { useOpenArticle } from '@/lib/hooks/use-open-article';
import logger from '@/lib/logger';
import type { NewsSearchHit } from '@/lib/generated/graphql-types';
import { useNewsSearch } from '@/lib/news-search/use-news-search';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ExploreSearchBar from './ExploreSearchBar';
import ExploreSearchResults from './ExploreSearchResults';
import ScopeArticleList from './ScopeArticleList';
import ScopeChipRow from './ScopeChipRow';

/** Persisted last-selected scope id (setting-service KV — same store as other flags). */
const LAST_SCOPE_KEY = 'explore_last_scope';

/**
 * Explore tab (Wave 10, N5; geo-derivation wave deleted the Top stories chip).
 * Scope chips derived from the user's on-device locations + device country
 * plus the browse-country set (see lib/explore/scopes,
 * lib/explore/browse-countries), ordered `[World, primary country, …
 * location-derived, … browse-added]`, minus anything the user long-pressed to
 * hide (lib/explore/suppressed-scopes). Every scope is a DIRECT
 * server-paginated `topHeadlinesForCountry` query (ScopeArticleList) — no
 * article_suggestions, no scoring, no LLM, nothing persisted. Compact cards
 * only.
 *
 * Sources management lives in Profile → Advanced and via the trailing "+"
 * chip in ScopeChipRow, which opens `/logged-in/sources` directly. Adding a
 * country there is browse-only — it no longer creates a persona Location or
 * touches geo relevance scoring (Item 7, decoupling wave). The header itself
 * carries just the title; there is no header Sources button or bell — a
 * previous doc comment here claimed one was already removed, but the button
 * was still live until this wave deleted it as a duplicate of the "+" chip.
 * The floating Mera bubble is not rendered on this screen.
 *
 * Item 12a — a search bar sits above the chips (`ExploreSearchBar`), backed by
 * `lib/news-search/use-news-search.ts` (debounce + min-length gate + fetch —
 * see that file for the state machine). While a search is active
 * (non-empty query) `ExploreSearchResults` renders as an OVERLAY on top of the
 * scope list rather than replacing it: the chips and `ScopeArticleList` stay
 * mounted with unchanged props the whole time, so clearing the query needs no
 * special-case restore — the underlying screen was simply never touched.
 */
const ExploreScreen: React.FC = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();

    // Collapsing header (hides on scroll-down, reveals on scroll-up) — shared
    // with the Feed/Dashboard tabs.
    const { scrollHandler, headerStyle, onHeaderLayout, headerHeight, reveal } =
        useCollapsibleHeader();

    // Item 12a — search bar. See the class doc comment above; all state lives
    // in the hook, this screen just wires it to the input and the overlay.
    const search = useNewsSearch();
    const openArticle = useOpenArticle();
    const handlePressSearchResult = useCallback(
        (hit: NewsSearchHit) => {
            openArticle({ articleId: hit._id });
        },
        [openArticle],
    );

    const [locations, setLocations] = useState<ScopeLocationInput[]>([]);
    // Cold-mount opens on the FIRST chip, which is World; the persisted
    // LAST_SCOPE_KEY is intentionally not read for the initial selection (taps
    // still persist below, for potential future use). Still starts null and is
    // still gated on `locationsLoaded`: the country chips behind World are
    // data-dependent, and resolving the selection before they land would let
    // the snap-back effect below re-key the list mid-load.
    const [selectedId, setSelectedId] = useState<string | null>(null);
    // Has `observeAllLocations()` emitted at least once? It emits ASYNCHRONOUSLY
    // on focus, so the first render has `locations === []` and `scopes` is the
    // device-country fallback. FETCHING then would flash the wrong country and
    // burn a server round-trip, because the real locations landing changes
    // `scopes[0].id` and ScopeArticleList is keyed on it. Never reset: once
    // loaded, refocusing must not refetch the list.
    //
    // This gates the QUERY (`enabled` below), not the MOUNT. The list has to be
    // on screen from the very first commit or react-native-screens' one-shot
    // first-descendant scroll-view search misses it — see ScopeArticleList.
    const [locationsLoaded, setLocationsLoaded] = useState(false);

    // Device country is stable for the session.
    const deviceCountry = useMemo(() => getDeviceCountryAlpha2(), []);

    // Reactive locations (weight-desc). Explore is the first UI consumer.
    // Focus-gated: tabs stay mounted, so this WatermelonDB observable would
    // otherwise stay live forever once mounted, even while the tab is blurred.
    // Unsubscribes on blur and resubscribes on focus, preserving current
    // on-focus behavior.
    useFocusEffect(
        useCallback(() => {
            const sub = observeAllLocations().subscribe((rows) => {
                setLocations(
                    rows.map((l) => ({
                        city: l.city,
                        region: l.region,
                        countryCode: l.countryCode,
                        role: l.role,
                        weight: l.weight,
                    })),
                );
                setLocationsLoaded(true);
            });
            return () => sub.unsubscribe();
        }, []),
    );

    // Browse countries (Item 7) + suppressed scope ids (Item 18) — both a
    // plain setting-service KV row, neither observable, so both are re-read on
    // focus rather than subscribed. This is what makes a country added on the
    // Sources screen (or a chip hidden here) show up on return to this tab.
    const [browseCountries, setBrowseCountries] = useState<string[]>([]);
    const [suppressedIds, setSuppressedIds] = useState<Set<string>>(new Set());
    useFocusEffect(
        useCallback(() => {
            let cancelled = false;
            Promise.all([getBrowseCountries(), getSuppressedScopeIds()])
                .then(([browse, suppressed]) => {
                    if (cancelled) return;
                    setBrowseCountries(browse);
                    setSuppressedIds(new Set(suppressed));
                })
                .catch((err: unknown) => {
                    logger.captureException(err, {
                        tags: { component: 'ExploreScreen', method: 'loadBrowseAndSuppressed' },
                    });
                });
            return () => {
                cancelled = true;
            };
        }, []),
    );

    const rawScopes = useMemo(
        () => deriveExploreScopes(locations, deviceCountry, browseCountries),
        [locations, deviceCountry, browseCountries],
    );
    // World can never be hidden; every other scope is dropped once its id
    // lands in the suppressed set (a long-pressed location-derived chip —
    // browse-added chips are removed outright from `browseCountries` instead
    // and never reach this filter).
    const scopes = useMemo(
        () => rawScopes.filter((s) => s.kind === 'world' || !suppressedIds.has(s.id)),
        [rawScopes, suppressedIds],
    );

    // Which country alpha-3 codes are location-derived (primary + every
    // location), independent of the browse set — used by handleRemoveScope to
    // decide whether a "×" tap should suppress (location-derived) or delete
    // from the browse set (browse-added). A country present in BOTH resolves
    // as location-derived: that is the representation the visible chip
    // actually carries (deriveExploreScopes dedupes the browse copy out).
    const locationAlpha3s = useMemo(() => {
        const set = new Set<string>();
        const primary = electPrimaryCountry(locations, deviceCountry);
        if (primary?.countryCodeAlpha3) set.add(primary.countryCodeAlpha3);
        for (const loc of locations) {
            const a3 = alpha2ToAlpha3(loc.countryCode);
            if (a3) set.add(a3);
        }
        return set;
    }, [locations, deviceCountry]);

    // Resolve the active scope: the selected id when still available,
    // otherwise the first scope (the primary country).
    const selectedScope: ExploreScope =
        scopes.find((s) => s.id === selectedId) ?? scopes[0];

    // Two jobs, both gated on locationsLoaded so neither can fire against the
    // pre-emission device-country fallback:
    //   • resolve the initial (null) selection to the first chip;
    //   • snap back to the first chip when the selection stops existing (e.g. a
    //     location was removed).
    // On the render where locationsLoaded flips true, selectedId is still null,
    // so selectedScope is ALREADY scopes[0] — this effect then writes that same
    // id, leaving ScopeArticleList's key unchanged. Hence exactly one mount.
    useEffect(() => {
        if (!locationsLoaded) return;
        if (selectedId !== null && scopes.some((s) => s.id === selectedId)) return;
        setSelectedId(scopes[0]?.id ?? 'world');
    }, [scopes, selectedId, locationsLoaded]);

    // Always reveal the collapsing header on a scope switch — whether from an
    // explicit chip tap (handleSelect) or the snap-back effect above (the
    // selected scope disappeared, e.g. a location was removed). The list below
    // remounts on `selectedScope.id` regardless of which path changed it, so
    // this tracks that same id rather than duplicating a reveal() call in both
    // triggers (mirrors ForYouScreen's sub-tab-switch reveal()).
    const previousScopeIdRef = useRef<string | null>(null);
    useEffect(() => {
        if (
            previousScopeIdRef.current !== null &&
            previousScopeIdRef.current !== selectedScope.id
        ) {
            reveal();
        }
        previousScopeIdRef.current = selectedScope.id;
    }, [selectedScope.id, reveal]);

    const handleSelect = (scope: ExploreScope) => {
        setSelectedId(scope.id);
        setSetting(LAST_SCOPE_KEY, scope.id).catch((err: unknown) => {
            logger.captureException(err, {
                tags: { component: 'ExploreScreen', method: 'persistScope' },
            });
        });
    };

    // Item 18 — long-press-then-"×" chip removal. World is filtered out of
    // `scopes`'s hideable set already (ScopeChipRow also never offers a "×"
    // for it), so this only ever sees a `country` scope in practice.
    const handleRemoveScope = useCallback(
        (scope: ExploreScope) => {
            if (scope.kind !== 'country' || !scope.countryCodeAlpha3) return;

            if (locationAlpha3s.has(scope.countryCodeAlpha3)) {
                // Location-derived: hide the chip, but the location — and the
                // geo-scoring signal it feeds — stays exactly as it was.
                setSuppressedIds((prev) => new Set(prev).add(scope.id));
                addSuppressedScopeId(scope.id).catch((err: unknown) => {
                    logger.captureException(err, {
                        tags: { component: 'ExploreScreen', method: 'suppressScope' },
                    });
                });
                return;
            }

            if (scope.countryCodeAlpha2) {
                // Browse-added: drop it from the browse set outright — there
                // is no location/signal underneath it to preserve.
                const code = scope.countryCodeAlpha2.toUpperCase();
                setBrowseCountries((prev) => prev.filter((c) => c !== code));
                removeBrowseCountry(code).catch((err: unknown) => {
                    logger.captureException(err, {
                        tags: { component: 'ExploreScreen', method: 'removeBrowseCountry' },
                    });
                });
            }
        },
        [locationAlpha3s],
    );

    return (
        // ROOT IS UNPADDED ON PURPOSE. A padding here would inset the scroll
        // view itself and fight the `contentInsetAdjustmentBehavior: automatic`
        // that this whole layout exists to enable. Safe-area handling lives on
        // the header overlay (which is outside the scroll view, so `insets.top`
        // is unconditionally correct there) and on the list's content inset.
        // No `bg-black`: the AbstractGradientBackdrop below is the page background.
        <Box className="flex-1">
            {/* App-wide tab background. Must be the FIRST child so it paints
                behind everything else on the page. */}
            <AbstractGradientBackdrop />

            {/* ── THE LIST MUST STAY THE FIRST CHILD ──
                react-native-screens finds a tab's scroll view by walking
                `subviews[0]` from the tab screen, once, at mount. Anything
                rendered before this list wins that walk instead — and the header
                below contains ScopeChipRow, which is ITSELF a horizontal
                FlatList, so reordering would not merely break the search, it
                would silently register the CHIP ROW as the tab's scroll view.
                Chrome goes after the list, absolutely positioned, exactly the
                way FeedScreen does it. */}
            <ScopeArticleList
                key={selectedScope.id}
                scope={selectedScope}
                // Gate the QUERY, not the mount: fetching before the locations
                // observable has emitted would hit the device-country fallback,
                // and the real locations landing re-keys this component — a
                // wasted round-trip plus a flash of the wrong country.
                enabled={locationsLoaded}
                // Measured height of the pinned header overlay below — the
                // list's content top padding is derived from it rather than
                // hardcoded — the header grows and shrinks (the offline banner
                // appears/disappears, chip labels wrap), and a fixed number
                // would hide the first article behind the chips.
                headerHeight={headerHeight}
                // Collapsible-header worklet — composed with the list's own
                // scroll-tick handler inside ScopeArticleList.
                scrollHandler={scrollHandler}
            />

            {/* Pinned header overlay — title, offline banner, scope chips.
                This sits ON TOP of the list, and the chip row's
                own wrapper has no background, so the overlay needs an opaque
                or glass backing or article rows scroll visibly through the
                chips. On iOS 26+ that backing is real Liquid Glass (GlassPlate);
                everywhere else it falls back to opaque `bg-black`, since
                GlassView paints nothing pre-26/off-iOS. The outer view is
                UNPADDED — GlassPlate is an absolute fill and needs an unpadded
                parent so its insets resolve against the full header, not just
                the content box inside the padding (see GlassSurface.tsx) — the
                safe-area/16pt padding lives on the inner box instead.

                Animated.View (not Box/plain View), driven by the collapsible-
                header hook — translates up on scroll-down and back on
                scroll-up / reveal(), same as FeedScreen/ForYouScreen.
                `className` is dropped in favor of inline style: NativeWind
                does not apply its cssInterop to `Animated.View` here (neither
                template screen uses className on this node either), so the
                GLASS_EDGE border and bg-black fallback both move into the
                style object below. */}
            <Animated.View
                testID="explore-header"
                onLayout={onHeaderLayout}
                // box-none: the absolute header must not swallow the
                // top-of-list pull-to-refresh gesture — touches pass through
                // its empty area to the list beneath, while its interactive
                // children (the chips) still receive taps. Same requirement
                // documented at ForYouScreen.tsx:519-536.
                pointerEvents="box-none"
                style={[
                    {
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        zIndex: 10,
                        overflow: 'hidden',
                        ...(GLASS_AVAILABLE
                            ? {
                                  // The scrim paints BEHIND the plate, which is
                                  // what the glass samples — that is what cuts
                                  // the see-through. The white/10 border
                                  // reproduces the old GLASS_EDGE class.
                                  backgroundColor: GLASS_HEADER_SCRIM,
                                  borderWidth: StyleSheet.hairlineWidth,
                                  borderColor: 'rgba(255,255,255,0.10)',
                              }
                            : { backgroundColor: '#000000' }),
                    },
                    headerStyle,
                ]}
            >
                <GlassPlate tint={GLASS_HEADER_TINT} />
                <Box pointerEvents="box-none" style={{ paddingTop: insets.top + 16 }}>
                    {/* Header — title only. It used to also carry a right-slot
                        Sources button, but ScopeChipRow's trailing "+" chip now
                        opens `/logged-in/sources` too — the two were exact
                        duplicates once the "+" stopped going to /locations
                        (Item 7), so this one was deleted rather than kept as a
                        second way to reach the same screen. */}
                    <HStack className="items-center justify-between px-5 mb-2" pointerEvents="box-none">
                        <Heading
                            size="4xl"
                            className="text-white flex-shrink mr-3"
                                                        pointerEvents="none"
                        >
                            {t('explore.title')}
                        </Heading>
                    </HStack>

                    {/* Item 12a — search bar, above the scope chips. Not
                        box-none: it's a real Input and must take its own
                        touches directly. */}
                    <ExploreSearchBar
                        query={search.query}
                        onChangeQuery={search.setQuery}
                        onClear={search.clear}
                    />

                    {/* The offline notice that used to sit here MOVED into
                        ScopeArticleList's empty state. It answers a different
                        question from the global OfflineBanner — "why is this list
                        empty?" rather than "can Mera reach the server?" — and it
                        answers it better in the place the emptiness actually
                        appears. Keeping it here stacked two identical warning
                        bands a few pixels apart. */}

                    {/* Scope chips — box-none: the row is a full-width band and
                        must not swallow a pull; only the chips themselves (and
                        ScopeChipRow's own FlatList) take touches. */}
                    <Box className="mb-2" pointerEvents="box-none">
                        <ScopeChipRow
                            scopes={scopes}
                            selectedId={selectedScope.id}
                            onSelect={handleSelect}
                            onRemove={handleRemoveScope}
                        />
                    </Box>
                </Box>
            </Animated.View>

            {/* Item 12a — search results overlay. Rendered only while a
                search is active (non-empty query), on top of ScopeArticleList
                but BELOW the header (zIndex 10, so the input/chips above stay
                interactive) — an overlay rather than a swap so the list and
                chips underneath are never unmounted, re-keyed or re-fetched.
                Clearing the query un-mounts this and reveals the untouched
                scope list exactly as it was. `top: headerHeight` starts it
                right under the pinned header; `bg-black` makes it fully opaque
                so the covered list never shows through. */}
            {search.isActive ? (
                <Box
                    testID="explore-search-overlay"
                    className="bg-black"
                    style={{
                        position: 'absolute',
                        top: headerHeight,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        zIndex: 5,
                    }}
                >
                    <ExploreSearchResults
                        status={search.status}
                        hits={search.hits}
                        errorKind={search.errorKind}
                        onPressHit={handlePressSearchResult}
                        onRetry={search.retry}
                    />
                </Box>
            ) : null}
        </Box>
    );
};

export default ExploreScreen;
