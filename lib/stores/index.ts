// Central store exports and utilities

// Existing stores
export { useForYouStore } from './for-you-store';
export { useUserStore } from './user-store';

// New stores
export { useUIStore, useLogoutModal, useDeleteAccountModal } from './ui-store';
export { useConfigPanelStore, useConfigPanelIsOpen, useConfigPanelActiveTab } from './config-panel-store';
export {
    useFloatingChatStore,
    useFloatingChatIsExpanded,
    useFloatingChatFactMutationVersion,
    useFloatingChatIsGenerating,
    useFloatingChatSuppressed,
} from './floating-chat-store';
export { useAppStateStore, useIsNavigationReady, useIsAppInitialized, useLastAuthenticatedUserId } from './app-state-store';
export { useFeedbackStore, useFeedbackVisible } from './feedback-store';
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
export { useTutorialsStore } from './tutorials-store';

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
    const { useFloatingChatStore } = require('./floating-chat-store');
    const { useMeraProtocolStore } = require('./mera-protocol-store');
    const { useTopicSyncStore } = require('./topic-sync-store');
    const { useCloudChatStore } = require('./cloud-chat-store');
    const { useSubscriptionStore } = require('./subscription-store');
    const { useFeedOrderStore } = require('./feed-order-store');
    const { useImportanceFilterStore } = require('./importance-filter-store');
    const { useRelatedSortStore } = require('./related-sort-store');
    const { useTutorialsStore } = require('./tutorials-store');
    const { useStartupTabStore } = require('./startup-tab-store');
    const { clearAttestationCache } = require('../e2ee/e2ee-cache');
    const { clearLastKnownTier } = require('../subscription/last-known-tier');

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
    useFloatingChatStore.getState().reset();
    useMeraProtocolStore.getState().reset();
    useTopicSyncStore.getState().reset();
    useCloudChatStore.getState().reset();
    useSubscriptionStore.getState().reset();
    useFeedOrderStore.getState().reset();
    useImportanceFilterStore.getState().reset();
    useRelatedSortStore.getState().reset();
    // Tutorial progress is per-DEVICE-USER, not per-account-in-the-abstract: the
    // settings rows go with the database wipe above, so the in-memory ticks must
    // go too or the next user on this phone inherits a finished tour.
    useTutorialsStore.getState().reset();
    useStartupTabStore.getState().reset();
    clearAttestationCache();

    // LAST, and deliberately so. The device's memory of its last resolved
    // subscription tier (lib/subscription/last-known-tier.ts). Without this,
    // user B on user A's device inherits A's tier and walks past the
    // pre-onboarding entitlement gate as a subscriber — the exact class of
    // cross-user leak this codebase has been bitten by before.
    //
    // Why the END rather than next to the database reset above: the tier is
    // written by a FIRE-AND-FORGET `recordResolvedTier()` inside
    // `resolveEntitlementForOnboarding`, which reads the subscription store. A
    // straggler from a gate pass that was already in flight when logout started
    // can land at any point during this function, and until
    // `useSubscriptionStore.reset()` above has run it would re-write the
    // OUTGOING user's tier. Clearing after every reset closes that window.
    //
    // EXPLICIT rather than relying on `unsafeResetDatabase()`, which does drop
    // the row today: the guarantee must not silently depend on that reset
    // staying total, and this is the line a future reader greps for.
    await clearLastKnownTier();
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
