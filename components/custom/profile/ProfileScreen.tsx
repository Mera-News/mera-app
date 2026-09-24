import BlockedBanner from '@/components/custom/BlockedBanner';
import FactsList from '@/components/custom/facts/FactsList';
import MeraChatInvite from '@/components/custom/profile/MeraChatInvite';
import TabExplainerButton from '@/components/custom/for-you/TabExplainerButton';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Heading } from '@/components/ui/heading';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { getFacts } from '@/lib/database/services/fact-service';
import { usePulse } from '@/lib/hooks/use-pulse';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useFloatingChatFactMutationVersion } from '@/lib/stores/floating-chat-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useUserStore } from '@/lib/stores/user-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, ScrollView, View } from 'react-native';

// Matches TabExplainerButton's header-right glyph size and muted chrome
// colour: 24pt icon. The touch FRAME is 44pt (Batch 13, sim capture
// 1440-b8-profile-header: hitSlop alone measured 24×24, because hitSlop
// extends what accepts a touch without changing the rect a harness reads).
// A negative margin equal to half the grown amount keeps the LAYOUT
// footprint at the glyph's own 24pt, so growing the frame doesn't shift the
// icon or reflow the row it sits in.
const HEADER_ICON_GLYPH = 24;
const HEADER_ICON_TOUCH_TARGET = 44;
const HEADER_ICON_TOUCH_MARGIN = -(HEADER_ICON_TOUCH_TARGET - HEADER_ICON_GLYPH) / 2;

interface ProfileScreenProps {
    readonly userId: string;
}

/**
 * Mirror-first Profile tab: who Mera thinks you are.
 *   1. The Mera chat invite (the add-an-interest entry).
 *   2. "About you": the real facts list (`FactsList`, shared with Advanced >
 *      Facts), with delete behind Edit.
 *   3. Refresh Suggestions — moved here from AdvancedHubScreen, in the same
 *      bottom slot the "Advanced" row used to occupy. No copy is left on
 *      AdvancedHubScreen.
 * The power-user hub ("Advanced") opens from an icon-only button at the
 * top-right of the header, beside the tab explainer — there is no bottom
 * Advanced row any more.
 * The daily-usage card lives at the top of Settings (SettingsUsageCard), not
 * here: this tab is about the person, not the plan.
 */
const ProfileScreen: React.FC<ProfileScreenProps> = ({ userId }) => {
    const { t } = useTranslation();
    const { userPersona, fetchUserPersona } = useUserStore();
    const factMutationVersion = useFloatingChatFactMutationVersion();
    // ProfileScreen is only reached via the main tab navigator (after
    // onboarding, a separate route) — no isOnboarding exemption needed here,
    // unlike MeraProtocolSettingsScreen which is also mounted mid-onboarding.

    const [factCount, setFactCount] = useState<number | null>(null);
    // F46: fact deletion lives behind Edit, not on a red trash on every row.
    const [editingFacts, setEditingFacts] = useState(false);
    // A purchase completed but the server has not confirmed the new tier yet.
    // Mirrors NotSubscribedScreen's `activationDelayed` handling: an honest
    // "still working on it" beats committing a snapshot we know is stale.

    // Fact count (drives the empty-persona state) + persona (blocked banner).
    const refreshFactCount = useCallback(() => {
        getFacts().then((f) => setFactCount(f.length)).catch(() => { /* keep last */ });
    }, []);

    useEffect(() => {
        refreshFactCount();
        if (!userPersona && userId) fetchUserPersona(userId).catch(() => { /* offline */ });
    }, [userId, userPersona, fetchUserPersona, refreshFactCount]);

    // Refresh the fact count on focus (tabs stay mounted): it drives the
    // empty-persona state. FactsList owns its own refresh for the list itself.
    useFocusEffect(
        useCallback(() => {
            refreshFactCount();
        }, [refreshFactCount]),
    );

    // A chat (or sheet) that mutated facts bumps this — refresh the count so the
    // empty-persona CTA flips promptly.
    useEffect(() => {
        if (factMutationVersion > 0) {
            refreshFactCount();
        }
    }, [factMutationVersion, refreshFactCount]);

    // --- Refresh Suggestions (moved from AdvancedHubScreen, whole unit: the
    // button, the glow ring, the hint and the handler) ----------------------
    const toast = useToast();
    const [isRefreshingSuggestions, setIsRefreshingSuggestions] = useState(false);
    const feedNeedsRefresh = useForYouStore((s) => s.feedNeedsRefresh);
    // `feedNeedsRefresh` can stay true indefinitely, and this tab stays
    // mounted behind whatever is pushed on top of it — `usePulse` gates the
    // loop on focus + foreground so it doesn't pulse forever off-screen, and
    // parks at 0.3 (not 0) while pending so the affordance stays visible on a
    // blurred screen.
    const glowAnim = usePulse(feedNeedsRefresh);

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
    const isEmptyPersona = factCount === 0;

    return (
        // No `bg-black`: ProfileTabScreen mounts AbstractGradientBackdrop
        // behind this screen — an opaque fill here would fully block it,
        // leaving the fact rows/accordions below with nothing to show through.
        <Box className="flex-1">
            {/* Screen heading — mirrors the ForYou/Explore top-left title idiom. */}
            <HStack className="items-center justify-between px-5 pt-4 mb-2">
                {/* Clamp AND scale, matching Feed/Dashboard/Explore: a bare
                    1-line clamp truncated the screen's own name at large Dynamic
                    Type, and letting it wrap breaks a single long localized word
                    mid-word. One line, shrunk to fit, is Apple's own answer for a
                    title that shares its row with a control — and this row now
                    has one. */}
                <Heading
                    size="4xl"
                    className="text-white flex-1 mr-3"
                    numberOfLines={1}
                >
                    {t('tabs.profile')}
                </Heading>
                {/* The gap is exactly what keeps the two 44pt frames from
                    overlapping: each reaches (44 - 24) / 2 past its glyph. The
                    old `space="md"` (~10.7pt) left 9.3pt of overlap, and the
                    "?" won it. In points, in `style`, not a rem-scaled class. */}
                <HStack
                    className="items-center"
                    style={{ gap: HEADER_ICON_TOUCH_TARGET - HEADER_ICON_GLYPH }}
                    testID="profile-header-actions"
                >
                    {/* Advanced — icon-only, opens the power-user hub. Was a
                        full-width row at the bottom of the page; moved here
                        so it doesn't compete for scroll space with facts. */}
                    <Pressable
                        testID="profile-advanced-open"
                        onPress={() => router.push('/logged-in/profile-advanced')}
                        accessibilityRole="button"
                        accessibilityLabel={t('profile.advanced', { defaultValue: 'Advanced' })}
                        style={{
                            width: HEADER_ICON_TOUCH_TARGET,
                            height: HEADER_ICON_TOUCH_TARGET,
                            margin: HEADER_ICON_TOUCH_MARGIN,
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <MaterialIcons name="tune" size={HEADER_ICON_GLYPH} color="rgb(212, 212, 212)" />
                    </Pressable>
                    {/* N4: what this tab is and how it works, in plain words. The
                        old "Learn how Mera works" button competed with the title
                        (M10); the guides have one home, Settings > Help. */}
                    <TabExplainerButton tab="profile" testID="profile-explainer-open" />
                </HStack>
            </HStack>

            <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingTop: 8, paddingBottom: 140 }}
                onScroll={notifyScrollTick}
                scrollEventThrottle={16}
            >
                {isBlocked && <BlockedBanner reason={userPersona?.blockedByLlmReason} />}

                {/* Mera chat invite — static comic speech bubble + logo, replaces
                    the former floating bubble. Taps open the persona chat. */}
                <MeraChatInvite returning={factCount !== null && factCount > 0} />

                {/* 2 — About you (the real facts list — same component FactsScreen uses).
                    No outer px-4 here: FactAccordion carries its own mx-4 inset, matching
                    FactsScreen's layout — an extra wrapper padding would double-indent it. */}
                {!isEmptyPersona && (
                    <Box className="mb-4">
                        <HStack className="mx-4 mb-2 items-center justify-between">
                            <Text className="text-gray-400" style={{ fontSize: 13, fontWeight: '600', letterSpacing: 0.4 }}>
                                {t('profile.aboutYou', { defaultValue: 'ABOUT YOU' }).toUpperCase()}
                            </Text>
                            <Pressable
                                testID="profile-edit-facts"
                                onPress={() => setEditingFacts((e) => !e)}
                                accessibilityRole="button"
                                hitSlop={8}
                                style={{ minWidth: 44, minHeight: 44 }}
                                className="px-2 items-center justify-center"
                            >
                                <Text className="text-primary-400 font-semibold" size="sm">
                                    {editingFacts ? t('common.done') : t('profile.editFacts')}
                                </Text>
                            </Pressable>
                        </HStack>

                        <FactsList editing={editingFacts} />
                    </Box>
                )}

                {/* 3 — Refresh Suggestions, moved here from AdvancedHubScreen,
                    in the bottom slot the "Advanced" row used to occupy. */}
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
            </ScrollView>
        </Box>
    );
};

export default ProfileScreen;
