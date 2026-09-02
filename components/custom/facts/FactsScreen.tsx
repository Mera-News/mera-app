import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { useFreeTierReadOnly } from '@/components/custom/subscription/FreeTierReadOnlyBanner';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { authClient } from '@/lib/auth-client';
import { PRIVACY_URL } from '@/lib/config/branding';
import { useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl, ScrollView } from 'react-native';
import FactsList, { type FactsListHandle } from './FactsList';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';

interface FactsScreenProps {
    readonly onBack: () => void;
}

/**
 * Facts sub-screen (Wave 12). The entire fact-management UX that used to live in
 * PersonaL1MeraProtocol's megascroll — delete fact, per-topic article counts →
 * persona-articles, delete topic, add topic, generate more — moved verbatim to
 * a dedicated pushed route off the Profile hub. Services, params, and routes are
 * unchanged; only the surrounding hub chrome (usage widget, audit/hygiene rows,
 * refresh-suggestions button) was left behind on the hub.
 *
 * Wave r6b: the row-rendering/delete/expansion/topic-management logic was
 * extracted into `FactsList` (also used standalone by `ProfileScreen`) — this
 * screen now owns only the header, initial-load/empty-state chrome, the
 * "Your facts" heading + privacy notice, and the pull-to-refresh wiring.
 */
const FactsScreen: React.FC<FactsScreenProps> = ({ onBack }) => {
    // Identity is a LOCAL fact (lib/security/launch-route.ts). Facts live on
    // this device and ARE the product, so nothing here may wait on a server
    // session: reading the id off the session meant pull-to-refresh silently
    // did nothing (see `onRefresh`) whenever /get-session could not be reached.
    // The persisted id survives that; the session is only the fallback for the
    // window before hydrateFromDb() has run.
    const { data: session } = authClient.useSession();
    const localUserId = useUserStore((s) => s.userId);
    const userId = localUserId ?? session?.user?.id;
    const { fetchUserPersona } = useUserStore();
    const { t } = useTranslation();
    const isOnDeviceProcessing = useIsOnDeviceProcessing();
    const readOnly = useFreeTierReadOnly();

    const [refreshing, setRefreshing] = useState(false);
    const [screenFacts, setScreenFacts] = useState<Fact[] | null>(null);
    const [showPrivacyInfo, setShowPrivacyInfo] = useState(false);

    const factsListRef = useRef<FactsListHandle>(null);

    useEffect(() => {
        if (userId) fetchUserPersona(userId).catch(() => { /* offline */ });
    }, [userId, fetchUserPersona]);

    // The facts reload is unconditional — it reads the local DB and owes the
    // server nothing. Only the persona refresh needs an id, so an unknown
    // identity degrades this to a local-only refresh instead of a no-op
    // spinner that never even reloads the list.
    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await Promise.all([
            factsListRef.current?.refresh() ?? Promise.resolve(),
            userId ? fetchUserPersona(userId, true) : Promise.resolve(null),
        ]);
        setRefreshing(false);
    }, [userId, fetchUserPersona]);

    const isLoading = screenFacts === null;
    const isEmpty = screenFacts !== null && screenFacts.length === 0;

    return (
        // No opaque fill: the route mounts AbstractGradientBackdrop OUTSIDE
        // its SafeAreaView, so the page background spans the safe areas.
        <Box className="flex-1">
            <DrillDownHeader
                title={t('facts.screenTitle', { defaultValue: 'Your facts' })}
                subtitle={t('facts.screenSubtitle', { defaultValue: 'What Mera knows about you' })}
                onBack={onBack}
            />

            <Box className="flex-1">
                {isLoading && (
                    <Box className="absolute inset-0 items-center justify-center">
                        <Spinner size="large" />
                    </Box>
                )}
                {isEmpty && (
                    <VStack className="absolute inset-0 items-center justify-center p-6" space="md">
                        <MaterialIcons name="chat" size={48} color="#666666" />
                        <Text size="md" className="text-gray-400 text-center">
                            {t('configPanel.emptyStateMessage')}
                        </Text>
                    </VStack>
                )}

                {/* FactsList stays mounted regardless of the loading/empty chrome above
                    so it keeps reacting to real-time fact mutations (e.g. a chat adding
                    the first fact while this screen is showing the empty state). */}
                <ScrollView
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ paddingTop: 12, paddingBottom: 96 }}
                    onScroll={notifyScrollTick}
                    scrollEventThrottle={16}
                    style={{ opacity: isLoading || isEmpty ? 0 : 1 }}
                    pointerEvents={isLoading || isEmpty ? 'none' : 'auto'}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={onRefresh}
                            tintColor="#ffffff"
                            colors={['#ffffff']}
                        />
                    }
                >
                    {/* Facts heading */}
                    <HStack className="mx-4 mb-2 items-center justify-between">
                        <Text size="sm" className="text-gray-400 font-medium">{t('configPanel.factsHeading')}</Text>
                        <Pressable
                            onPress={() => setShowPrivacyInfo(true)}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={t('configPanel.privacyNoticeTitle')}
                            className="w-8 h-8 rounded-full items-center justify-center"
                        >
                            <MaterialIcons name="help-outline" size={18} color="#60a5fa" />
                        </Pressable>
                    </HStack>

                    <FactsList ref={factsListRef} onFactsChange={setScreenFacts} readOnly={readOnly} />
                </ScrollView>
            </Box>


            {/* Privacy notice */}
            <Modal isOpen={showPrivacyInfo} onClose={() => setShowPrivacyInfo(false)} size="sm">
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader className="pb-3">
                        <HStack className="items-center" space="xs">
                            <MaterialIcons name="shield" size={18} color="#9ca3af" />
                            <Text className="text-base font-semibold text-white">{t('configPanel.privacyNoticeTitle')}</Text>
                        </HStack>
                    </ModalHeader>
                    <ModalBody className="py-4">
                        <Text className="text-gray-300 text-sm leading-relaxed">
                            {isOnDeviceProcessing
                                ? t('configPanel.privacyOnDevice')
                                : t('configPanel.privacyCloud')}{' '}
                            <Text className="text-primary-400 underline text-sm" onPress={() => openInAppBrowser(withAppLanguage(PRIVACY_URL))}>
                                {t('configPanel.privacyPolicy')}
                            </Text>
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={() => setShowPrivacyInfo(false)}
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

export default FactsScreen;
