/**
 * Install-boundary reset (S10): a reinstall must not silently resume the
 * previous install's session (the keychain survives uninstall on iOS), while
 * an app UPDATE and a normal relaunch must touch nothing.
 */

const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (k: string) => mockGetSetting(k),
    setSetting: (k: string, v: string) => mockSetSetting(k, v),
}));

const mockGetItemAsync = jest.fn();
const mockDeleteItemAsync = jest.fn();
jest.mock('@/lib/utils/secure-store-adapter', () => ({
    secureStore: {
        getItemAsync: (k: string) => mockGetItemAsync(k),
        deleteItemAsync: (k: string) => mockDeleteItemAsync(k),
    },
}));

const mockNotify = jest.fn();
jest.mock('@/lib/auth-client', () => ({
    authClient: { $store: { notify: (...a: unknown[]) => mockNotify(...a) } },
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { warn: jest.fn(), captureException: jest.fn() },
}));

jest.mock('expo-constants', () => ({
    __esModule: true,
    default: { expoConfig: { slug: 'mera' } },
}));

import {
    __resetInstallBoundaryForTests,
    enforceInstallBoundary,
    HAS_LAUNCHED_SETTING_KEY,
    wasInstallBoundaryReset,
} from '../install-boundary';
import {
    __resetAuthReadQuarantineForTests,
    isAuthReadQuarantined,
} from '../install-boundary-latch';

beforeEach(() => {
    jest.clearAllMocks();
    __resetInstallBoundaryForTests();
    __resetAuthReadQuarantineForTests();
    mockGetSetting.mockResolvedValue(null);
    mockSetSetting.mockResolvedValue(undefined);
    mockGetItemAsync.mockResolvedValue(null);
    mockDeleteItemAsync.mockResolvedValue(undefined);
});

it('fresh install with a surviving session: clears cookie + account creds, PRESERVES the deviceRef, stamps the marker', async () => {
    const store: Record<string, string> = {
        mera_cookie: 'c',
        mera_session_data: 's',
        mera_appattest_key_id: 'k',
        mera_device_attest_device_id: 'u',
        mera_device_ref: 'ref',
    };
    mockGetItemAsync.mockImplementation(async (k: string) => store[k] ?? null);
    mockDeleteItemAsync.mockImplementation(async (k: string) => {
        delete store[k];
    });

    await enforceInstallBoundary();

    expect(mockDeleteItemAsync).toHaveBeenCalledWith('mera_cookie');
    expect(mockDeleteItemAsync).toHaveBeenCalledWith('mera_session_data');
    expect(mockDeleteItemAsync).toHaveBeenCalledWith('mera_appattest_key_id');
    expect(mockDeleteItemAsync).toHaveBeenCalledWith('mera_device_attest_device_id');
    expect(mockDeleteItemAsync).not.toHaveBeenCalledWith('mera_device_ref');
    expect(store.mera_device_ref).toBe('ref');
    expect(mockSetSetting).toHaveBeenCalledWith(HAS_LAUNCHED_SETTING_KEY, '1');
    expect(wasInstallBoundaryReset()).toBe(true);
});

it('normal relaunch (marker present): touches nothing', async () => {
    mockGetSetting.mockImplementation(async (k: string) =>
        k === HAS_LAUNCHED_SETTING_KEY ? '1' : null,
    );

    await enforceInstallBoundary();

    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
    expect(mockSetSetting).not.toHaveBeenCalled();
    expect(wasInstallBoundaryReset()).toBe(false);
});

it('app UPDATE (no marker yet, but cached_user_id survived): clears nothing, stamps the marker', async () => {
    mockGetSetting.mockImplementation(async (k: string) =>
        k === 'cached_user_id' ? 'u1' : null,
    );
    mockGetItemAsync.mockResolvedValue('anything');

    await enforceInstallBoundary();

    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
    expect(mockSetSetting).toHaveBeenCalledWith(HAS_LAUNCHED_SETTING_KEY, '1');
    expect(wasInstallBoundaryReset()).toBe(false);
});

it('true first install (nothing anywhere): no clearing, marker stamped, no reset flag', async () => {
    await enforceInstallBoundary();

    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
    expect(mockSetSetting).toHaveBeenCalledWith(HAS_LAUNCHED_SETTING_KEY, '1');
    expect(wasInstallBoundaryReset()).toBe(false);
});

it('fail-safe: a throwing settings read clears nothing and leaves the marker unwritten', async () => {
    mockGetSetting.mockRejectedValue(new Error('cold DB'));
    mockGetItemAsync.mockResolvedValue('anything');

    await expect(enforceInstallBoundary()).resolves.toBeUndefined();

    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
    expect(mockSetSetting).not.toHaveBeenCalled();
});

it('latches once per process', async () => {
    await enforceInstallBoundary();
    await enforceInstallBoundary();
    expect(mockGetSetting.mock.calls.filter(([k]) => k === HAS_LAUNCHED_SETTING_KEY)).toHaveLength(1);
});

describe('auth-read quarantine (S12: the get-session race)', () => {
    it('is latched at import time and released after the boundary decides, then pokes the session signal', async () => {
        // BEFORE the boundary: the racing /get-session must find no cookie.
        expect(isAuthReadQuarantined('mera_cookie')).toBe(true);
        expect(isAuthReadQuarantined('mera_session_data')).toBe(true);
        expect(isAuthReadQuarantined('mera_device_ref')).toBe(false);

        await enforceInstallBoundary();

        expect(isAuthReadQuarantined('mera_cookie')).toBe(false);
        // The atom refetches against the now-authoritative keychain.
        expect(mockNotify).toHaveBeenCalledWith('$sessionSignal');
    });

    it('releases on the marker-present path too', async () => {
        mockGetSetting.mockImplementation(async (k: string) =>
            k === HAS_LAUNCHED_SETTING_KEY ? '1' : null,
        );
        await enforceInstallBoundary();
        expect(isAuthReadQuarantined('mera_cookie')).toBe(false);
        expect(mockNotify).toHaveBeenCalledWith('$sessionSignal');
    });

    it('releases even when the settings read throws (fail-safe path)', async () => {
        mockGetSetting.mockRejectedValue(new Error('cold DB'));
        await enforceInstallBoundary();
        expect(isAuthReadQuarantined('mera_cookie')).toBe(false);
        expect(mockNotify).toHaveBeenCalledWith('$sessionSignal');
    });
});
