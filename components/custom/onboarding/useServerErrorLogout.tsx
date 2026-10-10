import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { signOutAndWipe } from '@/lib/security/local-wipe';

export function useServerErrorLogout(setShowServerError: (v: boolean) => void) {
    const [isLoggingOut, setIsLoggingOut] = useState(false);
    const toast = useToast();
    const { t } = useTranslation();

    const handleServerErrorLogout = async () => {
        try {
            setIsLoggingOut(true);
            setShowServerError(false);
            // Signs out (guarded, bounded), drops the identity stamp, routes to
            // /login and wipes. Only the wipe can still throw.
            await signOutAndWipe();
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('onboarding.logoutFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('onboarding.logoutFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsLoggingOut(false);
        }
    };

    return { isLoggingOut, handleServerErrorLogout };
}
