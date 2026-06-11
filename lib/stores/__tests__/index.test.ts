// Smoke tests for lib/stores/index.ts — verifies all expected exports are
// present and that clearAllStores / clearPreviousUserData are callable.

// ── Mock all transitive native/DB deps ────────────────────────────────────
jest.mock('@/lib/database', () => ({
    __esModule: true,
    default: {
        write: jest.fn((fn: () => Promise<void>) => fn()),
        unsafeResetDatabase: jest.fn(() => Promise.resolve()),
    },
}));

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: jest.fn(() => Promise.resolve(null)),
    setSetting: jest.fn(() => Promise.resolve()),
    deleteSetting: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    loadSuggestions: jest.fn(() => Promise.resolve([])),
    persistFeedMetadata: jest.fn(() => Promise.resolve()),
    loadFeedMetadata: jest.fn(() => Promise.resolve(null)),
    clearSuggestions: jest.fn(() => Promise.resolve()),
    pruneOrphanedSuggestions: jest.fn(() => Promise.resolve(0)),
}));

jest.mock('@/lib/database/services/user-persona-service', () => ({
    persistUserPersona: jest.fn(() => Promise.resolve()),
    loadUserPersona: jest.fn(() => Promise.resolve(null)),
    clearUserPersona: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/account-service', () => ({
    AccountService: {
        getUserPersona: jest.fn(() => Promise.resolve(null)),
    },
}));

jest.mock('@/lib/e2ee/e2ee-cache', () => ({
    clearAttestationCache: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

// cloud-chat-store may reference GraphQL/Apollo — stub it out
jest.mock('../cloud-chat-store', () => ({
    useCloudChatStore: Object.assign(
        jest.fn(),
        {
            getState: jest.fn(() => ({ reset: jest.fn() })),
            setState: jest.fn(),
        },
    ),
}));

// mera-protocol-store
jest.mock('../mera-protocol-store', () => ({
    useMeraProtocolStore: Object.assign(
        jest.fn(),
        {
            getState: jest.fn(() => ({ reset: jest.fn() })),
            setState: jest.fn(),
        },
    ),
    useProcessingMode: jest.fn(),
    useIsOnDeviceProcessing: jest.fn(),
    useModelState: jest.fn(),
    useDownloadProgress: jest.fn(),
    useIsModelReady: jest.fn(),
    useIsProcessing: jest.fn(),
    useProcessProgress: jest.fn(),
}));

// topic-sync-store
jest.mock('../topic-sync-store', () => ({
    useTopicSyncStore: Object.assign(
        jest.fn(),
        {
            getState: jest.fn(() => ({ reset: jest.fn() })),
            setState: jest.fn(),
        },
    ),
    useTopicSyncIsSyncing: jest.fn(),
    useTopicSyncProgress: jest.fn(),
    useTopicSyncError: jest.fn(),
}));

import * as storeIndex from '../index';

describe('lib/stores/index — exports smoke test', () => {
    it('exports useForYouStore', () => {
        expect(typeof storeIndex.useForYouStore).toBe('function');
    });

    it('exports useUserStore', () => {
        expect(typeof storeIndex.useUserStore).toBe('function');
    });

    it('exports useUIStore', () => {
        expect(typeof storeIndex.useUIStore).toBe('function');
    });

    it('exports useLogoutModal', () => {
        expect(typeof storeIndex.useLogoutModal).toBe('function');
    });

    it('exports useDeleteAccountModal', () => {
        expect(typeof storeIndex.useDeleteAccountModal).toBe('function');
    });

    it('exports useConfigPanelStore', () => {
        expect(typeof storeIndex.useConfigPanelStore).toBe('function');
    });

    it('exports useConfigPanelIsOpen', () => {
        expect(typeof storeIndex.useConfigPanelIsOpen).toBe('function');
    });

    it('exports useConfigPanelActiveTab', () => {
        expect(typeof storeIndex.useConfigPanelActiveTab).toBe('function');
    });

    it('exports useChatPopupStore', () => {
        expect(typeof storeIndex.useChatPopupStore).toBe('function');
    });

    it('exports useChatPopupIsExpanded', () => {
        expect(typeof storeIndex.useChatPopupIsExpanded).toBe('function');
    });

    it('exports useChatPopupConversationId', () => {
        expect(typeof storeIndex.useChatPopupConversationId).toBe('function');
    });

    it('exports useAppStateStore', () => {
        expect(typeof storeIndex.useAppStateStore).toBe('function');
    });

    it('exports useIsNavigationReady', () => {
        expect(typeof storeIndex.useIsNavigationReady).toBe('function');
    });

    it('exports useIsAppInitialized', () => {
        expect(typeof storeIndex.useIsAppInitialized).toBe('function');
    });

    it('exports useLastAuthenticatedUserId', () => {
        expect(typeof storeIndex.useLastAuthenticatedUserId).toBe('function');
    });

    it('exports useNetworkStore', () => {
        expect(typeof storeIndex.useNetworkStore).toBe('function');
    });

    it('exports useIsConnected', () => {
        expect(typeof storeIndex.useIsConnected).toBe('function');
    });

    it('exports initNetworkListener', () => {
        expect(typeof storeIndex.initNetworkListener).toBe('function');
    });

    it('exports stopNetworkListener', () => {
        expect(typeof storeIndex.stopNetworkListener).toBe('function');
    });

    it('exports clearAllStores as a function', () => {
        expect(typeof storeIndex.clearAllStores).toBe('function');
    });

    it('exports clearPreviousUserData as a function', () => {
        expect(typeof storeIndex.clearPreviousUserData).toBe('function');
    });
});

describe('clearAllStores', () => {
    it('resolves without throwing', async () => {
        await expect(storeIndex.clearAllStores()).resolves.toBeUndefined();
    });

    it('resets UI store logout modal after clearAllStores', async () => {
        storeIndex.useUIStore.getState().openModal('logout');
        await storeIndex.clearAllStores();
        expect(storeIndex.useUIStore.getState().modals.logout.isOpen).toBe(false);
    });

    it('resets config panel after clearAllStores', async () => {
        storeIndex.useConfigPanelStore.getState().openPanel();
        await storeIndex.clearAllStores();
        expect(storeIndex.useConfigPanelStore.getState().isOpen).toBe(false);
    });

    it('resets chat popup after clearAllStores', async () => {
        storeIndex.useChatPopupStore.getState().expand();
        await storeIndex.clearAllStores();
        expect(storeIndex.useChatPopupStore.getState().isExpanded).toBe(false);
    });
});

describe('clearPreviousUserData', () => {
    it('does nothing when no cached user exists', async () => {
        const { getSetting } = require('@/lib/database/services/setting-service');
        (getSetting as jest.Mock).mockResolvedValueOnce(null);
        await expect(storeIndex.clearPreviousUserData('new-user')).resolves.toBeUndefined();
    });

    it('does nothing when cached user matches new user', async () => {
        const { getSetting } = require('@/lib/database/services/setting-service');
        (getSetting as jest.Mock).mockResolvedValueOnce('same-user');
        // Clear call counts from any prior tests before asserting
        const database = require('@/lib/database').default;
        (database.write as jest.Mock).mockClear();
        await storeIndex.clearPreviousUserData('same-user');
        expect(database.write).not.toHaveBeenCalled();
    });

    it('calls clearAllStores when cached user differs from new user', async () => {
        const { getSetting } = require('@/lib/database/services/setting-service');
        (getSetting as jest.Mock).mockResolvedValueOnce('old-user');
        await storeIndex.clearPreviousUserData('new-user');
        const database = require('@/lib/database').default;
        expect(database.write).toHaveBeenCalled();
    });
});
