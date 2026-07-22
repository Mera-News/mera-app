import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { setSetting } from '@/lib/database/services/setting-service';
import { observeAll as observeAllLocations } from '@/lib/database/services/location-service';
import { getDeviceCountryAlpha2 } from '@/lib/explore/device-country';
import { deriveExploreScopes, type ExploreScope, type ScopeLocationInput } from '@/lib/explore/scopes';
import logger from '@/lib/logger';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ScopeArticleList from './ScopeArticleList';
import ScopeChipRow from './ScopeChipRow';
import TopStoriesList from './TopStoriesList';

/** Persisted last-selected scope id (setting-service KV — same store as other flags). */
const LAST_SCOPE_KEY = 'explore_last_scope';

/**
 * Explore tab (Wave 10, N5; top-stories-blend wave adds the 'top' chip).
 * Scope chips derived from the user's on-device locations + device country
 * (see lib/explore/scopes); World/country scopes are DIRECT server-paginated
 * `topHeadlinesForCountry` queries (ScopeArticleList) — no article_suggestions,
 * no scoring, no LLM, nothing persisted. The 'top' scope instead renders
 * TopStoriesList, which blends the GLOBAL + home-country editions client-side
 * (lib/explore/top-stories.ts). Compact cards only.
 *
 * Sources management now lives in Profile (app-rethink wave) — the header
 * Sources action, the FAB, and the bottom sheet are removed; the header slot
 * they occupied now hosts the notification bell. The floating Mera bubble is
 * not rendered on this screen.
 */
const ExploreScreen: React.FC = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();

    const [locations, setLocations] = useState<ScopeLocationInput[]>([]);
    // Cold-mount always opens on Top stories; the persisted LAST_SCOPE_KEY is intentionally not read for the initial selection (taps still persist below, for potential future use).
    const [selectedId, setSelectedId] = useState<string>('top-stories');
    const [restoredSelection, setRestoredSelection] = useState(false);

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
                        weight: l.weight,
                    })),
                );
            });
            return () => sub.unsubscribe();
        }, []),
    );

    const scopes = useMemo(
        () => deriveExploreScopes(locations, deviceCountry),
        [locations, deviceCountry],
    );

    // No restore step needed anymore (selectedId already defaults to 'top-stories' above) — just clear the gate that guards the snap-back effect below.
    useEffect(() => {
        setRestoredSelection(true);
    }, []);

    // Resolve the active scope: the persisted/selected id when still available,
    // otherwise fall back to the first scope (World).
    const selectedScope: ExploreScope =
        scopes.find((s) => s.id === selectedId) ?? scopes[0];

    // Home is always the 2nd chip when present (order guaranteed by
    // deriveExploreScopes: [top, home?, world, ...]) — TopStoriesList needs
    // its alpha-3 code to fetch the home edition alongside GLOBAL.
    const homeCountryAlpha3 = scopes[1]?.kind === 'country' ? scopes[1].countryCodeAlpha3 : null;

    // If the selection is no longer valid (e.g. a location was removed), snap
    // back to World so the chip row and list stay consistent.
    useEffect(() => {
        if (!restoredSelection) return;
        if (!scopes.some((s) => s.id === selectedId)) {
            setSelectedId(scopes[0]?.id ?? 'world');
        }
    }, [scopes, selectedId, restoredSelection]);

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

                {/* Scope chips */}
                <Box className="mb-2">
                    <ScopeChipRow scopes={scopes} selectedId={selectedScope.id} onSelect={handleSelect} />
                </Box>

                {/* Article list for the active scope — remounts on scope switch. */}
                <Box className="flex-1">
                    {selectedScope.kind === 'top' ? (
                        <TopStoriesList key={selectedScope.id} homeCountryAlpha3={homeCountryAlpha3} />
                    ) : (
                        <ScopeArticleList key={selectedScope.id} scope={selectedScope} />
                    )}
                </Box>
            </Box>
    );
};

export default ExploreScreen;
