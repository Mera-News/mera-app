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
import logger from '@/lib/logger';
import { useIsConnected } from '@/lib/stores/network-store';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
    // device-country fallback. Rendering the list then would flash the wrong
    // country and burn a server round-trip, because the real locations landing
    // changes `scopes[0].id` and ScopeArticleList is keyed on it. Never reset:
    // once loaded, refocusing must not unmount/refetch the list.
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

    const handleSelect = (scope: ExploreScope) => {
        setSelectedId(scope.id);
        setSetting(LAST_SCOPE_KEY, scope.id).catch((err: unknown) => {
            logger.captureException(err, {
                tags: { component: 'ExploreScreen', method: 'persistScope' },
            });
        });
    };

    return (
        <Box className="flex-1 bg-black" style={{ paddingTop: insets.top + 16 }}>
                {/* Header — title + a right-slot Sources button (mirrors the
                    Dashboard's circular outline icon-button pattern). */}
                <HStack className="items-center justify-between px-5 mb-2">
                    <Heading size="3xl" className="text-white flex-shrink mr-3" numberOfLines={1}>
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
                    empty state, not a hard error, on fetch failure. */}
                {!isConnected && (
                    <HStack className="items-center bg-warning-900 rounded-lg px-3 py-2 mx-5 mb-2" space="sm">
                        <Icon as={AlertCircleIcon} size="sm" className="text-warning-400" />
                        <Text size="sm" className="text-warning-400">{t('explore.offlineUnavailable')}</Text>
                    </HStack>
                )}

                {/* Scope chips */}
                <Box className="mb-2">
                    <ScopeChipRow scopes={scopes} selectedId={selectedScope.id} onSelect={handleSelect} />
                </Box>

                {/* Article list for the active scope — remounts on scope switch.
                    Held back until the locations observable has emitted, so the
                    first mount lands on the real primary country rather than the
                    device-country fallback (which would remount + refetch). */}
                <Box className="flex-1">
                    {locationsLoaded ? (
                        <ScopeArticleList key={selectedScope.id} scope={selectedScope} />
                    ) : null}
                </Box>
            </Box>
    );
};

export default ExploreScreen;
