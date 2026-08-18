import { GlassPanel } from '@/components/custom/GlassSurface';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { authClient, clearAuthStorage } from '@/lib/auth-client';
import { wipeAllLocalUserData } from '@/lib/security/local-wipe';
import { deleteSetting } from '@/lib/database/services/setting-service';
import { usePinStore } from '@/lib/stores/pin-store';
import { CONTENT_POLICY_URL, FAQ_URL, GITHUB_URL, PRIVACY_URL, SUPPORT_EMAIL, TERMS_URL, WEBSITE_URL } from '@/lib/config/branding';
import { showFeedback } from '@/lib/feedback';
import { SENTRY_ENABLED } from '@/lib/sentry-init';
import { useLogoutModal, useUIStore } from '@/lib/stores/ui-store';
import { useUserStore } from '@/lib/stores/user-store';
import { getAppVersionLabel } from '@/lib/version';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { FontAwesome, MaterialIcons } from '@expo/vector-icons';
import { router, useRouter } from 'expo-router';
import React from 'react';
import { Linking } from 'react-native';
import { isRevenueCatConfigured } from '@/lib/revenuecat';
import { useSupportAction } from '@/lib/intercom';
import {
    requestEmailCapture,
    resolveAccountEmailView,
} from '@/lib/subscription/email-capture';
import { readSupportIdFromUser } from '@/lib/support-id';
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
    // Shared with the paywall footer and BlockedBanner. `busy` drives the
    // spinner in the chevron slot; every fallback decision lives in the hook.
    const { busy: supportBusy, openSupport } = useSupportAction();
    const appLanguage = useAppLanguageStore((s) => s.appLanguage);
    const { data: session } = authClient.useSession();
    // LOCAL first. This used to be `session?.user?.email` alone, so any window
    // where better-auth could not produce a session — offline, a keychain-locked
    // background wake, a 401 blip — dropped the email row entirely and made a
    // still-signed-in user look logged out. The store's copy comes from the
    // `cached_user_email` row written at sign-in and is cleared only by an
    // explicit logout. Session is kept as the fallback for installs that signed
    // in before that row was hydrated here.
    const cachedEmail = useUserStore((s) => s.userEmail);
    // ONE derivation for the identity footer and the "Add email address" row,
    // shared with the email-capture module so precedence cannot drift. The
    // rule that matters (F1): a real STORED email wins over the session,
    // because the store flips the instant an in-session attach confirms while
    // the session atom can stay stale until its next refetch. The fabricated
    // @anon.mera.news address is never displayed as the user's.
    const { isAnonAccount, displayEmail } = resolveAccountEmailView({
        storedEmail: cachedEmail,
        sessionUser: session?.user ?? null,
    });
    // The 8-digit support handle minted for device sign-in accounts; it
    // survives an email attach, so it shows for anonymous AND email-attached
    // accounts. Session-only by design: absent (null) simply hides the row.
    const supportId = readSupportIdFromUser(session?.user);
    const maskedEmail = React.useMemo(() => {
        if (!displayEmail) return null;
        const atIdx = displayEmail.lastIndexOf('@');
        if (atIdx <= 0) return displayEmail;
        const local = displayEmail.slice(0, atIdx);
        const domain = displayEmail.slice(atIdx);
        const visibleCount = Math.ceil(local.length / 2);
        return local.slice(0, visibleCount) + '•'.repeat(local.length - visibleCount) + domain;
    }, [displayEmail]);

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

            // No direct authClient.signOut() here: clearAuthStorage() owns
            // the server sign-out, guarded and bounded. A direct unguarded
            // await once let a staging outage reject into the catch below with
            // NOTHING cleared — the device relaunched signed in.
            await clearAuthStorage();
            // ── PAST THIS LINE NOTHING MAY THROW ──────────────────────────
            // clearAuthStorage() has already deleted the cookie, so the device
            // is half-signed-out. Every remaining step is individually guarded
            // so the flow ALWAYS reaches wipeAllLocalUserData() — that wipe is
            // what drops the settings table and makes the state self-healing.
            // Bailing out in the middle would strand the device with no
            // credentials but a live `cached_user_id`, which reads as
            // 'present' to the launch gate: the orphan purge would never fire,
            // and the previous user's data would keep being served offline
            // forever. That is the original bug, so it must be unreachable.

            // Explicit logout clears the local PIN and the opt-in flag with it
            // — the next user on this device starts with the lock off, and must
            // turn it on themselves to get one. Kept ahead of the wipe rather
            // than folded into it: this is the path that runs while the user is
            // watching, and setLockEnabled() also drops the in-memory lock state
            // the tab shell is still rendering against. Non-fatal: it persists
            // to the keychain and THROWS on a write failure, and the wipe below
            // deletes the same three keys anyway.
            try {
                await usePinStore.getState().setLockEnabled(false);
            } catch {
                // Covered by wipeAllLocalUserData().
            }

            // Drop the local identity sentinel BEFORE navigating rather than
            // leaving it to the wipe below. `cached_user_id` is what
            // hasLocalIdentity() reads, and app/logged-in/index.tsx re-WRITES
            // it via setUserId() — so any gate that runs while the row still
            // exists routes back into the app AND re-poisons the identity we
            // are clearing. Deleting one settings row unmounts nothing (no
            // screen renders from it), so the "navigate before the wipe"
            // ordering below is preserved.
            //
            // NOTE: only an *explicit* logout does this. A dead server session
            // must keep its local identity — that asymmetry is the whole point
            // of the offline-first gate in lib/security/launch-route.ts.
            //
            // Non-fatal for the reason above: deleteSetting rethrows anything
            // that isn't a benign "deleted record" race, and the wipe drops the
            // whole settings table regardless.
            try {
                await deleteSetting('cached_user_id');
            } catch {
                // Covered by wipeAllLocalUserData().
            }

            // dismissAll() pops a stack back to its first screen. Logout is
            // reached from the Settings TAB, which has nothing pushed above it,
            // so there the call is a no-op whose only effect is the
            // "POP_TO_TOP was not handled by any navigator" warning. Guarded
            // rather than deleted: the same tab pushes preference screens, and
            // a logout reached from one of those still needs the pop.
            if (router.canDismiss()) router.dismissAll();

            // Straight to /login, NOT '/'. The launch gate (app/index.tsx)
            // counts a live useSession() as identity, and better-auth does not
            // clear that atom synchronously on signOut(): it toggles
            // $sessionSignal on a 10ms timer and only nulls `data` once
            // /get-session round-trips. Routing through '/' inside that window
            // sends the just-signed-out user straight back in. `signedOut: '1'`
            // suppresses login.tsx's mirror-image session shortcut for the same
            // window (it releases itself once the session actually clears).
            router.replace({ pathname: '/login', params: { signedOut: '1' } });

            // Yield a tick so the screens above unmount before their data
            // disappears underneath them, then erase EVERYTHING local —
            // keychain secrets (incl. the E2EE pipeline key), the legacy
            // AsyncStorage key, RevenueCat identity, the PIN state and the whole
            // WatermelonDB + Zustand layer. Logout leaves nothing to serve, so
            // there is no offline mode afterwards. Same navigate-then-wipe shape
            // as handleDeleteAccount in ManageDataScreen.tsx.
            await new Promise((resolve) => setTimeout(resolve, 0));
            await wipeAllLocalUserData();

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
            // FIRST on purpose — it is the "start here" row, and there is no
            // other in-app explanation of how mera works (the FAQ leaves the app).
            id: 'tutorials',
            title: t('tutorials.entryRow'),
            icon: 'school',
            // Top-level route, deliberately outside `/logged-in`: the same
            // guides are reachable signed out (from the paywall).
            onPress: () => routerHook.push('/tutorials' as any),
        },
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
            // Security's PIN + blur-images controls now live on this screen
            // too (the standalone Security screen/row was deleted) — see
            // DisplaySettingsScreen.tsx's header doc.
            id: 'display',
            title: t('display.screenTitle'),
            icon: 'palette',
            onPress: () => routerHook.push('/logged-in/preferences/display' as any),
        },
        {
            id: 'support',
            title: t('preferences.support'),
            icon: 'support-agent',
            // Opens the Intercom Messenger, or falls back to mail. The whole
            // decision lives in useSupportAction so this row, the paywall
            // footer and BlockedBanner cannot drift apart.
            onPress: () => { void openSupport(); },
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
        // Only for accounts that came in via device sign-in and never added a
        // real email. Opens the same sheet the post-purchase offer uses; the
        // host is mounted in app/logged-in/_layout.tsx.
        ...(isAnonAccount
            ? [
                {
                    id: 'add-email',
                    title: t('emailCapture.settingsRow'),
                    icon: 'alternate-email' as const,
                    onPress: () => requestEmailCapture('settings'),
                },
            ]
            : []),
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
                    // One line, every row. This list had NO testIDs at all, so
                    // the simulator harness could not tap a single settings row.
                    testID={`settings-row-${option.id}`}
                    className="flex-row items-center justify-between py-3 px-4"
                    onPress={option.onPress}
                    accessibilityRole="button"
                    // "busy", not "disabled": the control still accepts input,
                    // it is just working. Announcing it as disabled would be a
                    // lie to a screen reader.
                    accessibilityState={
                        option.id === 'support' && supportBusy ? { busy: true } : undefined
                    }
                    accessibilityLabel={
                        option.id === 'support' && supportBusy
                            ? t('support.opening')
                            : undefined
                    }
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
                    {/* The spinner takes the chevron's slot rather than
                        sitting beside it, so the row does not reflow while
                        support is opening. Both are 20px in a 20px box. The
                        row is deliberately NOT disabled: re-entry is guarded
                        by a ref inside useSupportAction, so a second tap is a
                        no-op without the row greying out and looking broken. */}
                    <Box className="w-5 h-5 items-center justify-center">
                        {option.id === 'support' && supportBusy ? (
                            <Spinner size="small" />
                        ) : (
                            <MaterialIcons
                                name="chevron-right"
                                size={20}
                                color="#999999"
                            />
                        )}
                    </Box>
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
                    {/* displayEmail is already null for anonymous accounts, so
                        no extra isAnonAccount guard is needed here. */}
                    {maskedEmail && (
                        <Text size="xs" className="text-gray-500 mb-1">
                            {t('preferences.user', { email: maskedEmail })}
                        </Text>
                    )}
                    {supportId && (
                        <Text size="xs" className="text-gray-500 mb-1" testID="settings-support-id">
                            {t('support.supportId', { id: supportId })}
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
