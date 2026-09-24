import BlockedBanner from '@/components/custom/BlockedBanner';
import FactsList from '@/components/custom/facts/FactsList';
import MeraChatInvite from '@/components/custom/profile/MeraChatInvite';
import TabExplainerButton from '@/components/custom/for-you/TabExplainerButton';
import HeaderIconButton, {
    HEADER_ACTIONS_GAP,
    HEADER_ICON_GLYPH as ACTION_GLYPH,
} from '@/components/custom/for-you/HeaderIconButton';
import { HEADER_TITLE_MIN_SCALE } from '@/lib/typography/header-title-size';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Heading } from '@/components/ui/heading';
import { Pressable } from '@/components/ui/pressable';
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

/** The refresh icon's pulse ring and the tooltip's glow (the old hint's blue). */
const REFRESH_GLOW = '#60a5fa';
/** Tooltip surface: opaque (it floats over content), the old hint box's blues. */
const TOOLTIP_FILL = 'rgb(23, 37, 84)';
const TOOLTIP_BORDER = '#1e40af';
const TOOLTIP_INK = '#93c5fd';
/** Wraps to 2-3 lines at 375 instead of one long bar. */
const TOOLTIP_MAX_WIDTH = 240;
/** Kept inside the screen's right edge. */
const TOOLTIP_EDGE = 16;
const TOOLTIP_CARET = 7;
/**
 * The caret sits under the refresh glyph's centre. The header's right cluster
 * is `[refresh] [Advanced] [bell]` inside px-5 (20), so that centre is a fixed
 * distance from the screen's right edge: 20 + 24 + gap + 24 + gap + 12.
 * Measured from the bubble's right edge (TOOLTIP_EDGE), less half the caret.
 */
const REFRESH_CENTRE_FROM_RIGHT = 20 + ACTION_GLYPH + HEADER_ACTIONS_GAP + ACTION_GLYPH + HEADER_ACTIONS_GAP + ACTION_GLYPH / 2;
const TOOLTIP_CARET_RIGHT = REFRESH_CENTRE_FROM_RIGHT - TOOLTIP_EDGE - TOOLTIP_CARET;

interface ProfileScreenProps {
    readonly userId: string;
}

/**
 * Mirror-first Profile tab: who Mera thinks you are.
 *   1. The Mera chat invite (the add-an-interest entry).
 *   2. "About you": the real facts list (`FactsList`, shared with Advanced >
 *      Facts), with delete behind Edit.
 * The header is `Profile (?) ... [refresh] [Advanced] [bell]`: Refresh
 * Suggestions is an icon-only header button (owner), which glows with a
 * tooltip below it while the persona changed and the feed has not caught up;
 * the power-user hub ("Advanced") opens from the sliders icon. Nothing sits at
 * the bottom of the page any more.
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
    // The tooltip is dismissed for THIS visit only: it returns on the next
    // focus while the flag still holds.
    const [tooltipDismissed, setTooltipDismissed] = useState(false);
    useFocusEffect(
        useCallback(() => {
            setTooltipDismissed(false);
        }, []),
    );
    const [headerBottom, setHeaderBottom] = useState<number | null>(null);
    const showRefreshGlow = feedNeedsRefresh && !isRefreshingSuggestions;
    const showRefreshTooltip = showRefreshGlow && !tooltipDismissed;

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

    // The Refresh Suggestions icon's spoken label, explicit so the icon-font
    // glyph never leaks into it.
    const refreshSuggestionsLabel = isRefreshingSuggestions
        ? t('configPanel.refreshingSuggestions')
        : t('configPanel.refreshSuggestions');

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
                onLayout={(e) => setHeaderBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
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
                {/* `[refresh] [Advanced] [bell]` (owner), spaced like every tab's
                    right cluster so the 44pt frames do not overlap. */}
                <HStack
                    className="items-center"
                    style={{ gap: HEADER_ACTIONS_GAP }}
                    testID="profile-header-actions"
                >
                    {/* Refresh Suggestions, icon-only (owner: moved up from the
                        bottom of the page). Same handler as ever. While the
                        persona changed and the feed has not caught up, it
                        glows and its tooltip hangs below (see the layer at the
                        end); the tooltip's text is this button's hint, read
                        once, so the bubble itself is hidden from VoiceOver. */}
                    <View>
                        {showRefreshGlow && (
                            <Animated.View
                                pointerEvents="none"
                                testID="profile-refresh-glow"
                                style={{
                                    position: 'absolute',
                                    top: -6,
                                    left: -6,
                                    width: 36,
                                    height: 36,
                                    borderRadius: 18,
                                    borderWidth: 2,
                                    borderColor: REFRESH_GLOW,
                                    opacity: glowAnim,
                                }}
                            />
                        )}
                        <HeaderIconButton
                            icon="refresh"
                            onPress={handleRefreshSuggestions}
                            busy={isRefreshingSuggestions}
                            accessibilityLabel={refreshSuggestionsLabel}
                            accessibilityHint={
                                showRefreshTooltip ? t('configPanel.personaUpdatedRefreshHint') : undefined
                            }
                            testID="advanced-hub-refresh-suggestions"
                        />
                    </View>
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

            {/* The refresh tooltip (owner: "the glowing text ... under the
                refresh icon like a tooltip"). It floats over the content in
                this screen (not a Modal: the tab bar stays live) from the
                header's bottom, so the header never changes height. A tap on
                the bubble refreshes; a tap anywhere else dismisses it for this
                visit. */}
            {showRefreshTooltip && headerBottom !== null && (
                <View
                    style={{ position: 'absolute', top: headerBottom, left: 0, right: 0, bottom: 0 }}
                    testID="profile-refresh-tooltip-layer"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                >
                    <Pressable
                        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
                        onPress={() => setTooltipDismissed(true)}
                        testID="profile-refresh-tooltip-backdrop"
                    />
                    <Pressable
                        onPress={handleRefreshSuggestions}
                        testID="profile-refresh-tooltip"
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        style={{
                            position: 'absolute',
                            top: TOOLTIP_CARET,
                            right: TOOLTIP_EDGE,
                            maxWidth: TOOLTIP_MAX_WIDTH,
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            borderRadius: 10,
                            borderWidth: 1,
                            borderColor: TOOLTIP_BORDER,
                            backgroundColor: TOOLTIP_FILL,
                            shadowColor: REFRESH_GLOW,
                            shadowOpacity: 0.6,
                            shadowRadius: 10,
                            shadowOffset: { width: 0, height: 0 },
                            elevation: 6,
                        }}
                    >
                        {/* The caret, pointing up at the refresh glyph. */}
                        <View
                            pointerEvents="none"
                            style={{
                                position: 'absolute',
                                top: -TOOLTIP_CARET,
                                right: TOOLTIP_CARET_RIGHT,
                                width: 0,
                                height: 0,
                                borderLeftWidth: TOOLTIP_CARET,
                                borderRightWidth: TOOLTIP_CARET,
                                borderBottomWidth: TOOLTIP_CARET,
                                borderLeftColor: 'transparent',
                                borderRightColor: 'transparent',
                                borderBottomColor: TOOLTIP_BORDER,
                            }}
                        />
                        <Text size="xs" style={{ color: TOOLTIP_INK }}>
                            {t('configPanel.personaUpdatedRefreshHint')}
                        </Text>
                    </Pressable>
                </View>
            )}
        </Box>
    );
};

export default ProfileScreen;
