import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { clearAuthStorage } from '@/lib/auth-client';

export function useServerErrorLogout(setShowServerError: (v: boolean) => void) {
    const [isLoggingOut, setIsLoggingOut] = useState(false);
    const toast = useToast();
    const { t } = useTranslation();

    const handleServerErrorLogout = async () => {
        try {
            setIsLoggingOut(true);
            setShowServerError(false);
            // clearAuthStorage() owns the guarded, bounded server sign-out.
            await clearAuthStorage();
            router.replace('/');
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
