import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { authClient, clearAuthStorage } from '@/lib/auth-client';
import { clearDeviceAuthCredentials } from '@/lib/device-auth';
import { showDialog } from '@/lib/dialog';
import logger from '@/lib/logger';
import { clearAllStores } from '@/lib/stores';
import { useUIStore } from '@/lib/stores/ui-store';
import { router } from 'expo-router';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Delete account: asks twice, then requests the 30-day deletion, signs out,
 * severs the device binding and wipes. Its row sits above Log out in
 * Settings › Account. Returns the handler that starts the two confirmations.
 */
export function useDeleteAccount(): () => Promise<void> {
    const toast = useToast();
    const { t } = useTranslation();
    const { closeModal, setModalProcessing } = useUIStore();

    const handleDeleteAccount = useCallback(async () => {
        let serverDeleteSucceeded = false;
        try {
            setModalProcessing('deleteAccount', true);
            closeModal('deleteAccount');

            // authClient.deleteUser() now 404s unconditionally — the server has
            // replaced immediate deletion with a 30-day grace period. `$fetch`
            // resolves `{ data, error }` rather than throwing on a non-2xx
            // response, so success must be read from `error` being absent, not
            // from the call merely completing.
            const { error } = await authClient.$fetch('/request-account-deletion', {
                method: 'POST',
            });
            if (error) throw error;
            serverDeleteSucceeded = true;

            // Local cleanup after the server accepted the deletion. Each step
            // runs on its own, so one failing (a keychain hiccup, a sign-out
            // that throws) cannot skip the steps after it, and each failure is
            // reported by name rather than swallowed.
            const cleanupStep = async (step: string, run: () => Promise<void> | void) => {
                try {
                    await run();
                } catch (error) {
                    logger.captureException(error, {
                        tags: { component: 'useDeleteAccount', method: 'deleteAccount', step },
                    });
                }
            };
            // clearAuthStorage() owns the (guarded, bounded) server sign-out,
            // see its header. A direct signOut here once let a network failure
            // skip the whole local cleanup silently.
            await cleanupStep('sign-out', () => clearAuthStorage());
            // DELETION SEVERS the device binding (S10). Logout preserves it so
            // login resumes the account; deletion must not. The server deletes
            // the device record too, so this is the client half.
            await cleanupStep('device-credentials', () => clearDeviceAuthCredentials());
            await cleanupStep('route', () => {
                router.dismissAll();
                // The LOGOUT route, not '/': the launch gate counts the
                // still-stale better-auth session atom as identity and
                // re-entered the app with a dead session (BUG 4). signedOut
                // suppresses login.tsx's mirror-image shortcut until the atom
                // actually clears.
                router.replace({ pathname: '/login', params: { signedOut: '1' } });
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
            await cleanupStep('stores', () => clearAllStores());

            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('preferences.accountDeletionScheduledTitle')}</ToastTitle>
                        <ToastDescription>{t('preferences.accountDeletionScheduledDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } catch {
            if (!serverDeleteSucceeded) {
                toast.show({
                    placement: 'top',
                    render: () => (
                        <Toast action="error" variant="solid">
                            <ToastTitle>{t('preferences.deletionFailedTitle')}</ToastTitle>
                            <ToastDescription>{t('preferences.deletionFailedDescription')}</ToastDescription>
                        </Toast>
                    ),
                });
            }
        } finally {
            setModalProcessing('deleteAccount', false);
        }
    }, [closeModal, setModalProcessing, toast, t]);

    // Delete account asks twice before it does anything (App Store 5.1.1(v)).
    const confirmDeleteAccount = useCallback(async () => {
        const first = await showDialog({
            title: t('preferences.deleteAccount'),
            body: t('preferences.deleteAccountConfirmGrace'),
            warning: t('preferences.deleteAccountWarningGrace'),
            confirmLabel: t('preferences.continue'),
            cancelLabel: t('common.cancel'),
            destructive: true,
        });
        if (!first) return;
        const second = await showDialog({
            title: t('preferences.finalConfirmation'),
            body: t('preferences.finalConfirmationBodyGrace'),
            warning: t('preferences.absolutelySure'),
            confirmLabel: t('preferences.yesDeleteAccount'),
            cancelLabel: t('common.cancel'),
            destructive: true,
        });
        if (second) await handleDeleteAccount();
    }, [handleDeleteAccount, t]);

    return confirmDeleteAccount;
}
