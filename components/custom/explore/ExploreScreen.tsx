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
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { setSetting } from '@/lib/database/services/setting-service';
import { observeAll as observeAllLocations } from '@/lib/database/services/location-service';
import { getDeviceCountryAlpha2 } from '@/lib/explore/device-country';
import { deriveExploreScopes, type ExploreScope, type ScopeLocationInput } from '@/lib/explore/scopes';
import { useCollapsibleHeader } from '@/lib/hooks/use-collapsible-header';
import logger from '@/lib/logger';
import { useIsConnected } from '@/lib/stores/network-store';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ScopeArticleList from './ScopeArticleList';
import ScopeChipRow from './ScopeChipRow';

/** Persisted last-selected scope id (setting-service KV — same store as other flags). */
const LAST_SCOPE_KEY = 'explore_last_scope';

/**
 * Explore tab (Wave 10, N5; geo-derivation wave deleted the Top stories chip).
 * Scope chips derived from the user's on-device locations + device country
 * (see lib/explore/scopes), ordered `[primary country, …, World]`. Every scope
 * is a DIRECT server-paginated `topHeadlinesForCountry` query
 * (ScopeArticleList) — no article_suggestions, no scoring, no LLM, nothing
 * persisted. Compact cards only.
 *
 * Sources management now lives in Profile (app-rethink wave) — the header
 * Sources action, the FAB, and the bottom sheet are removed; the header slot
 * they occupied now hosts the notification bell. The floating Mera bubble is
 * not rendered on this screen.
 */
const ExploreScreen: React.FC = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const isConnected = useIsConnected();

    // Collapsing header (hides on scroll-down, reveals on scroll-up) — shared
    // with the Feed/Dashboard tabs.
    const { scrollHandler, headerStyle, onHeaderLayout, headerHeight, reveal } =
        useCollapsibleHeader();

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

    const scopes = useMemo(
        () => deriveExploreScopes(locations, deviceCountry),
        [locations, deviceCountry],
    );

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

            {/* Pinned header overlay — title + Sources button, offline banner,
                scope chips. This sits ON TOP of the list, and the chip row's
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
                // children (the Sources button, the chips) still receive taps.
                // Same requirement documented at ForYouScreen.tsx:519-536.
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
                    {/* Header — title + a right-slot Sources button (mirrors the
                        Dashboard's circular outline icon-button pattern). */}
                    <HStack className="items-center justify-between px-5 mb-2" pointerEvents="box-none">
                        <Heading
                            size="3xl"
                            className="text-white flex-shrink mr-3"
                            numberOfLines={1}
                            pointerEvents="none"
                        >
                            {t('explore.title')}
                        </Heading>
                        <Pressable
                            onPress={() => router.push('/logged-in/sources')}
                            hitSlop={12}
                            accessibilityRole="button"
                            accessibilityLabel={t('settings.sources')}
                            className="p-3 rounded-full border border-primary-500 bg-transparent flex-shrink-0"
                        >
                            <MaterialIcons name="newspaper" size={22} color="#EDA77E" />
                        </Pressable>
                    </HStack>

                    {/* Offline banner — Explore is direct server-paginated (no local
                        cache), so an offline visit here would otherwise just look
                        like a jarring generic "no articles found" empty state from
                        ScopeArticleList. This makes the reason explicit and
                        non-blocking; that list already falls back to its friendly
                        empty state, not a hard error, on fetch failure. Purely
                        decorative — pointerEvents="none" so a pull can start on it. */}
                    {!isConnected && (
                        <HStack
                            className="items-center bg-warning-900 rounded-lg px-3 py-2 mx-5 mb-2"
                            space="sm"
                            pointerEvents="none"
                        >
                            <Icon as={AlertCircleIcon} size="sm" className="text-warning-400" />
                            <Text size="sm" className="text-warning-400">{t('explore.offlineUnavailable')}</Text>
                        </HStack>
                    )}

                    {/* Scope chips — box-none: the row is a full-width band and
                        must not swallow a pull; only the chips themselves (and
                        ScopeChipRow's own FlatList) take touches. */}
                    <Box className="mb-2" pointerEvents="box-none">
                        <ScopeChipRow scopes={scopes} selectedId={selectedScope.id} onSelect={handleSelect} />
                    </Box>
                </Box>
            </Animated.View>
        </Box>
    );
};

export default ExploreScreen;
