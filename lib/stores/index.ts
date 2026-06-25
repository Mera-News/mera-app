// Central store exports and utilities

// Existing stores
export { useForYouStore } from './for-you-store';
export { useUserStore } from './user-store';

// New stores
export { useUIStore, useLogoutModal, useDeleteAccountModal } from './ui-store';
export { useConfigPanelStore, useConfigPanelIsOpen, useConfigPanelActiveTab } from './config-panel-store';
export { useChatPopupStore, useChatPopupIsExpanded, useChatPopupConversationId } from './chat-popup-store';
export { useAppStateStore, useIsNavigationReady, useIsAppInitialized, useLastAuthenticatedUserId } from './app-state-store';
export {
    useOnboardingStore,
    useOnboardingStep,
    useOnboardingPreferences,
    useOnboardingIsInitializing,
    useOnboardingCompletedSteps,
} from './onboarding-store';
export {
    useMeraProtocolStore,
    useProcessingMode,
    useIsOnDeviceProcessing,
    useModelState,
    useDownloadProgress,
    useIsModelReady,
    useIsProcessing,
    useProcessProgress,
} from './mera-protocol-store';
export {
    useTopicSyncStore,
    useTopicSyncIsSyncing,
    useTopicSyncProgress,
    useTopicSyncError,
} from './topic-sync-store';
export {
    useNetworkStore,
    useIsConnected,
    initNetworkListener,
    stopNetworkListener,
} from './network-store';
export {
    useSubscriptionStore,
    useIsPremium,
    useSubscriptionTier,
} from './subscription-store';

// Selectors
export * from './selectors';

// Clear all stores on logout — wipes WatermelonDB + resets Zustand in-memory state
export const clearAllStores = async () => {
    const database = require('../database').default;
    const { useForYouStore } = require('./for-you-store');
    const { useUserStore } = require('./user-store');
    const { useUIStore } = require('./ui-store');
    const { useAppStateStore } = require('./app-state-store');
    const { useOnboardingStore } = require('./onboarding-store');
    const { useConfigPanelStore } = require('./config-panel-store');
    const { useChatPopupStore } = require('./chat-popup-store');
    const { useMeraProtocolStore } = require('./mera-protocol-store');
    const { useTopicSyncStore } = require('./topic-sync-store');
    const { useCloudChatStore } = require('./cloud-chat-store');
    const { useSubscriptionStore } = require('./subscription-store');
    const { clearAttestationCache } = require('../e2ee/e2ee-cache');

    // Wipe all WatermelonDB data (drops and recreates all tables)
    await database.write(async () => {
        await database.unsafeResetDatabase();
    });

    // Reset all Zustand in-memory state
    useForYouStore.getState().clearData();
    useUserStore.getState().clearUser();
    useUIStore.getState().resetUIState();
    useAppStateStore.getState().resetAppState();
    useOnboardingStore.getState().resetOnboarding();
    useConfigPanelStore.getState().closePanel();
    useChatPopupStore.getState().reset();
    useMeraProtocolStore.getState().reset();
    useTopicSyncStore.getState().reset();
    useCloudChatStore.getState().reset();
    useSubscriptionStore.getState().reset();
    clearAttestationCache();
};

/**
 * Called on every cold start from logged-in/index.tsx before setting the
 * active userId. Reads `cached_user_id` directly from the DB (no Zustand
 * hydration needed, so no race) and wipes all local state when the session
 * belongs to a different user than the one whose data is on-device.
 */
export const clearPreviousUserData = async (newUserId: string): Promise<void> => {
    const { getSetting } = require('../database/services/setting-service');
    const cachedUserId = await getSetting('cached_user_id');
    if (cachedUserId && cachedUserId !== newUserId) {
        await clearAllStores();
    }
};
