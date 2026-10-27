import MeraToast from '@/components/custom/toast/MeraToast';
import { useToast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { backupCadence, backupProviderId } from '@/lib/backup/backup-settings';
import { FAQ_URL } from '@/lib/config/branding';
import { deleteSetting, getSetting, setSetting } from '@/lib/database/services/setting-service';
import { showDialog } from '@/lib/dialog';
import { useSupportAction } from '@/lib/intercom';
import { signOutAndWipe } from '@/lib/security/local-wipe';
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

            // Explicit logout turns the PIN lock off, so the next user on this
            // device starts with it off. Ahead of the sign-out because
            // setLockEnabled() also drops the in-memory lock state the tab shell
            // is still rendering against. Non-fatal: it throws on a keychain
            // write failure, and the wipe deletes the same keys anyway.
            try {
                await usePinStore.getState().setLockEnabled(false);
            } catch {
                // Covered by the wipe.
            }

            // Sign out, drop cached_user_id, route to the signed-out login, then
            // erase everything local: signOutAndWipe owns that order. Only a
            // failed erase rejects, and it lands in the catch below.
            await signOutAndWipe();

            toast.show({
                render: () => (
                    <MeraToast
                        tone="success"
                        title={t('preferences.signedOutTitle')}
                        body={t('preferences.signedOutDescription')}
                    />
                ),
            });
        } catch {
            toast.show({
                render: () => (
                    <MeraToast
                        tone="error"
                        title={t('preferences.logoutFailedTitle')}
                        body={t('preferences.logoutFailedDescription')}
                    />
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
