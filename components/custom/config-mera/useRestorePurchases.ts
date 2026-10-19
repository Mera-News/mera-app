import logger from '@/lib/logger';
import { getActiveTier, restoreRevenueCatPurchases } from '@/lib/revenuecat';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { syncEntitlement } from '@/lib/subscription/entitlement-sync';
import { holdRestartAcrossPurchase } from '@/lib/subscriptions/subscribe-flow';
import { toastManager } from '@/lib/toast-manager';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

/** Settings > Restore purchases: ask the store, refresh the entitlement, say what happened. */
export function useRestorePurchases() {
    const { t } = useTranslation();
    const [restoring, setRestoring] = useState(false);

    const restore = useCallback(async () => {
        if (restoring) return;
        setRestoring(true);
        const ios = Platform.OS === 'ios';
        // Before the call: iOS can show the Apple Account sheet, a real departure. Timer-owned release.
        holdRestartAcrossPurchase('purchase');
        try {
            const info = await restoreRevenueCatPurchases();
            useSubscriptionStore.getState().setCustomerInfo(info);
            await syncEntitlement({ force: true });
            if (getActiveTier(info) !== null) {
                toastManager.showSuccess(t('subscription.planBack'), '');
            } else {
                toastManager.showInfo(t(ios ? 'subscription.restoreNoneApple' : 'subscription.restoreNoneGoogle'));
            }
        } catch (error) {
            logger.captureException(error, { tags: { component: 'useRestorePurchases' } });
            // showInfo, not showError: errors are debounced for 5s, which would swallow a retry's answer.
            toastManager.showInfo(t(ios ? 'subscription.restoreFailedAppStore' : 'subscription.restoreFailedPlayStore'));
        } finally {
            setRestoring(false);
        }
    }, [restoring, t]);

    return { restoring, restore };
}
