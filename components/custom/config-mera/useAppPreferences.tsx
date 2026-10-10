import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { authClient, clearAuthStorage } from '@/lib/auth-client';
import { backupCadence, backupProviderId } from '@/lib/backup/backup-settings';
import { FAQ_URL } from '@/lib/config/branding';
import { deleteSetting, getSetting, setSetting } from '@/lib/database/services/setting-service';
import { showDialog } from '@/lib/dialog';
import { useSupportAction } from '@/lib/intercom';
import { yieldToEventLoop } from '@/lib/scheduler/idle';
import { wipeAllLocalUserData } from '@/lib/security/local-wipe';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { usePinStore } from '@/lib/stores/pin-store';
import { useTextScaleStore } from '@/lib/stores/text-scale-store';
import { useUIStore } from '@/lib/stores/ui-store';
import { useUserStore } from '@/lib/stores/user-store';
import { resolveAccountEmailView } from '@/lib/subscription/email-capture';
import { toastManager } from '@/lib/toast-manager';
import { TEXT_SCALE_STEPS } from '@/lib/algorithms/scale';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { router } from 'expo-router';
import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useDeleteAccount } from './use-delete-account';


/** Developer mode: a plain settings row (wiped with the settings table on an
 *  account switch; never backed up). It shows Observability and the build. */
const DEVELOPER_MODE_KEY = 'developer_mode';
/** Three taps on the version line within this long toggle developer mode. */
const DEV_TAP_WINDOW_MS = 1500;

/** How long the FAQ row shows its spinner. The in-app browser gives no
 *  "presented" event (openBrowserAsync resolves on DISMISS), so this covers the
 *  tap-to-sheet interval and blocks a double tap, and no more. */
const FAQ_OPENING_MS = 1000;

export function useAppPreferences() {
    const toast = useToast();
    const { t } = useTranslation();

    // Shared with the paywall footer and BlockedBanner. `busy` drives the
    // spinner in the chevron slot; every fallback decision lives in the hook.
    const { busy: supportBusy, openSupport } = useSupportAction();
    const appLanguage = useAppLanguageStore((s) => s.appLanguage);
    const processingMode = useMeraProtocolStore((s) => s.processingMode);
    const textScale = useTextScaleStore((s) => s.scale);
    const lockEnabled = usePinStore((s) => s.lockEnabled);
    const { data: session } = authClient.useSession();
    // LOCAL first: the stored email survives offline and auth blips; the
    // session is the fallback. One derivation, shared with email-capture.
    const cachedEmail = useUserStore((s) => s.userEmail);
    const { displayEmail } = resolveAccountEmailView({
        storedEmail: cachedEmail,
        sessionUser: session?.user ?? null,
    });

    const { closeModal, setModalProcessing } = useUIStore();
    const confirmDeleteAccount = useDeleteAccount();

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
            // reached from the You tab's Settings page, with nothing pushed above it,
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
            await yieldToEventLoop();
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

    const confirmLogout = async () => {
        const ok = await showDialog({
            title: t('preferences.signOutModalTitle'),
            body: t('preferences.signOutConfirm'),
            confirmLabel: t('preferences.signOut'),
            cancelLabel: t('common.cancel'),
            destructive: true,
        });
        if (ok) await handleActualLogout();
    };

    // Values read from synchronous mirrors or rows (backup, developer mode)
    // re-render on focus: a change made a moment ago on a pushed screen is
    // otherwise invisible here.
    const [, setFocusTick] = React.useState(0);
    const [devMode, setDevMode] = React.useState(false);
    const refreshOnFocus = useCallback(() => {
        setFocusTick((n) => n + 1);
        getSetting(DEVELOPER_MODE_KEY)
            .then((v) => setDevMode(v === '1'))
            .catch(() => { /* off */ });
    }, []);
    const setDeveloperMode = useCallback(
        async (on: boolean) => {
            setDevMode(on);
            try {
                if (on) await setSetting(DEVELOPER_MODE_KEY, '1');
                else await deleteSetting(DEVELOPER_MODE_KEY);
            } catch {
                // The row stays as it was; the switch shows it on the next focus.
            }
            if (on) toastManager.showInfo(t('you.settings.developerOn'));
        },
        [t],
    );
    const versionTaps = useRef<number[]>([]);
    const onVersionTap = () => {
        const now = Date.now();
        versionTaps.current = [...versionTaps.current.filter((at) => now - at < DEV_TAP_WINDOW_MS), now];
        if (versionTaps.current.length >= 3) {
            versionTaps.current = [];
            void setDeveloperMode(!devMode);
        }
    };

    const backupOn = backupCadence() !== 'off' && backupProviderId() !== null;

    const textStep = Math.max(0, TEXT_SCALE_STEPS.indexOf(textScale as never));

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

    return {
        supportBusy,
        openSupport,
        appLanguage,
        processingMode,
        lockEnabled,
        displayEmail,
        confirmDeleteAccount,
        confirmLogout,
        devMode,
        setDeveloperMode,
        onVersionTap,
        refreshOnFocus,
        backupOn,
        textStep,
        faqOpening,
        openFaq,
    };
}
