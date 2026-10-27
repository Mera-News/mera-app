import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import MeraToast from '@/components/custom/toast/MeraToast';
import { useToast } from '@/components/ui/toast';
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
                render: () => (
                    <MeraToast
                        tone="error"
                        title={t('onboarding.logoutFailedTitle')}
                        body={t('onboarding.logoutFailedDescription')}
                    />
                ),
            });
        } finally {
            setIsLoggingOut(false);
        }
    };

    return { isLoggingOut, handleServerErrorLogout };
}
