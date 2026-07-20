import BlockedBanner from '@/components/custom/BlockedBanner';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import HubRow from '@/components/custom/profile-hub/HubRow';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
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
    const hygieneSubtitle = hygieneCount > 0
        ? t('profileHub.healthPending', { count: hygieneCount, defaultValue: '{{count}} cleanup suggestions' })
        : t('profileHub.healthAllHealthy', { defaultValue: 'All healthy' });

    return (
        <Box className="flex-1 bg-black">
            <DrillDownHeader
                title={t('profile.advanced', { defaultValue: 'Advanced' })}
                onBack={onBack}
            />
            {isLoading ? (
                <Box className="flex-1 items-center justify-center bg-black">
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
                        <Box className="mx-4 mb-3 px-3 py-2 bg-blue-950/60 border border-blue-800 rounded-lg">
                            <HStack space="xs" className="items-start">
                                <MaterialIcons name="auto-awesome" size={14} color="#93c5fd" style={{ marginTop: 1 }} />
                                <Text size="xs" className="text-blue-300 flex-1">
                                    {t('configPanel.personaUpdatedRefreshHint')}
                                </Text>
                            </HStack>
                        </Box>
                    )}

                    {/* Hub rows */}
                    <Box className="px-4">
                        <HubRow
                            icon="psychology"
                            label={t('profileHub.facts', { defaultValue: 'Facts' })}
                            subtitle={factsSubtitle}
                            onPress={() => router.push('/logged-in/facts')}
                        />
                        <HubRow
                            icon="place"
                            label={t('profileHub.locations', { defaultValue: 'Locations' })}
                            subtitle={t('profileHub.locationsSubtitle', { defaultValue: 'Places that shape your feed' })}
                            onPress={() => router.push('/logged-in/locations')}
                        />
                        <HubRow
                            icon="rss-feed"
                            label={t('profileHub.sources', { defaultValue: 'Sources' })}
                            subtitle={t('profileHub.sourcesSubtitle', { defaultValue: 'Browse and follow news sources' })}
                            onPress={() => router.push('/logged-in/sources')}
                        />
                        <HubRow
                            icon="bookmark"
                            label={t('profileHub.saved', { defaultValue: 'Saved' })}
                            subtitle={t('profileHub.savedSubtitle', { defaultValue: 'Articles you saved for later' })}
                            onPress={() => router.push('/logged-in/saved-suggestions')}
                        />
                        <HubRow
                            icon="tune"
                            label={t('profileHub.preferences', { defaultValue: 'Source preferences' })}
                            subtitle={prefsSubtitle}
                            onPress={() => router.push('/logged-in/publication-preferences')}
                        />
                        <HubRow
                            icon="history"
                            label={t('publicationVisits.visitedListTitle')}
                            subtitle={t('profileHub.visitedSubtitle', { defaultValue: 'Publications you opened recently' })}
                            onPress={() => router.push('/logged-in/visited-publications')}
                        />
                        <HubRow
                            icon="history"
                            label={t('profileHub.activity', { defaultValue: 'Activity' })}
                            subtitle={t('profileHub.activitySubtitle', { defaultValue: 'Your persona change history' })}
                            onPress={() => router.push('/logged-in/persona-audit')}
                        />
                        <HubRow
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
