import BlockedBanner from '@/components/custom/BlockedBanner';
import MeraLogo from '@/components/custom/MeraLogo';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import HubRow from '@/components/custom/profile-hub/HubRow';
import PersonaStringSheet from '@/components/custom/profile/PersonaStringSheet';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getFacts } from '@/lib/database/services/fact-service';
import {
    observeSummaryStrings,
    toRow,
    type PersonaSummaryStringRow,
} from '@/lib/database/services/persona-summary-service';
import { maybeRegeneratePersonaSummary } from '@/lib/database/services/persona-summary-trigger';
import { hapticMedium } from '@/lib/haptics';
import { useFloatingChatFactMutationVersion, useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { useUserStore } from '@/lib/stores/user-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';

interface ProfileScreenProps {
    readonly userId: string;
}

/**
 * Mirror-first Profile tab (redesign). A completely non-technical user sees:
 *   1. The Mera "mirror" CTA — tap to start/continue talking to Mera.
 *   2. "About you" — plain-language strings the LLM generated from the full
 *      persona; tap one to nudge importance, refine with Mera, or remove it.
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

                {/* 1 — The Mera mirror CTA */}
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('profile.talkToMera', { defaultValue: 'Talk to Mera' })}
                    onPress={openChat}
                    className="mx-4 mt-2 mb-5 items-center px-5 py-7 rounded-3xl border border-gray-800"
                    style={{ backgroundColor: '#0e0e0e' }}
                >
                    <MeraLogo size={84} />
                    {isEmptyPersona ? (
                        <>
                            <Text className="text-white text-center mt-4" style={{ fontSize: 18, fontWeight: '700' }}>
                                {t('profile.emptyTitle', { defaultValue: "I don't know you yet" })}
                            </Text>
                            <Text className="text-gray-400 text-center mt-1.5" style={{ fontSize: 14 }}>
                                {t('profile.emptyBody', { defaultValue: 'Tell me about yourself so I can find news that matters to you.' })}
                            </Text>
                        </>
                    ) : (
                        <>
                            <Text className="text-white text-center mt-4" style={{ fontSize: 18, fontWeight: '700' }}>
                                {t('profile.talkToMera', { defaultValue: 'Talk to Mera' })}
                            </Text>
                            <Text className="text-gray-400 text-center mt-1.5" style={{ fontSize: 14 }}>
                                {t('profile.talkToMeraSubtitle', { defaultValue: 'This is how I see you. Tap to keep the conversation going.' })}
                            </Text>
                        </>
                    )}
                    <Box className="mt-4 px-5 py-2.5 rounded-full" style={{ backgroundColor: '#EDA77E' }}>
                        <Text style={{ color: '#111', fontSize: 15, fontWeight: '700' }}>
                            {isEmptyPersona
                                ? t('profile.startTalking', { defaultValue: 'Start talking' })
                                : t('profile.continueTalking', { defaultValue: 'Continue' })}
                        </Text>
                    </Box>
                </Pressable>

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
        </Box>
    );
};

export default ProfileScreen;
