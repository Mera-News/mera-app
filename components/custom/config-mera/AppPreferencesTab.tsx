import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { authClient, clearAuthStorage } from '@/lib/auth-client';
import { CONTENT_POLICY_URL, GITHUB_URL, PRIVACY_URL, SUPPORT_EMAIL, TERMS_URL, WEBSITE_URL } from '@/lib/config/branding';
import { useLogoutModal, useUIStore } from '@/lib/stores/ui-store';
import { getAppVersionLabel } from '@/lib/version';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { showFeedback } from '@/lib/feedback';
import { SENTRY_ENABLED } from '@/lib/sentry-init';
import { FontAwesome, MaterialIcons } from '@expo/vector-icons';
import { router, useRouter } from 'expo-router';
import React from 'react';
import { Linking } from 'react-native';
import { isRevenueCatConfigured } from '@/lib/revenuecat';
import { useTranslation } from 'react-i18next';
import { LANGUAGE_WORD_BY_CODE } from '@/lib/language-words';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import LanguageWordTicker from './LanguageWordTicker';
import PolicyPill from '@/components/custom/PolicyPill';

interface PreferenceOption {
    id: string;
    title: string;
    icon: keyof typeof MaterialIcons.glyphMap;
    onPress: () => void;
    type?: 'normal' | 'danger';
}

const AppPreferencesTab: React.FC = () => {
    const routerHook = useRouter();
    const toast = useToast();
    const { t } = useTranslation();
    const appLanguage = useAppLanguageStore((s) => s.appLanguage);
    const { data: session } = authClient.useSession();
    const userEmail = session?.user?.email;
    const maskedEmail = React.useMemo(() => {
        if (!userEmail) return null;
        const atIdx = userEmail.lastIndexOf('@');
        if (atIdx <= 0) return userEmail;
        const local = userEmail.slice(0, atIdx);
        const domain = userEmail.slice(atIdx);
        const visibleCount = Math.ceil(local.length / 2);
        return local.slice(0, visibleCount) + '•'.repeat(local.length - visibleCount) + domain;
    }, [userEmail]);

    // UI Store for modal state management
    const logoutModal = useLogoutModal();
    const { openModal, closeModal, setModalProcessing } = useUIStore();

    // Derived modal visibility states
    const showLogoutModal = logoutModal.isOpen;
    const isLoggingOut = logoutModal.isProcessing;

    // Function that performs the actual logout
    const handleActualLogout = async () => {
        try {
            setModalProcessing('logout', true);
            closeModal('logout');

            await authClient.signOut();
            await clearAuthStorage();

            router.dismissAll();
            router.replace('/');

            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('preferences.signedOutTitle')}</ToastTitle>
                        <ToastDescription>{t('preferences.signedOutDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('preferences.logoutFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('preferences.logoutFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setModalProcessing('logout', false);
        }
    };

    // Single subscription row (details + plans + customer center live in the
    // Manage Subscription screen) — only shown when RevenueCat is configured.
    const subscriptionOptions: PreferenceOption[] = isRevenueCatConfigured()
        ? [
            {
                id: 'manage-subscription',
                title: t('subscription.managePlan'),
                icon: 'card-membership',
                onPress: () => routerHook.push('/logged-in/preferences/manage-subscription' as any),
            },
        ]
        : [];

    // "Report a Bug" row — only when Sentry is enabled (showFeedback() no-ops
    // otherwise, so a dead row would be misleading). Same gate as FeedbackFab.
    const feedbackOptions: PreferenceOption[] = SENTRY_ENABLED
        ? [
            {
                id: 'report-bug',
                title: t('preferences.reportBug'),
                icon: 'bug-report',
                onPress: showFeedback,
            },
        ]
        : [];

    // Define preference options
    const preferenceOptions: PreferenceOption[] = [
        {
            id: 'notifications',
            title: t('preferences.notifications'),
            icon: 'notifications',
            onPress: () => routerHook.push('/logged-in/preferences/notifications' as any),
        },
        {
            id: 'language',
            title: t('preferences.language'),
            icon: 'translate',
            onPress: () => routerHook.push('/logged-in/preferences/language' as any),
        },
        {
            id: 'mera-protocol',
            title: t('preferences.meraProtocol'),
            icon: 'security',
            onPress: () => routerHook.push('/logged-in/preferences/mera-protocol' as any),
        },
        {
            id: 'support',
            title: t('preferences.support'),
            icon: 'support-agent',
            onPress: () => Linking.openURL(`mailto:${SUPPORT_EMAIL}`),
        },
        {
            id: 'manage-data',
            title: t('preferences.manageData'),
            icon: 'storage',
            onPress: () => routerHook.push('/logged-in/preferences/manage-data' as any),
        },
        {
            id: 'observability',
            title: 'Observability',
            icon: 'monitor-heart',
            onPress: () => routerHook.push('/logged-in/preferences/observability' as any),
        },
        ...feedbackOptions,
        ...subscriptionOptions,
        {
            id: 'logout',
            title: t('preferences.logout'),
            icon: 'logout',
            onPress: () => openModal('logout'),
            type: 'danger',
        },

    ];

    // Render option item as outline button
    const renderOption = (option: PreferenceOption) => {
        const isDanger = option.type === 'danger';
        const textColor = isDanger ? 'text-red-400' : 'text-white';

        return (
            <Pressable
                key={option.id}
                className="flex-row items-center justify-between py-3 px-4 mb-3 border border-gray-700 rounded-lg"
                onPress={option.onPress}
            >
                {option.id === 'language' ? (
                    <HStack className="items-center flex-1" space="md">
                        <Text className={`text-base ${textColor}`}>
                            {LANGUAGE_WORD_BY_CODE[appLanguage] ?? 'Language'}
                        </Text>
                        <LanguageWordTicker />
                    </HStack>
                ) : (
                    <Text className={`text-base ${textColor}`}>
                        {option.title}
                    </Text>
                )}
                <MaterialIcons
                    name="chevron-right"
                    size={20}
                    color="#999999"
                />
            </Pressable>
        );
    };

    return (
        <Box className="flex-1 bg-black">
            <VStack className="px-5 pt-2 pb-3">
                <Text size="sm" className="text-gray-400">
                    {t('preferences.manageSettings')}
                </Text>
            </VStack>

            <Box className="flex-1 px-5">
                <VStack>
                    {preferenceOptions.map(renderOption)}
                </VStack>
                <Box className="items-center py-4">
                    <HStack space="sm" className="items-center justify-center flex-wrap mb-4">
                        <PolicyPill label={t('preferences.privacyPolicy')} onPress={() => openInAppBrowser(withAppLanguage(PRIVACY_URL))} />
                        <PolicyPill label={t('preferences.termsOfService')} onPress={() => openInAppBrowser(withAppLanguage(TERMS_URL))} />
                        <PolicyPill label={t('preferences.contentPolicy')} onPress={() => openInAppBrowser(withAppLanguage(CONTENT_POLICY_URL))} />
                    </HStack>
                    <HStack space="lg" className="items-center mb-3">
                        <Pressable onPress={() => openInAppBrowser(GITHUB_URL)} hitSlop={8}>
                            <FontAwesome name="github" size={22} color="#9ca3af" />
                        </Pressable>
                        <Pressable onPress={() => openInAppBrowser(WEBSITE_URL)} hitSlop={8}>
                            <MaterialIcons name="language" size={24} color="#9ca3af" />
                        </Pressable>
                    </HStack>
                    {maskedEmail && (
                        <Text size="xs" className="text-gray-500 mb-1">
                            User: {maskedEmail}
                        </Text>
                    )}
                    <Text size="xs" className="text-gray-500">
                        App Version: {getAppVersionLabel()}
                    </Text>
                    <Text size="xs" className="text-gray-500 mt-1">
                        © {new Date().getFullYear()} Mera Labs B.V.
                    </Text>
                </Box>
            </Box>

            {/* Logout Confirmation Modal */}
            <Modal isOpen={showLogoutModal} onClose={() => closeModal('logout')} size="sm">
                <ModalBackdrop />
                <ModalContent >
                    <ModalHeader className="border-gray-700 pb-4">
                        <Text className="text-xl font-semibold text-white">{t('preferences.signOutModalTitle')}</Text>
                    </ModalHeader>
                    <ModalBody className="py-6">
                        <Text className="text-gray-300 text-base leading-relaxed">
                            {t('preferences.signOutConfirm')}
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
                        <VStack className="w-full" space="md">
                            <Button
                                action="negative"
                                onPress={handleActualLogout}
                                disabled={isLoggingOut}
                                className="w-full"
                            >
                                <ButtonText>
                                    {isLoggingOut ? t('preferences.signingOut') : t('preferences.signOut')}
                                </ButtonText>
                            </Button>
                            <Button
                                variant="outline"
                                action="secondary"
                                onPress={() => closeModal('logout')}
                                className="w-full"
                            >
                                <ButtonText>{t('common.cancel')}</ButtonText>
                            </Button>
                        </VStack>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </Box>
    );
};


export default AppPreferencesTab;
