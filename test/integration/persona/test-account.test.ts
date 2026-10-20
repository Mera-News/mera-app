// Seam test for TEST-account sign-in (lib/device-auth.ts) and the dev-only deep link
// (components/custom/auth/useDevTestAccountLink.ts). Real auth client, secure store, identity
// gate, RevenueCat wrapper over its SDK mock and the router of the integration setup, against the
// mock auth service. The only other mocks are the attestation SDK wrapper and ANDROID_ID.
import { renderHook, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import Purchases from 'react-native-purchases';
import { Platform } from 'react-native';
import { useDevTestAccountLink } from '@/components/custom/auth/useDevTestAccountLink';
import { __resetLegalConsentLatchForTests } from '@/components/custom/auth/legal-consent';
import {
    APP_ATTEST_KEY_ID_STORE_KEY,
    DEVICE_ID_STORE_KEY,
    TEST_ACCOUNT_HANDLE_STORE_KEY,
    clearDeviceAuthCredentials,
    convertWithDevice,
    deleteTestAccount,
    deviceSignInAvailability,
    deviceSignInPath,
    listTestAccounts,
    setTestAccountHandle,
    signInWithDevice,
} from '@/lib/device-auth';
import { __resetStoreSyncForTests, configureRevenueCat, loginRevenueCat } from '@/lib/revenuecat';
import { __resetIdentityStateForTests, readPendingAuthUserId } from '@/lib/security/identity-gate';
import { __resetInstallBoundaryForTests } from '@/lib/security/install-boundary';
import { __resetAuthReadQuarantineForTests, releaseAuthReadQuarantine } from '@/lib/security/install-boundary-latch';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import { __resetDeviceAttestForTests } from '@/modules/mera-device-attest';
import { FIXTURE_ACCOUNT, HttpResponse, http, secureStoreDump, server } from '@/test/helpers';

const mockAttest = {
    isSupported: jest.fn(),
    generateKey: jest.fn(),
    attestKey: jest.fn(),
    generateAssertion: jest.fn(),
    requestIntegrityToken: jest.fn(),
};
jest.mock('@/modules/mera-device-attest', () => ({
    ...jest.requireActual('@/modules/mera-device-attest'),
    isSupported: (...a: unknown[]) => mockAttest.isSupported(...a),
    generateKey: (...a: unknown[]) => mockAttest.generateKey(...a),
    attestKey: (...a: unknown[]) => mockAttest.attestKey(...a),
    generateAssertion: (...a: unknown[]) => mockAttest.generateAssertion(...a),
    requestIntegrityToken: (...a: unknown[]) => mockAttest.requestIntegrityToken(...a),
}));
jest.mock('expo-application', () => ({ getAndroidId: () => 'android-hw-1' }));

const ME = FIXTURE_ACCOUNT.userId;
const TOKEN = 'test-account-token-for-jest';
const SIGN_IN = '*/api/auth/test-account/sign-in';
const DELETE = '*/api/auth/test-account/delete';
const LIST = '*/api/auth/test-account/list';
const P = Purchases as unknown as Record<string, jest.Mock>;
const g = globalThis as unknown as { __DEV__: boolean };

// ─── What the app sent ───────────────────────────────────────────────────────

const sent: { path: string; body: Promise<any> }[] = [];
const onRequest = ({ request }: { request: Request }) => {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/api/auth/device/') && !pathname.startsWith('/api/auth/test-account/')) return;
    sent.push({ path: pathname.replace('/api/auth', ''), body: request.clone().json().catch(() => undefined) });
};
const bodiesTo = (path: string) => Promise.all(sent.filter((s) => s.path === path).map((s) => s.body));
const paths = () => sent.map((s) => s.path);
const answer = (url: string, status: number, body: unknown) =>
    server.use(http.post(url, () => HttpResponse.json(body as Record<string, unknown>, { status })));
const replace = () => router.replace as jest.Mock;

beforeAll(() => {
    configureRevenueCat();
});

beforeEach(() => {
    jest.clearAllMocks();
    __resetIdentityStateForTests();
    __resetLegalConsentLatchForTests();
    __resetAuthReadQuarantineForTests();
    __resetInstallBoundaryForTests();
    __resetDeviceAttestForTests();
    __resetStoreSyncForTests();
    releaseAuthReadQuarantine();
    g.__DEV__ = true;
    (Platform as { OS: string }).OS = 'ios';
    process.env.EXPO_PUBLIC_TEST_ACCOUNT_TOKEN = TOKEN;
    delete process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN;
    mockAttest.isSupported.mockReset().mockResolvedValue(false);
    mockAttest.generateAssertion.mockReset().mockResolvedValue('assertion-b64');
    mockAttest.generateKey.mockReset().mockResolvedValue('key-1');
    mockAttest.attestKey.mockReset().mockResolvedValue('attestation-b64');
    P.getAppUserID.mockResolvedValue(ME);
    sent.length = 0;
    server.events.on('request:start', onRequest);
});

afterEach(() => {
    server.events.removeListener('request:start', onRequest);
    delete process.env.EXPO_PUBLIC_TEST_ACCOUNT_TOKEN;
    g.__DEV__ = true;
});

describe('the test-account flow in lib/device-auth', () => {
    it('comes first: it beats the dev bypass and native attestation, with a throwaway handle from the device UUID', async () => {
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
        mockAttest.isSupported.mockResolvedValue(true);
        await secureStore.setItemAsync(DEVICE_ID_STORE_KEY, 'abcdef01-2345-6789-abcd-ef0123456789');

        await expect(signInWithDevice()).resolves.toMatchObject({ status: 'success', userId: ME });

        expect(paths()).toEqual(['/test-account/sign-in']);
        expect(await bodiesTo('/test-account/sign-in')).toEqual([{ token: TOKEN, handle: 'tmp-abcdef012345' }]);
        await expect(deviceSignInPath()).resolves.toBe('dev-bypass');
        await expect(deviceSignInAvailability()).resolves.toBe('dev-bypass');
    });

    it('signs in to the handle in the slot, and refuses to store an invalid one', async () => {
        await setTestAccountHandle('resident-ios');
        await expect(setTestAccountHandle('Not A Handle')).rejects.toThrow();

        await signInWithDevice();

        expect(secureStoreDump()[TEST_ACCOUNT_HANDLE_STORE_KEY]).toBe('resident-ios');
        expect(await bodiesTo('/test-account/sign-in')).toEqual([{ token: TOKEN, handle: 'resident-ios' }]);
    });

    it('a release build ignores the token: native sign-in, no test route', async () => {
        g.__DEV__ = false;
        mockAttest.isSupported.mockResolvedValue(true);

        await expect(signInWithDevice()).resolves.toMatchObject({ status: 'success' });

        expect(paths()).not.toContain('/test-account/sign-in');
        expect(paths()).toContain('/device/sign-in/ios');
        await expect(deleteTestAccount('resident-ios')).resolves.toBe('failed');
        await expect(listTestAccounts()).resolves.toBeNull();
        expect(paths().filter((p) => p.startsWith('/test-account/'))).toEqual([]);
    });

    it.each([
        ['a wrong token (404)', 404, 'NOT_FOUND'],
        ['a 403 refusal', 403, 'DEVICE_ATTESTATION_FAILED'],
    ])('%s fails without severing anything or retrying', async (_label, status, code) => {
        await secureStore.setItemAsync(APP_ATTEST_KEY_ID_STORE_KEY, 'stored-key');
        await secureStore.setItemAsync(DEVICE_ID_STORE_KEY, 'stored-device');
        await setTestAccountHandle('resident-ios');
        answer(SIGN_IN, status, { code, message: code });

        await expect(signInWithDevice()).resolves.toMatchObject({ status: 'failed' });

        expect(paths()).toEqual(['/test-account/sign-in']);
        const slots = secureStoreDump();
        expect(slots[APP_ATTEST_KEY_ID_STORE_KEY]).toBe('stored-key');
        expect(slots[DEVICE_ID_STORE_KEY]).toBe('stored-device');
        expect(slots[TEST_ACCOUNT_HANDLE_STORE_KEY]).toBe('resident-ios');
    });

    it('a test MINT never syncs store purchases', async () => {
        answer(SIGN_IN, 200, { user: { id: ME }, minted: true, trialAvailable: false });

        await expect(signInWithDevice()).resolves.toMatchObject({ status: 'success', minted: true });
        await loginRevenueCat(ME);
        await new Promise((r) => setTimeout(r, 50));

        expect(P.syncPurchases).not.toHaveBeenCalled();
    });

    it('a convert (the move or the silent bind) never takes the test route', async () => {
        await convertWithDevice();

        expect(paths().filter((p) => p.startsWith('/test-account/'))).toEqual([]);
    });

    it('severing clears the handle slot with the other device credentials', async () => {
        await setTestAccountHandle('resident-ios');

        await clearDeviceAuthCredentials();

        expect(secureStoreDump()[TEST_ACCOUNT_HANDLE_STORE_KEY]).toBeUndefined();
    });

    it('delete and list speak the contract', async () => {
        answer(LIST, 200, { accounts: [{ handle: 'resident-ios', userId: ME }, { handle: 7 }] });

        await expect(deleteTestAccount('resident-ios')).resolves.toBe('deleted');
        await expect(listTestAccounts()).resolves.toEqual([{ handle: 'resident-ios', userId: ME }]);
        expect(await bodiesTo('/test-account/delete')).toEqual([{ token: TOKEN, handle: 'resident-ios' }]);
        expect(await bodiesTo('/test-account/list')).toEqual([{ token: TOKEN }]);

        answer(DELETE, 404, { code: 'NOT_FOUND', message: 'Not found' });
        await expect(deleteTestAccount('resident-ios')).resolves.toBe('not-found');
        answer(DELETE, 500, { code: 'X', message: 'X' });
        await expect(deleteTestAccount('resident-ios')).resolves.toBe('failed');
    });
});

describe('the /dev-test-account deep link', () => {
    const mount = (params: Record<string, string>) => renderHook(() => useDevTestAccountLink(params));
    const routed = () => waitFor(() => expect(replace()).toHaveBeenCalled());

    it('signs in to the named handle, records the account, then goes through the launch gate', async () => {
        let recordedWhenRouted: string | null | undefined;
        replace().mockImplementation(() => {
            recordedWhenRouted = readPendingAuthUserId();
        });

        mount({ handle: 'resident-ios' });
        await routed();

        expect(replace()).toHaveBeenCalledWith('/logged-in');
        expect(recordedWhenRouted).toBe(ME);
        expect(await bodiesTo('/test-account/sign-in')).toEqual([{ token: TOKEN, handle: 'resident-ios' }]);
    });

    it('never takes a user id from the link: an extra param is ignored, the handle decides', async () => {
        mount({ handle: 'resident-ios', userId: 'bbbbbbbbbbbbbbbbbbbbbbbb' });
        await routed();

        const [body] = await bodiesTo('/test-account/sign-in');
        expect(body).toEqual({ token: TOKEN, handle: 'resident-ios' });
        expect(readPendingAuthUserId()).toBe(ME);
    });

    it('reset deletes the handle BEFORE signing in', async () => {
        mount({ handle: 'resident-ios', reset: '1' });
        await routed();

        expect(paths()).toEqual(['/test-account/delete', '/test-account/sign-in']);
        expect(replace()).toHaveBeenCalledWith('/logged-in');
    });

    it('new=1 mints a fresh tmp- handle', async () => {
        mount({ new: '1' });
        await routed();

        const [body] = await bodiesTo('/test-account/sign-in');
        expect(body.handle).toMatch(/^tmp-[0-9a-f]{12}$/);
    });

    it.each([
        ['an invalid handle', { handle: 'BAD HANDLE' }],
        ['no handle', {}],
    ])('%s goes to / and calls nothing', async (_label, params) => {
        mount(params);
        await routed();

        expect(replace()).toHaveBeenCalledWith('/');
        expect(sent).toHaveLength(0);
    });

    it('a failed sign-in goes to / and records nothing', async () => {
        answer(SIGN_IN, 404, { code: 'NOT_FOUND', message: 'Not found' });

        mount({ handle: 'resident-ios' });
        await routed();

        expect(replace()).toHaveBeenCalledWith('/');
        expect(readPendingAuthUserId()).toBeNull();
    });

    it.each([
        ['a release build', () => (g.__DEV__ = false)],
        ['a dev build with no token', () => delete process.env.EXPO_PUBLIC_TEST_ACCOUNT_TOKEN],
    ])('%s goes to / and touches nothing', async (_label, arrange) => {
        arrange();

        mount({ handle: 'resident-ios', reset: '1' });
        await routed();

        expect(replace()).toHaveBeenCalledWith('/');
        expect(sent).toHaveLength(0);
        expect(secureStoreDump()[TEST_ACCOUNT_HANDLE_STORE_KEY]).toBeUndefined();
    });
});
