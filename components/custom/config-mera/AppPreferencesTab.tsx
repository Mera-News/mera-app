import { GlassPanel } from '@/components/custom/GlassSurface';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { authClient, clearAuthStorage } from '@/lib/auth-client';
import { usePinStore } from '@/lib/stores/pin-store';
import { CONTENT_POLICY_URL, FAQ_URL, GITHUB_URL, PRIVACY_URL, SUPPORT_EMAIL, TERMS_URL, WEBSITE_URL } from '@/lib/config/branding';
import { showFeedback } from '@/lib/feedback';
import { SENTRY_ENABLED } from '@/lib/sentry-init';
import { useLogoutModal, useUIStore } from '@/lib/stores/ui-store';
import { getAppVersionLabel } from '@/lib/version';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
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
    type?: 'normal' | 'danger' | 'feedback';
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
            // Explicit logout clears the local PIN and the opt-in flag with it
            // — the next user on this device starts with the lock off, and
            // must turn it on themselves to get one.
            await usePinStore.getState().setLockEnabled(false);

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
            id: 'display',
            title: t('display.title'),
            icon: 'palette',
            onPress: () => routerHook.push('/logged-in/preferences/display' as any),
        },
        {
            id: 'security',
            title: t('security.title'),
            icon: 'lock',
            onPress: () => routerHook.push('/logged-in/preferences/security' as any),
        },
        {
            id: 'support',
            title: t('preferences.support'),
            icon: 'support-agent',
            onPress: () => Linking.openURL(`mailto:${SUPPORT_EMAIL}`),
        },
        {
            id: 'faq',
            title: t('preferences.faq'),
            icon: 'help-outline',
            onPress: () => openInAppBrowser(withAppLanguage(FAQ_URL)),
        },
        {
            id: 'manage-data',
            title: t('preferences.manageData'),
            icon: 'storage',
            onPress: () => routerHook.push('/logged-in/preferences/manage-data' as any),
        },
        {
            id: 'observability',
            title: t('observability.title'),
            icon: 'monitor-heart',
            onPress: () => routerHook.push('/logged-in/preferences/observability' as any),
        },
        ...subscriptionOptions,
        // "Report a Bug" sits just above Logout, tinted Mera-orange so it reads
        // as distinct from the neutral rows. Only shown when Sentry is enabled
        // (showFeedback() no-ops otherwise). Tapping opens the feedback popup.
        ...(SENTRY_ENABLED
            ? [
                {
                    id: 'report-bug',
                    title: t('preferences.reportBug'),
                    icon: 'bug-report' as const,
                    onPress: showFeedback,
                    type: 'feedback' as const,
                },
            ]
            : []),
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
        const isFeedback = option.type === 'feedback';
        const textColor = isDanger
            ? 'text-red-400'
            : isFeedback
                ? 'text-primary-400'
                : 'text-white';
        // Tint the feedback row's border to match its Mera-orange label.
        const borderColor = isFeedback ? 'border-primary-400/50' : 'border-gray-700';

        // Liquid Glass row: GlassPanel owns the rounded/clipped outer surface
        // (glass fill on iOS 26+, nothing otherwise) — the Pressable inside
        // keeps its original padding/layout untouched, and the fallback
        // reproduces the pre-glass bordered/transparent look exactly so
        // Android/iOS<26 render identically to before.
        return (
            <GlassPanel
                key={option.id}
                radius={8}
                className="mb-3"
                fallbackClassName={`border ${borderColor} bg-transparent`}
            >
                <Pressable
                    className="flex-row items-center justify-between py-3 px-4"
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
            </GlassPanel>
        );
    };

    return (
        // No `bg-black`: SettingsTabScreen mounts AbstractGradientBackdrop
        // behind this content — an opaque fill here would fully block it,
        // leaving the glass rows below with nothing to refract (a solid
        // background over glass cancels it).
        //
        // No `flex-1` here (or on the Box below): this screen is mounted
        // inside SettingsTabScreen's ScrollView, which already stretches via
        // `contentContainerStyle={{ flexGrow: 1 }}` and reserves
        // `insets.bottom + TAB_BAR_HEIGHT + 24` of bottom padding. A `flex-1`
        // wrapper here fights that flexGrow chain and can consume the
        // reserved padding, leaving the user/version/copyright footer behind
        // the floating tab bar — let content size to its natural height so
        // the ScrollView's own padding is what clears the tab bar.
        <Box>
            <VStack className="px-5 pt-2 pb-3">
                <Text size="sm" className="text-gray-400">
                    {t('preferences.manageSettings')}
                </Text>
            </VStack>

            <Box className="px-5">
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
                            {t('preferences.user', { email: maskedEmail })}
                        </Text>
                    )}
                    <Text size="xs" className="text-gray-500">
                        {t('preferences.appVersion', { version: getAppVersionLabel() })}
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
