import BlockedBanner from '@/components/custom/BlockedBanner';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import UsageWidget from '@/components/custom/UsageWidget';
import HubRow from '@/components/custom/profile-hub/HubRow';
import PersonaStringSheet from '@/components/custom/profile/PersonaStringSheet';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { fetchUserBilling } from '@/lib/billing-service';
import { getTotalArticleSuggestionCount } from '@/lib/database/services/article-suggestion-service';
import { getFacts } from '@/lib/database/services/fact-service';
import {
    observeSummaryStrings,
    toRow,
    type PersonaSummaryStringRow,
} from '@/lib/database/services/persona-summary-service';
import { maybeRegeneratePersonaSummary } from '@/lib/database/services/persona-summary-trigger';
import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import { hapticMedium } from '@/lib/haptics';
import logger from '@/lib/logger';
import { getOfferingSafe } from '@/lib/revenuecat';
import { useFloatingChatFactMutationVersion, useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { useUserStore } from '@/lib/stores/user-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';
import RevenueCatUI from 'react-native-purchases-ui';

interface ProfileScreenProps {
    readonly userId: string;
}

/**
 * Mirror-first Profile tab (redesign). A completely non-technical user sees:
 *   1. The daily-usage card (articles analyzed today, plan + upgrade, reset
 *      time) — moved here from the Advanced hub so usage is always visible.
 *   2. "About you" — plain-language strings the LLM generated from the full
 *      persona; tap one to nudge importance, refine with Mera, or remove it.
 *      (A brand-new user with no persona instead sees a "Start talking" CTA.)
 *   3. One "Advanced" row → the full power-user hub (AdvancedHubScreen).
 *
 * Strings are generated canonically in English and rendered via
 * TranslatableDynamic. Regeneration is triggered (debounced) on focus and after
 * a chat mutates facts; old strings keep rendering until replaced.
 */
const ProfileScreen: React.FC<ProfileScreenProps> = ({ userId }) => {
    const { t } = useTranslation();
    const { userPersona, fetchUserPersona } = useUserStore();
    const factMutationVersion = useFloatingChatFactMutationVersion();

    const [strings, setStrings] = useState<PersonaSummaryStringRow[]>([]);
    const [factCount, setFactCount] = useState<number | null>(null);
    const [sheetRow, setSheetRow] = useState<PersonaSummaryStringRow | null>(null);
    const [billing, setBilling] = useState<UserBillingInfo | null>(null);
    const [totalArticleCount, setTotalArticleCount] = useState(0);
    const [showArticleCountInfo, setShowArticleCountInfo] = useState(false);

    const lastRegenRef = useRef(0);

    // Reactive strings — replaceAll/delete flow back here (old rows render until
    // a regeneration replaces them; no blocking spinner).
    useEffect(() => {
        const sub = observeSummaryStrings().subscribe((rows) => {
            setStrings(rows.map(toRow));
        });
        return () => sub.unsubscribe();
    }, []);

    // Fact count (drives the empty-persona state) + persona (blocked banner).
    const refreshFactCount = useCallback(() => {
        getFacts().then((f) => setFactCount(f.length)).catch(() => { /* keep last */ });
    }, []);

    useEffect(() => {
        refreshFactCount();
        if (!userPersona && userId) fetchUserPersona(userId).catch(() => { /* offline */ });
    }, [userId, userPersona, fetchUserPersona, refreshFactCount]);

    // Billing + on-device article count drive the daily-usage card. Both are
    // best-effort — the widget falls back to the local count when offline.
    useEffect(() => {
        fetchUserBilling().then(setBilling).catch(() => { /* offline fallback */ });
        getTotalArticleSuggestionCount().then(setTotalArticleCount).catch(() => { /* keep last */ });
    }, []);

    // Debounced regeneration on focus (tabs stay mounted → focus fires on every
    // switch back; gate to once/30s). Also refresh the fact count on focus.
    const triggerRegen = useCallback(() => {
        lastRegenRef.current = Date.now();
        void maybeRegeneratePersonaSummary();
    }, []);

    useFocusEffect(
        useCallback(() => {
            refreshFactCount();
            if (Date.now() - lastRegenRef.current > 30_000) {
                triggerRegen();
            }
        }, [refreshFactCount, triggerRegen]),
    );

    // A chat (or sheet) that mutated facts bumps this — refresh count + regen.
    useEffect(() => {
        if (factMutationVersion > 0) {
            refreshFactCount();
            triggerRegen();
        }
    }, [factMutationVersion, refreshFactCount, triggerRegen]);

    const openChat = useCallback(() => {
        void hapticMedium();
        useFloatingChatStore.getState().expand({ kind: 'persona' });
    }, []);

    const handleUpgrade = useCallback(async () => {
        try {
            const offering = await getOfferingSafe();
            await RevenueCatUI.presentPaywall({
                ...(offering ? { offering } : {}),
                displayCloseButton: true,
            });
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'ProfileScreen', method: 'upgrade' },
            });
        }
    }, []);

    const isBlocked = userPersona?.blockedByLlm ?? false;
    const isEmptyPersona = factCount === 0;
    const isUpdating = strings.some((s) => s.stale);

    return (
        <Box className="flex-1 bg-black">
            <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingTop: 8, paddingBottom: 140 }}
                onScroll={notifyScrollTick}
                scrollEventThrottle={16}
            >
                {isBlocked && <BlockedBanner reason={userPersona?.blockedByLlmReason} />}

                {/* 1 — Daily-usage card (moved from the Advanced hub) */}
                <UsageWidget
                    className="mx-4 mt-2 mb-5"
                    used={billing?.articlesUsedToday ?? totalArticleCount}
                    limit={billing?.dailyArticleLimit ?? null}
                    usedLabel={t('configPanel.articlesAnalyzedLast24h')}
                    planLabel={
                        billing?.subscriptionTier === 'professional'
                            ? t('configPanel.professionalPlan')
                            : billing?.subscriptionTier === 'individual'
                                ? t('configPanel.individualPlan')
                                : t('configPanel.promoPlan')
                    }
                    onUpgrade={billing?.subscriptionTier === 'professional' ? undefined : handleUpgrade}
                    upgradeLabel={t('subscription.upgrade')}
                    resetAt={billing?.resetAt}
                    resetLabel={t('configPanel.resetsOn')}
                    onInfoPress={() => setShowArticleCountInfo(true)}
                />

                {/* 2 — About you */}
                {!isEmptyPersona && (
                    <Box className="px-4 mb-4">
                        <HStack className="items-center justify-between mb-2 px-1">
                            <Text className="text-gray-400" style={{ fontSize: 13, fontWeight: '600', letterSpacing: 0.4 }}>
                                {t('profile.aboutYou', { defaultValue: 'ABOUT YOU' }).toUpperCase()}
                            </Text>
                            {isUpdating && (
                                <HStack space="xs" className="items-center">
                                    <Spinner size="small" />
                                    <Text size="xs" className="text-gray-500">
                                        {t('profile.updating', { defaultValue: 'Updating…' })}
                                    </Text>
                                </HStack>
                            )}
                        </HStack>

                        {strings.length === 0 ? (
                            <Box className="px-4 py-5 rounded-2xl border border-gray-800" style={{ backgroundColor: '#0e0e0e' }}>
                                <HStack space="sm" className="items-center">
                                    <MaterialIcons name="auto-awesome" size={18} color="#93c5fd" />
                                    <Text className="text-gray-400 flex-1" style={{ fontSize: 14 }}>
                                        {t('profile.gettingToKnowYou', { defaultValue: "I'm still getting to know you — check back in a moment." })}
                                    </Text>
                                </HStack>
                            </Box>
                        ) : (
                            <VStack space="sm">
                                {strings.map((s) => (
                                    <Pressable
                                        key={s.id}
                                        accessibilityRole="button"
                                        accessibilityLabel={s.text}
                                        onPress={() => setSheetRow(s)}
                                        className="flex-row items-center justify-between px-4 py-3.5 rounded-2xl border border-gray-800"
                                        style={{ backgroundColor: '#141414', opacity: s.stale ? 0.6 : 1 }}
                                    >
                                        <TranslatableDynamic
                                            text={s.text}
                                            size="md"
                                            className="text-white flex-1 mr-2"
                                            numberOfLines={2}
                                        />
                                        <MaterialIcons name="chevron-right" size={20} color="#6b7280" />
                                    </Pressable>
                                ))}
                            </VStack>
                        )}
                    </Box>
                )}

                {isEmptyPersona && (
                    <Box className="px-4 mb-4">
                        <Button variant="outline" action="primary" onPress={openChat}>
                            <HStack space="sm" className="items-center">
                                <MaterialIcons name="chat-bubble-outline" size={18} color="#60a5fa" />
                                <ButtonText>{t('profile.startTalking', { defaultValue: 'Start talking' })}</ButtonText>
                            </HStack>
                        </Button>
                    </Box>
                )}

                {/* 3 — Advanced */}
                <Box className="px-4">
                    <HubRow
                        icon="tune"
                        label={t('profile.advanced', { defaultValue: 'Advanced' })}
                        subtitle={t('profile.advancedSubtitle', { defaultValue: 'Facts, sources, saved, activity and more' })}
                        onPress={() => router.push('/logged-in/profile-advanced')}
                    />
                </Box>
            </ScrollView>

            <PersonaStringSheet
                visible={sheetRow !== null}
                row={sheetRow}
                onClose={() => setSheetRow(null)}
                onRemoved={() => setSheetRow(null)}
            />

            <Modal isOpen={showArticleCountInfo} onClose={() => setShowArticleCountInfo(false)} size="sm">
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader className="pb-3">
                        <HStack className="items-center" space="xs">
                            <MaterialIcons name="info-outline" size={18} color="#9ca3af" />
                            <Text className="text-base font-semibold text-white">{t('configPanel.articleAnalysisTitle')}</Text>
                        </HStack>
                    </ModalHeader>
                    <ModalBody className="py-4">
                        <Text className="text-gray-300 text-sm leading-relaxed">
                            {t('configPanel.articleAnalysisDescription')}
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={() => setShowArticleCountInfo(false)}
                            className="w-full"
                        >
                            <ButtonText>{t('configPanel.gotIt')}</ButtonText>
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </Box>
    );
};

export default ProfileScreen;
