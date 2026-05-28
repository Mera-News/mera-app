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
    clearAttestationCache();
};

/**
 * Disabled: previously wiped local data on user-id change. Re-enable via an
 * explicit "switch account" action if multi-account support is added back —
 * the post-auth routing screen runs on every cold start and any race with
 * the async hydration of `lastAuthenticatedUserId` could nuke the feed.
 */
export const clearPreviousUserData = async (_newUserId: string): Promise<void> => {
    // no-op
};
