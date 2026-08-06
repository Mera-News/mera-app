/* eslint-disable @typescript-eslint/no-require-imports */
// The complete-erasure list and the launch-time resume check.
//
// Two properties carry the whole design:
//   1. ORDER — keychain/AsyncStorage before the database. The resume check can
//      only see the database, so a crash mid-wipe must leave the DB populated;
//      that is what makes the next launch notice and finish the job. DB-first
//      would strand keychain secrets with nothing left to signal them.
//   2. RESILIENCE — one unreadable keychain item must not stop the database
//      from being wiped.
const calls: string[] = [];

const mockDeleteItemAsync = jest.fn(async (key: string) => { calls.push(`secure:${key}`); });
jest.mock('@/lib/utils/secure-store-adapter', () => ({
    secureStore: { deleteItemAsync: (k: string) => mockDeleteItemAsync(k) },
}));

const mockAsyncRemove = jest.fn(async (key: string) => { calls.push(`async:${key}`); });
jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: { removeItem: (k: string) => mockAsyncRemove(k) },
}));

const mockLogoutRevenueCat = jest.fn(async () => { calls.push('logoutRevenueCat'); });
jest.mock('@/lib/revenuecat', () => ({ logoutRevenueCat: () => mockLogoutRevenueCat() }));

const mockClearAllStores = jest.fn(async () => { calls.push('clearAllStores'); });
jest.mock('@/lib/stores', () => ({ clearAllStores: () => mockClearAllStores() }));

const mockPinSetState = jest.fn((_state: any) => { calls.push('pinStore.setState'); });
jest.mock('@/lib/stores/pin-store', () => ({ usePinStore: { setState: (s: any) => mockPinSetState(s) } }));

const mockFetchCount = jest.fn(async () => 0);
jest.mock('@/lib/database', () => ({
    __esModule: true,
    default: { get: () => ({ query: () => ({ fetchCount: () => mockFetchCount() }) }) },
}));

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { slug: 'mera' } } }));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), addBreadcrumb: jest.fn(), captureException: jest.fn() },
}));

import { hasLocalUserData, purgeOrphanedLocalData, wipeAllLocalUserData } from '../local-wipe';

beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    mockFetchCount.mockResolvedValue(0);
});

describe('wipeAllLocalUserData — the complete list', () => {
    it('clears every keychain secret, including the E2EE pipeline key that used to survive logout', async () => {
        await wipeAllLocalUserData();

        expect(mockDeleteItemAsync).toHaveBeenCalledWith('mera_cookie');
        expect(mockDeleteItemAsync).toHaveBeenCalledWith('mera_session_data');
        expect(mockDeleteItemAsync).toHaveBeenCalledWith('mera_pin_record');
        expect(mockDeleteItemAsync).toHaveBeenCalledWith('mera_pin_attempts');
        expect(mockDeleteItemAsync).toHaveBeenCalledWith('mera_app_lock_enabled');
        // The regression that motivated this module: nothing cleared these.
        expect(mockDeleteItemAsync).toHaveBeenCalledWith('async_pipeline_privkey');
        expect(mockDeleteItemAsync).toHaveBeenCalledWith('async_inference_pending_job_privkey');

        expect(mockAsyncRemove).toHaveBeenCalledWith('mera.cycle.capabilityToken');
        expect(mockLogoutRevenueCat).toHaveBeenCalled();
        expect(mockPinSetState).toHaveBeenCalled();
        expect(mockClearAllStores).toHaveBeenCalled();
    });

    it('wipes the keychain BEFORE the database, so an interrupted wipe stays detectable', async () => {
        await wipeAllLocalUserData();

        const dbIndex = calls.indexOf('clearAllStores');
        expect(dbIndex).toBe(calls.length - 1);
        for (const key of ['mera_cookie', 'async_pipeline_privkey']) {
            expect(calls.indexOf(`secure:${key}`)).toBeLessThan(dbIndex);
        }
        expect(calls.indexOf('async:mera.cycle.capabilityToken')).toBeLessThan(dbIndex);
    });

    it('a failing keychain delete does not stop the database wipe', async () => {
        mockDeleteItemAsync.mockRejectedValueOnce(new Error('keychain locked'));
        await wipeAllLocalUserData();
        expect(mockClearAllStores).toHaveBeenCalled();
    });

    it('a failing RevenueCat logout does not stop the database wipe', async () => {
        mockLogoutRevenueCat.mockRejectedValueOnce(new Error('rc offline'));
        await wipeAllLocalUserData();
        expect(mockClearAllStores).toHaveBeenCalled();
    });
});

describe('purgeOrphanedLocalData — finishing an interrupted logout', () => {
    // The once-per-process latch is module state, so each case needs a fresh
    // copy of the module. Safe here (no React in this graph).
    let purge: typeof purgeOrphanedLocalData;
    beforeEach(() => {
        jest.resetModules();
        purge = require('../local-wipe').purgeOrphanedLocalData;
    });

    it('wipes when user data survived the credentials', async () => {
        mockFetchCount.mockResolvedValue(3);
        await expect(purge()).resolves.toBe(true);
        expect(mockClearAllStores).toHaveBeenCalled();
    });

    it('does nothing on a clean device (first install / already-finished logout)', async () => {
        mockFetchCount.mockResolvedValue(0);
        await expect(purge()).resolves.toBe(false);
        expect(mockClearAllStores).not.toHaveBeenCalled();
        expect(mockDeleteItemAsync).not.toHaveBeenCalled();
    });

    it('reports failure rather than throwing, so the next launch retries', async () => {
        mockFetchCount.mockResolvedValue(1);
        mockClearAllStores.mockRejectedValueOnce(new Error('db busy'));
        await expect(purge()).resolves.toBe(false);
    });

    it('runs at most once per process — the launch effect re-fires on every session change', async () => {
        mockFetchCount.mockResolvedValue(3);
        await expect(purge()).resolves.toBe(true);
        await expect(purge()).resolves.toBe(false);
        expect(mockClearAllStores).toHaveBeenCalledTimes(1);
    });
});

describe('hasLocalUserData', () => {
    it('true when any user-owned table has rows', async () => {
        mockFetchCount.mockResolvedValue(1);
        await expect(hasLocalUserData()).resolves.toBe(true);
    });

    it('false when every table is empty', async () => {
        mockFetchCount.mockResolvedValue(0);
        await expect(hasLocalUserData()).resolves.toBe(false);
    });

    it('an uncountable table does not abort the sweep', async () => {
        mockFetchCount.mockRejectedValueOnce(new Error('no such table'));
        mockFetchCount.mockResolvedValue(2);
        await expect(hasLocalUserData()).resolves.toBe(true);
    });
});
