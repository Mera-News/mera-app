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
import { CONTENT_POLICY_URL, FAQ_URL, GITHUB_URL, PRIVACY_URL, TERMS_URL, WEBSITE_URL } from '@/lib/config/branding';
import { showFeedback } from '@/lib/feedback';
import { useLogoutModal, useUIStore } from '@/lib/stores/ui-store';
import { useUserStore } from '@/lib/stores/user-store';
import { getAppVersionLabel } from '@/lib/version';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { FontAwesome, MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback } from 'react';
import { useSupportAction } from '@/lib/intercom';
import { resolveAccountEmailView } from '@/lib/subscription/email-capture';
import { readSupportIdFromUser } from '@/lib/support-id';
import * as Clipboard from 'expo-clipboard';
import { hapticLight } from '@/lib/haptics';
import { useTranslation } from 'react-i18next';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { getNativeLanguageName } from '@/lib/translation-service';
import { backupCadence, backupLastRunAt, backupProviderId } from '@/lib/backup/backup-settings';
import PolicyPill from '@/components/custom/PolicyPill';
import SecuritySettingsSection from './SecuritySettingsSection';
import SettingsUsageCard from './SettingsUsageCard';

interface PreferenceOption {
    id: string;
    title: string;
    icon: keyof typeof MaterialIcons.glyphMap;
    onPress: () => void;
    /** Current value, shown right-aligned before the chevron. */
    value?: string | null;
    /** Replaces the chevron with a spinner while an action is starting. */
    busy?: boolean;
}

/** How long the FAQ row shows its spinner. The in-app browser gives no
 *  "presented" event (openBrowserAsync resolves on DISMISS), so this covers the
 *  tap-to-sheet interval and blocks a double tap, and no more. */
const FAQ_OPENING_MS = 1000;

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
    // S11: the "Add email address" row is gone — email attach happens at
    // checkout (required) and via the post-purchase fallback only. Settings
    // keeps the Support ID block and the masked email for accounts that have
    // one; isAnonAccount is no longer consumed here (displayEmail is already
    // null for anonymous accounts).
    const { displayEmail } = resolveAccountEmailView({
        storedEmail: cachedEmail,
        sessionUser: session?.user ?? null,
    });
    // The support handle minted for device sign-in accounts; it survives an
    // email attach, so it shows for anonymous AND email-attached accounts.
    // Session-only by design: absent (null) simply hides the row.
    const supportId = readSupportIdFromUser(session?.user);

    // Copy-to-clipboard feedback: no copy idiom existed in the app before this,
    // so the shape is the smallest honest one — haptic plus a brief localized
    // "Copied" swap that reverts on its own. Copies ONLY the numeric id.
    const [supportIdCopied, setSupportIdCopied] = React.useState(false);
    const supportIdCopyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(
        () => () => {
            if (supportIdCopyTimer.current) clearTimeout(supportIdCopyTimer.current);
        },
        [],
    );
    const handleCopySupportId = async () => {
        if (!supportId) return;
        try {
            await Clipboard.setStringAsync(supportId);
        } catch {
            // Clipboard unavailable — no feedback state, nothing to undo.
            return;
        }
        void hapticLight();
        setSupportIdCopied(true);
        if (supportIdCopyTimer.current) clearTimeout(supportIdCopyTimer.current);
        supportIdCopyTimer.current = setTimeout(() => setSupportIdCopied(false), 1800);
    };
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

    // The backup row reads the synchronous mirror (hydrated at startup), so it
    // re-renders on focus to pick up a backup or a setting changed on the
    // Manage data screen a moment ago.
    const [, setFocusTick] = React.useState(0);
    useFocusEffect(useCallback(() => setFocusTick((n) => n + 1), []));
    const backupValue = (() => {
        if (backupCadence() === 'off' || backupProviderId() === null) return t('backup.cadence.off');
        const last = backupLastRunAt();
        if (last === null) return t('settings.backupRowNever');
        try {
            return new Date(last).toLocaleDateString(appLanguage, { month: 'short', day: 'numeric' });
        } catch {
            return new Date(last).toLocaleDateString();
        }
    })();

    const [faqOpening, setFaqOpening] = React.useState(false);
    const faqTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => {
        if (faqTimer.current) clearTimeout(faqTimer.current);
    }, []);
    const openFaq = () => {
        if (faqOpening) return;
        setFaqOpening(true);
        faqTimer.current = setTimeout(() => setFaqOpening(false), FAQ_OPENING_MS);
        void openInAppBrowser(withAppLanguage(FAQ_URL));
    };

    // Five groups (ux1): General, Privacy and data, Security, Help, Account.
    // Route paths are unchanged; the harness drives these rows by testID.
    const general: PreferenceOption[] = [
        {
            id: 'language',
            title: t('settings.languageRow'),
            icon: 'translate',
            // The CURRENT language, in its own script. The row used to cycle
            // the word "Language" through 19 scripts and never said which one
            // was on; a frame of that ticker is how "언어" showed up on an
            // English phone.
            value: getNativeLanguageName(appLanguage),
            onPress: () => routerHook.push('/logged-in/preferences/language' as any),
        },
        {
            id: 'display',
            title: t('display.screenTitle'),
            icon: 'palette',
            onPress: () => routerHook.push('/logged-in/preferences/display' as any),
        },
        {
            id: 'notifications',
            title: t('preferences.notifications'),
            icon: 'notifications',
            onPress: () => routerHook.push('/logged-in/preferences/notifications' as any),
        },
    ];

    const privacy: PreferenceOption[] = [
        {
            id: 'mera-protocol',
            title: t('preferences.meraProtocol'),
            icon: 'security',
            onPress: () => routerHook.push('/logged-in/preferences/mera-protocol' as any),
        },
        {
            // Backup and restore share one row. Manage data opens with the
            // backup section first, so there is nothing to scroll past; the
            // restore deep link (`manage-data?restore=1`) still works for the
            // harness and old links.
            id: 'backup',
            title: t('settings.backupRow'),
            icon: 'settings-backup-restore',
            value: backupValue,
            onPress: () => routerHook.push('/logged-in/preferences/manage-data' as any),
        },
        {
            id: 'manage-data',
            title: t('preferences.manageData'),
            icon: 'storage',
            onPress: () => routerHook.push('/logged-in/preferences/manage-data' as any),
        },
    ];

    const help: PreferenceOption[] = [
        {
            // The one home for "How Mera works". Top-level route, deliberately
            // outside `/logged-in`: the same guides are reachable signed out.
            id: 'tutorials',
            title: t('tutorials.entryRow'),
            icon: 'school',
            onPress: () => routerHook.push('/tutorials' as any),
        },
        {
            id: 'faq',
            title: t('preferences.faq'),
            icon: 'help-outline',
            busy: faqOpening,
            onPress: openFaq,
        },
    ];

    // Account holds only Log out: plan management is the usage card's
    // "Manage plan" button at the top of this list (SettingsUsageCard).

    const sectionLabel = (id: string, text: string) => (
        <Text
            testID={`settings-group-${id}`}
            size="xs"
            className="text-gray-400 font-semibold uppercase mt-4 mb-2"
            accessibilityRole="header"
        >
            {text}
        </Text>
    );

    const renderOption = (option: PreferenceOption) => {
        // Liquid Glass row: GlassPanel owns the rounded/clipped outer surface
        // (glass fill on iOS 26+, nothing otherwise); the Pressable inside
        // keeps its padding and layout.
        return (
            <GlassPanel
                key={option.id}
                radius={8}
                className="mb-3"
                fallbackClassName="border border-gray-700 bg-transparent"
            >
                <Pressable
                    // One line, every row: the harness taps rows by testID.
                    testID={`settings-row-${option.id}`}
                    className="flex-row items-center justify-between py-3 px-4"
                    onPress={option.onPress}
                    accessibilityRole="button"
                    accessibilityLabel={option.value ? `${option.title}, ${option.value}` : option.title}
                    accessibilityState={option.busy ? { busy: true } : undefined}
                >
                    <Text className="text-base text-white flex-1 mr-3" numberOfLines={2}>
                        {option.title}
                    </Text>
                    {option.value ? (
                        <Text
                            testID={`settings-row-${option.id}-value`}
                            size="sm"
                            className="text-gray-400 mr-2"
                            numberOfLines={1}
                        >
                            {option.value}
                        </Text>
                    ) : null}
                    <Box className="w-5 h-5 items-center justify-center">
                        {option.busy ? (
                            <Spinner size="small" />
                        ) : (
                            <MaterialIcons name="chevron-right" size={20} color="#999999" />
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
        // `useTabBarClearance() + 24` of bottom padding. A `flex-1`
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
                {/* The plan and today's usage, first (owner call). Its Manage
                    plan button is the only plan entry in Settings. */}
                <Box className="mt-2">
                    <SettingsUsageCard />
                </Box>

                {sectionLabel('general', t('settings.groupGeneral'))}
                <VStack>{general.map(renderOption)}</VStack>

                {sectionLabel('privacy', t('settings.groupPrivacy'))}
                <VStack>{privacy.map(renderOption)}</VStack>

                {sectionLabel('security', t('security.title'))}
                <SecuritySettingsSection />

                {sectionLabel('help', t('settings.groupHelp'))}
                <VStack>{help.map(renderOption)}</VStack>
                {/* Talk to support and Report a bug share one row. Report a
                    bug renders in every build but is inert in dev (Sentry is
                    off). Rows are never disabled while support opens: re-entry
                    is guarded inside useSupportAction. */}
                <HStack space="sm" className="mb-3">
                    <GlassPanel
                        radius={8}
                        className="flex-1"
                        fallbackClassName="border border-gray-700 bg-transparent"
                    >
                        <Pressable
                            testID="settings-row-support"
                            className="flex-row items-center justify-center py-3 px-2"
                            onPress={() => { void openSupport(); }}
                            accessibilityRole="button"
                            accessibilityState={supportBusy ? { busy: true } : undefined}
                            accessibilityLabel={
                                supportBusy ? t('support.opening') : t('preferences.support')
                            }
                        >
                            {supportBusy ? (
                                <Spinner size="small" />
                            ) : (
                                <HStack space="xs" className="items-center">
                                    <MaterialIcons name="support-agent" size={18} color="rgb(237, 167, 126)" />
                                    <Text className="text-base text-white" numberOfLines={1}>
                                        {t('preferences.support')}
                                    </Text>
                                </HStack>
                            )}
                        </Pressable>
                    </GlassPanel>
                    <GlassPanel
                        radius={8}
                        className="flex-1"
                        fallbackClassName="border border-primary-400/50 bg-transparent"
                    >
                        <Pressable
                            testID="settings-row-report-bug"
                            className="flex-row items-center justify-center py-3 px-2"
                            onPress={showFeedback}
                            accessibilityRole="button"
                            // Explicit, or the icon font's glyph leaks into it.
                            accessibilityLabel={t('preferences.reportBug')}
                        >
                            <HStack space="xs" className="items-center">
                                <MaterialIcons name="bug-report" size={18} color="rgb(237, 167, 126)" />
                                <Text className="text-base text-primary-400" numberOfLines={1}>
                                    {t('preferences.reportBug')}
                                </Text>
                            </HStack>
                        </Pressable>
                    </GlassPanel>
                </HStack>

                {sectionLabel('account', t('settings.groupAccount'))}
                {/* Log out is LAST, an ordinary row inside Account and behind
                    its confirmation, no longer a full-width red button right
                    above the tab bar. */}
                <GlassPanel
                    radius={8}
                    className="mb-3"
                    fallbackClassName="border border-gray-700 bg-transparent"
                >
                    <Pressable
                        testID="settings-row-logout"
                        className="flex-row items-center py-3 px-4"
                        onPress={() => openModal('logout')}
                        accessibilityRole="button"
                        // Explicit, or the icon font's glyph leaks into it.
                        accessibilityLabel={t('preferences.logout')}
                    >
                        <MaterialIcons name="logout" size={18} color="#fca5a5" />
                        <Text className="text-base text-red-300 ml-3">
                            {t('preferences.logout')}
                        </Text>
                    </Pressable>
                </GlassPanel>
                <Box className="items-center py-4">
                    <HStack space="sm" className="items-center justify-center flex-wrap mb-4">
                        <PolicyPill label={t('preferences.privacyPolicy')} onPress={() => openInAppBrowser(withAppLanguage(PRIVACY_URL))} />
                        <PolicyPill label={t('preferences.termsOfService')} onPress={() => openInAppBrowser(withAppLanguage(TERMS_URL))} />
                        <PolicyPill label={t('preferences.contentPolicy')} onPress={() => openInAppBrowser(withAppLanguage(CONTENT_POLICY_URL))} />
                    </HStack>
                    <HStack space="lg" className="items-center mb-3">
                        <Pressable
                            onPress={() => openInAppBrowser(GITHUB_URL)}
                            hitSlop={8}
                            // Icon-only links: existing copy names them.
                            accessibilityRole="link"
                            accessibilityLabel={t('auth.sourceCode')}
                            testID="settings-link-source-code"
                        >
                            <FontAwesome name="github" size={22} color="#9ca3af" />
                        </Pressable>
                        <Pressable
                            onPress={() => openInAppBrowser(WEBSITE_URL)}
                            hitSlop={8}
                            accessibilityRole="link"
                            accessibilityLabel={t('auth.website')}
                            testID="settings-link-website"
                        >
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
                        // accessible={false} on the row wrapper (F2 discipline):
                        // the text and the button carry their own semantics.
                        <HStack space="xs" className="items-center mb-1" accessible={false}>
                            <Text size="xs" className="text-gray-500" testID="settings-support-id">
                                {t('support.supportId', { id: supportId })}
                            </Text>
                            <Pressable
                                testID="settings-support-id-copy"
                                onPress={() => { void handleCopySupportId(); }}
                                hitSlop={8}
                                accessible
                                accessibilityRole="button"
                                accessibilityLabel={
                                    supportIdCopied ? t('support.copied') : t('support.copySupportId')
                                }
                            >
                                {supportIdCopied ? (
                                    <Text size="xs" className="text-primary-400">
                                        {t('support.copied')}
                                    </Text>
                                ) : (
                                    <MaterialIcons name="content-copy" size={14} color="#9ca3af" />
                                )}
                            </Pressable>
                        </HStack>
                    )}
                    {supportId && (
                        <Text size="xs" className="text-gray-500 mb-1 text-center" testID="settings-support-id-hint">
                            {t('support.saveHint')}
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
