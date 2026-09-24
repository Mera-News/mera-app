import BlockedBanner from '@/components/custom/BlockedBanner';
import FactsList from '@/components/custom/facts/FactsList';
import MeraChatInvite from '@/components/custom/profile/MeraChatInvite';
import TabExplainerButton from '@/components/custom/for-you/TabExplainerButton';
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

// Matches TabExplainerButton's header-right glyph: 24pt icon, hitSlop padded
// out to a 44pt target, same muted chrome colour.
const HEADER_ICON_GLYPH = 24;
const HEADER_ICON_HIT_SLOP = (44 - HEADER_ICON_GLYPH) / 2;

interface ProfileScreenProps {
    readonly userId: string;
}

/**
 * Mirror-first Profile tab: who Mera thinks you are.
 *   1. The Mera chat invite (the add-an-interest entry).
 *   2. "About you": the real facts list (`FactsList`, shared with Advanced >
 *      Facts), with delete behind Edit.
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
                <HStack className="items-center" space="md">
                    {/* Advanced — icon-only, opens the power-user hub. Was a
                        full-width row at the bottom of the page; moved here
                        so it doesn't compete for scroll space with facts. */}
                    <Pressable
                        testID="profile-advanced-open"
                        onPress={() => router.push('/logged-in/profile-advanced')}
                        hitSlop={HEADER_ICON_HIT_SLOP}
                        accessibilityRole="button"
                        accessibilityLabel={t('profile.advanced', { defaultValue: 'Advanced' })}
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
            </ScrollView>
        </Box>
    );
};

export default ProfileScreen;
