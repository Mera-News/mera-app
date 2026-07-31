import BlockedBanner from '@/components/custom/BlockedBanner';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { useNotInterestedData } from '@/components/custom/not-interested/use-not-interested-data';
import HubRow from '@/components/custom/profile-hub/HubRow';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { HEADLINE_DEPTH_UI_ENABLED } from '@/lib/config/feature-gates';
import { getFacts } from '@/lib/database/services/fact-service';
import { getActive } from '@/lib/database/services/publication-preference-service';
import { getPendingCount, subscribeHygieneChange } from '@/lib/database/services/hygiene-service';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useFloatingChatFactMutationVersion } from '@/lib/stores/floating-chat-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useUserStore } from '@/lib/stores/user-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, ScrollView, View } from 'react-native';

interface AdvancedHubScreenProps {
    readonly userId: string;
    readonly onBack: () => void;
}

/** Group heading for the hub list. Purely a label — the rows below it keep the
 *  styling, icons and routes they already had. */
const SectionLabel: React.FC<{ readonly slug: string; readonly text: string; readonly first?: boolean }> = ({
    slug,
    text,
    first = false,
}) => (
    <Text
        testID={`advanced-section-${slug}`}
        size="xs"
        className={`${first ? 'mt-1' : 'mt-6'} mb-1 px-1 text-gray-500 uppercase tracking-wide`}
    >
        {text}
    </Text>
);

/**
 * Advanced persona hub (mirror-first redesign). This is the former Profile-tab
 * ProfileHubScreen — the blocked banner, the refresh-suggestions button, and
 * the focused hub rows (Facts / Locations / Sources / Saved / Source
 * preferences / Activity / Persona health) — now pushed as a dedicated
 * sub-screen from the single "Advanced" row on the new mirror-first
 * ProfileScreen. (The daily-usage card now lives at the top of ProfileScreen.)
 * Everything power users need lives here; the tab itself stays approachable.
 */
const AdvancedHubScreen: React.FC<AdvancedHubScreenProps> = ({ userId, onBack }) => {
    const { t } = useTranslation();
    const toast = useToast();
    const { userPersona, fetchUserPersona } = useUserStore();
    const [isLoading, setIsLoading] = useState(true);
    const [factCount, setFactCount] = useState(0);
    const [prefCount, setPrefCount] = useState(0);
    const [hygieneCount, setHygieneCount] = useState(0);
    const [isRefreshingSuggestions, setIsRefreshingSuggestions] = useState(false);

    const { total: notInterestedTotal } = useNotInterestedData();

    const feedNeedsRefresh = useForYouStore(s => s.feedNeedsRefresh);
    const factMutationVersion = useFloatingChatFactMutationVersion();
    const glowAnim = useRef(new Animated.Value(0.3)).current;

    const lastCountsRefreshRef = useRef(0);

    const refreshCounts = useCallback(() => {
        getFacts().then(f => setFactCount(f.length)).catch(() => { /* keep last */ });
        getActive().then(p => setPrefCount(p.length)).catch(() => { /* keep last */ });
    }, []);

    const refreshHygieneCount = useCallback(() => {
        getPendingCount()
            .then(setHygieneCount)
            .catch(() => { /* non-fatal — leave the last count */ });
    }, []);

    useEffect(() => {
        const init = async () => {
            setIsLoading(true);
            lastCountsRefreshRef.current = Date.now();
            await Promise.all([
                !userPersona && userId ? fetchUserPersona(userId) : Promise.resolve(),
                Promise.resolve(refreshCounts()),
                Promise.resolve(refreshHygieneCount()),
            ]);
            setIsLoading(false);
        };
        init();
    }, [userId, userPersona, fetchUserPersona, refreshCounts, refreshHygieneCount]);

    useFocusEffect(
        useCallback(() => {
            if (Date.now() - lastCountsRefreshRef.current > 30_000) {
                lastCountsRefreshRef.current = Date.now();
                refreshCounts();
                refreshHygieneCount();
            }
            return subscribeHygieneChange(refreshHygieneCount);
        }, [refreshCounts, refreshHygieneCount]),
    );

    useEffect(() => {
        if (factMutationVersion > 0) {
            lastCountsRefreshRef.current = Date.now();
            refreshCounts();
        }
    }, [factMutationVersion, refreshCounts]);

    useEffect(() => {
        if (feedNeedsRefresh) {
            const animation = Animated.loop(
                Animated.sequence([
                    Animated.timing(glowAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
                    Animated.timing(glowAnim, { toValue: 0.3, duration: 800, useNativeDriver: true }),
                ])
            );
            animation.start();
            return () => animation.stop();
        }
        glowAnim.stopAnimation();
        glowAnim.setValue(0);
    }, [feedNeedsRefresh, glowAnim]);

    const handleRefreshSuggestions = useCallback(async () => {
        if (isRefreshingSuggestions) return;
        const personaId = userPersona?._id;
        if (!personaId) return;
        setIsRefreshingSuggestions(true);
        useForYouStore.getState().setFeedNeedsRefresh(false);
        try {
            await useForYouStore.getState().pruneOrphanedData();
            await AppScheduler.trigger('feed-sync');
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('configPanel.refreshSuggestionsSuccessTitle')}</ToastTitle>
                        <ToastDescription>{t('configPanel.refreshSuggestionsSuccessDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('configPanel.refreshSuggestionsFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('configPanel.refreshSuggestionsFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsRefreshingSuggestions(false);
        }
    }, [userPersona, isRefreshingSuggestions, toast, t]);

    const isBlocked = userPersona?.blockedByLlm ?? false;

    const factsSubtitle = factCount > 0
        ? t('profileHub.factsCount', { count: factCount, defaultValue: '{{count}} facts shaping your feed' })
        : t('profileHub.factsEmpty', { defaultValue: 'Tap to add what Mera should know' });
    const prefsSubtitle = prefCount > 0
        ? t('profileHub.prefsCount', { count: prefCount, defaultValue: '{{count}} sources adjusted' })
        : t('profileHub.prefsEmpty', { defaultValue: 'Boost, downrank or mute sources' });
    // Live, not throttled: "remove a filter → go back" is the single most likely
    // trip through this row, and a stale count there reads as a broken screen.
    const notInterestedSubtitle = notInterestedTotal > 0
        ? t('profileHub.notInterestedSubtitle', { count: notInterestedTotal, defaultValue: "{{count}} things you've hidden" })
        : t('profileHub.notInterestedEmpty', { defaultValue: 'Nothing hidden yet' });
    const hygieneSubtitle = hygieneCount > 0
        ? t('profileHub.healthPending', { count: hygieneCount, defaultValue: '{{count}} cleanup suggestions' })
        : t('profileHub.healthAllHealthy', { defaultValue: 'All healthy' });

    return (
        // No opaque fill: the route mounts AbstractGradientBackdrop OUTSIDE
        // its SafeAreaView, so the page background spans the safe areas.
        <Box testID="advanced-hub-screen" className="flex-1">
            <DrillDownHeader
                title={t('profile.advanced', { defaultValue: 'Advanced' })}
                onBack={onBack}
            />
            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : (
                <ScrollView
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ paddingTop: 12, paddingBottom: 120 }}
                    onScroll={notifyScrollTick}
                    scrollEventThrottle={16}
                >
                    {isBlocked && <BlockedBanner reason={userPersona?.blockedByLlmReason} />}

                    <View style={{ marginHorizontal: 16, marginTop: 12, marginBottom: feedNeedsRefresh && !isRefreshingSuggestions ? 6 : 12, position: 'relative' }}>
                        {feedNeedsRefresh && !isRefreshingSuggestions && (
                            <Animated.View
                                pointerEvents="none"
                                style={{
                                    position: 'absolute',
                                    top: -3,
                                    left: -3,
                                    right: -3,
                                    bottom: -3,
                                    borderRadius: 12,
                                    borderWidth: 2,
                                    borderColor: '#60a5fa',
                                    opacity: glowAnim,
                                }}
                            />
                        )}
                        <Button
                            testID="advanced-hub-refresh-suggestions"
                            variant="outline"
                            action="primary"
                            size="sm"
                            onPress={handleRefreshSuggestions}
                            disabled={isRefreshingSuggestions}
                        >
                            {isRefreshingSuggestions ? (
                                <HStack space="sm" className="items-center">
                                    <Spinner size="small" />
                                    <ButtonText>{t('configPanel.refreshingSuggestions')}</ButtonText>
                                </HStack>
                            ) : (
                                <HStack space="sm" className="items-center">
                                    <MaterialIcons name="refresh" size={16} color="#60a5fa" />
                                    <ButtonText>{t('configPanel.refreshSuggestions')}</ButtonText>
                                </HStack>
                            )}
                        </Button>
                    </View>
                    {feedNeedsRefresh && !isRefreshingSuggestions && (
                        <Box testID="advanced-hub-refresh-hint" className="mx-4 mb-3 px-3 py-2 bg-blue-950/60 border border-blue-800 rounded-lg">
                            <HStack space="xs" className="items-start">
                                <MaterialIcons name="auto-awesome" size={14} color="#93c5fd" style={{ marginTop: 1 }} />
                                <Text size="xs" className="text-blue-300 flex-1">
                                    {t('configPanel.personaUpdatedRefreshHint')}
                                </Text>
                            </HStack>
                        </Box>
                    )}

                    {/* Hub rows — the same eight destinations, now under four
                        labels so the list reads as groups rather than a wall. */}
                    <Box className="px-4">
                        <SectionLabel slug="knows" text={t('profileHub.groupKnows', { defaultValue: 'Mera knows you' })} first />
                        <HubRow
                            testID="advanced-row-facts"
                            icon="psychology"
                            label={t('profileHub.facts', { defaultValue: 'Facts' })}
                            subtitle={factsSubtitle}
                            onPress={() => router.push('/logged-in/facts')}
                        />
                        <HubRow
                            testID="advanced-row-locations"
                            icon="place"
                            label={t('profileHub.locations', { defaultValue: 'Locations' })}
                            subtitle={t('profileHub.locationsSubtitle', { defaultValue: 'Places that shape your feed' })}
                            onPress={() => router.push('/logged-in/locations')}
                        />

                        <SectionLabel slug="feed" text={t('profileHub.groupFeed', { defaultValue: 'Your feed' })} />
                        <HubRow
                            testID="advanced-row-not-interested"
                            icon="visibility-off"
                            label={t('profileHub.notInterested', { defaultValue: 'Not interested' })}
                            subtitle={notInterestedSubtitle}
                            onPress={() => router.push('/logged-in/not-interested')}
                        />
                        <HubRow
                            testID="advanced-row-preferences"
                            icon="tune"
                            label={t('profileHub.preferences', { defaultValue: 'Source preferences' })}
                            subtitle={prefsSubtitle}
                            onPress={() => router.push('/logged-in/publication-preferences')}
                        />
                        {/* Gated OFF until mera-server 40d7824 reaches prod — see
                            lib/config/feature-gates.ts. The ENTRY POINT is what's
                            gated, not just the screen: a visible row leading to a
                            control that changes nothing is worse than no row. */}
                        {HEADLINE_DEPTH_UI_ENABLED ? (
                            <HubRow
                                testID="advanced-row-headline-depth"
                                icon="format-list-numbered"
                                label={t('profileHub.headlineDepth', { defaultValue: 'Top headlines' })}
                                subtitle={t('profileHub.headlineDepthSubtitle', { defaultValue: 'How many Mera reads per section' })}
                                onPress={() => router.push('/logged-in/headline-depth')}
                            />
                        ) : null}

                        <SectionLabel slug="library" text={t('profileHub.groupLibrary', { defaultValue: 'Sources & library' })} />
                        <HubRow
                            testID="advanced-row-sources"
                            icon="rss-feed"
                            label={t('profileHub.sources', { defaultValue: 'Sources' })}
                            subtitle={t('profileHub.sourcesSubtitle', { defaultValue: 'Browse and follow news sources' })}
                            onPress={() => router.push('/logged-in/sources')}
                        />
                        <HubRow
                            testID="advanced-row-visited"
                            icon="history"
                            label={t('publicationVisits.visitedListTitle')}
                            subtitle={t('profileHub.visitedSubtitle', { defaultValue: 'Publications you opened recently' })}
                            onPress={() => router.push('/logged-in/visited-publications')}
                        />
                        <HubRow
                            testID="advanced-row-saved"
                            icon="bookmark"
                            label={t('profileHub.saved', { defaultValue: 'Saved' })}
                            subtitle={t('profileHub.savedSubtitle', { defaultValue: 'Articles you saved for later' })}
                            onPress={() => router.push('/logged-in/saved-suggestions')}
                        />

                        <SectionLabel slug="internals" text={t('profileHub.groupInternals', { defaultValue: 'Under the hood' })} />
                        <HubRow
                            testID="advanced-row-activity"
                            icon="history"
                            label={t('profileHub.activity', { defaultValue: 'Activity' })}
                            subtitle={t('profileHub.activitySubtitle', { defaultValue: 'Your persona change history' })}
                            onPress={() => router.push('/logged-in/persona-audit')}
                        />
                        <HubRow
                            testID="advanced-row-health"
                            icon="cleaning-services"
                            label={t('profileHub.personaHealth', { defaultValue: 'Persona health' })}
                            subtitle={hygieneSubtitle}
                            badgeCount={hygieneCount}
                            onPress={() => router.push('/logged-in/hygiene-review')}
                        />
                    </Box>
                </ScrollView>
            )}
        </Box>
    );
};

export default AdvancedHubScreen;
