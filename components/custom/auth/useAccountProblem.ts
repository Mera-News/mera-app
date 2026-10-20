import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { showDialog } from '@/lib/dialog';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useSupportAction } from '@/lib/intercom';
import { signOutAndWipe } from '@/lib/security/local-wipe';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { toastManager } from '@/lib/toast-manager';

/**
 * "There's a problem with your account" (the auth screen's reauth-no-email
 * stage) has exactly two ways out (owner, 2026-10-21):
 *
 * - Contact support: the one support path (Intercom, else mail). Signed out,
 *   Intercom cannot mint an identity, so it opens mail with the Support ID.
 * - Reset this phone: the logout's sign-out and local wipe (`signOutAndWipe`),
 *   NEVER a server deletion and never `clearDeviceAuthCredentials`, so the
 *   account stays and signing in with this phone resumes it. `onReset` moves
 *   the screen off the gate (cached_user_id is already gone).
 */
export function useAccountProblem({ onReset }: { onReset: () => void }) {
    const { t } = useTranslation();
    const { busy: supportBusy, openSupport } = useSupportAction();
    const [resetting, setResetting] = useState(false);

    const resetThisPhone = useCallback(async () => {
        const ok = await showDialog({
            title: t('gate.resetTitle'),
            body: t('gate.resetBody'),
            confirmLabel: t('gate.resetConfirm'),
            cancelLabel: t('common.cancel'),
            destructive: true,
        });
        if (!ok) return;
        setResetting(true);
        // The model files sit outside the wipe, but the wipe resets the mode,
        // and the next boot purges models on any phone not on on-device.
        const { processingMode, selectedModelId } = useMeraProtocolStore.getState();
        try {
            await signOutAndWipe();
        } catch {
            // Signed out already; the next launch finishes the erase.
            toastManager.showError(t('preferences.logoutFailedTitle'), t('preferences.logoutFailedDescription'));
        } finally {
            if (processingMode === ProcessingMode.OnDevice) {
                const store = useMeraProtocolStore.getState();
                store.setProcessingMode(processingMode);
                store.setSelectedModelId(selectedModelId);
            }
            setResetting(false);
            onReset();
        }
    }, [onReset, t]);

    return { contactSupport: openSupport, resetThisPhone, supportBusy, resetting };
}
