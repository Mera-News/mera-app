import BlockedBanner from '@/components/custom/BlockedBanner';
import FactsList from '@/components/custom/facts/FactsList';
import MeraChatInvite from '@/components/custom/profile/MeraChatInvite';
import TabExplainerButton from '@/components/custom/for-you/TabExplainerButton';
import { HEADER_ACTIONS_GAP } from '@/components/custom/for-you/HeaderIconButton';
import { HEADER_TITLE_MIN_SCALE } from '@/lib/typography/header-title-size';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Heading } from '@/components/ui/heading';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { getFacts } from '@/lib/database/services/fact-service';
import { useFloatingChatFactMutationVersion } from '@/lib/stores/floating-chat-store';
import { useUserStore } from '@/lib/stores/user-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';

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
 * The header is `Profile (?) ... [Advanced] [bell]`: the power-user hub
 * ("Advanced") opens from the sliders icon. There is no Refresh Suggestions
 * control (owner): after facts change, the combination pass ends with the prune
 * plus feed-sync it used to trigger.
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

    const isBlocked = userPersona?.blockedByLlm ?? false;
    const isEmptyPersona = factCount === 0;

    return (
        // No `bg-black`: ProfileTabScreen mounts AbstractGradientBackdrop
        // behind this screen — an opaque fill here would fully block it,
        // leaving the fact rows/accordions below with nothing to show through.
        <Box className="flex-1">
            {/* Screen heading — mirrors the ForYou/Explore top-left title idiom. */}
            <HStack
                className="items-center justify-between px-5 pt-4 mb-2"
                testID="profile-header"
            >
                {/* "Profile (?)", the "?" right after the title as on Feed,
                    Dashboard and Explore (owner). The group takes the row's
                    remaining width and the title shrinks inside it only when it
                    must, so the "?" stays beside the word; Advanced keeps the
                    top right on its own. */}
                <HStack
                    className="items-center flex-1 min-w-0 mr-3"
                    space="sm"
                    testID="profile-title-group"
                >
                    <Heading
                        size="4xl"
                        className="text-white flex-shrink min-w-0"
                        numberOfLines={1}
                        // Shrink the type, never cut the word (ja "プロフィール"
                        // is 203pt at 36px, 33pt over at 375 beside three icons),
                        // as Feed and Dashboard do. The line box is unchanged.
                        adjustsFontSizeToFit
                        minimumFontScale={HEADER_TITLE_MIN_SCALE}
                        testID="profile-title"
                    >
                        {t('tabs.profile')}
                    </Heading>
                    {/* N4: what this tab is and how it works, in plain words. The
                        old "Learn how Mera works" button competed with the title
                        (M10); the guides have one home, Settings > Help. */}
                    <TabExplainerButton tab="profile" testID="profile-explainer-open" />
                </HStack>
                {/* `[Advanced] [bell]`, spaced like every tab's right cluster so
                    the 44pt frames do not overlap. (Refresh Suggestions is gone:
                    its prune plus feed-sync runs at the end of the combination
                    pass.) */}
                <HStack
                    className="items-center"
                    style={{ gap: HEADER_ACTIONS_GAP }}
                    testID="profile-header-actions"
                >
                    {/* Advanced — icon-only, opens the power-user hub. Was a
                        full-width row at the bottom of the page; moved here so it
                        doesn't compete for scroll space with facts. */}
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
                    <NotificationBellButton />
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

            </ScrollView>

        </Box>
    );
};

export default ProfileScreen;
