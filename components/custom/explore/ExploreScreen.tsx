import ScreenChatBubble from '@/components/custom/floating-chat/ScreenChatBubble';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { observeAll as observeAllLocations } from '@/lib/database/services/location-service';
import { getDeviceCountryAlpha2 } from '@/lib/explore/device-country';
import { deriveExploreScopes, type ExploreScope, type ScopeLocationInput } from '@/lib/explore/scopes';
import logger from '@/lib/logger';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import type { ChatContext } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ScopeArticleList from './ScopeArticleList';
import ScopeChipRow from './ScopeChipRow';
import TopStoriesList from './TopStoriesList';

const EXPLORE_CHAT_CONTEXT: ChatContext = { kind: 'generic', route: 'explore' };
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
 * they occupied now hosts the notification bell. The floating Mera bubble
 * stays visible (only Browse suppresses it).
 */
const ExploreScreen: React.FC = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();

    const [locations, setLocations] = useState<ScopeLocationInput[]>([]);
    const [selectedId, setSelectedId] = useState<string>('world');
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

    // Restore the last-selected scope once (best-effort).
    useEffect(() => {
        let cancelled = false;
        getSetting(LAST_SCOPE_KEY)
            .then((stored) => {
                if (!cancelled && stored) setSelectedId(stored);
            })
            .catch((err: unknown) => {
                logger.captureException(err, {
                    tags: { component: 'ExploreScreen', method: 'restoreScope' },
                });
            })
            .finally(() => {
                if (!cancelled) setRestoredSelection(true);
            });
        return () => {
            cancelled = true;
        };
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

    const hasNoLocations = locations.length === 0;

    return (
        <Box className="flex-1 bg-black" style={{ paddingTop: insets.top + 16 }}>
                {/* Header — title + notification bell (app-rethink wave: takes the
                    header slot the Sources button used to occupy). */}
                <HStack className="items-start justify-between px-5 mb-2">
                    <Heading size="3xl" className="text-white" numberOfLines={1}>
                        {t('explore.title')}
                    </Heading>
                    <NotificationBellButton />
                </HStack>

                {/* Scope chips */}
                <Box className="mb-2">
                    <ScopeChipRow scopes={scopes} selectedId={selectedScope.id} onSelect={handleSelect} />
                </Box>

                {/* No-locations nudge — the device country + World chips still work;
                    this points the user at the dedicated locations management screen
                    (Wave 12 U-F2) to add their places. */}
                {hasNoLocations ? (
                    <VStack className="mx-5 mb-2 rounded-xl border border-gray-800 p-3" space="xs">
                        <HStack className="items-center" space="sm">
                            <MaterialIcons name="place" size={18} color="#EDA77E" />
                            <Text size="sm" bold className="text-white">
                                {t('explore.noLocationsTitle')}
                            </Text>
                        </HStack>
                        <Text size="xs" className="text-typography-400">
                            {t('explore.noLocationsBody')}
                        </Text>
                        <Button
                            size="xs"
                            variant="outline"
                            className="self-start mt-1 rounded-full border-primary-500"
                            onPress={() => router.push('/logged-in/locations')}
                        >
                            <ButtonText className="text-primary-400">{t('explore.addLocation')}</ButtonText>
                        </Button>
                    </VStack>
                ) : null}

                {/* Article list for the active scope — remounts on scope switch. */}
                <Box className="flex-1">
                    {selectedScope.kind === 'top' ? (
                        <TopStoriesList key={selectedScope.id} homeCountryAlpha3={homeCountryAlpha3} />
                    ) : (
                        <ScopeArticleList key={selectedScope.id} scope={selectedScope} />
                    )}
                </Box>

                <ScreenChatBubble context={EXPLORE_CHAT_CONTEXT} extraBottomOffset={TAB_BAR_HEIGHT} />
            </Box>
    );
};

export default ExploreScreen;
