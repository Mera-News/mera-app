// One statement the suite reached only through legacy suites (deletion gate G11):
//  - lib/device-auth.ts: the best-effort DEVICE_ID read in signInWithDevice's credential snapshot
//    rejecting (its `.catch(() => null)`);
// Real auth client, secure store and in-memory DB over MSW. Mocked: the attestation SDK wrapper,
// ANDROID_ID and the logger (edges).
import { Platform } from 'react-native';
import database from '@/lib/database';
import { __resetLegalConsentLatchForTests } from '@/components/custom/auth/legal-consent';
import { APP_ATTEST_KEY_ID_STORE_KEY, DEVICE_ID_STORE_KEY, signInWithDevice } from '@/lib/device-auth';
import { __resetIdentityStateForTests } from '@/lib/security/identity-gate';
import { __resetInstallBoundaryForTests } from '@/lib/security/install-boundary';
import { __resetAuthReadQuarantineForTests, releaseAuthReadQuarantine } from '@/lib/security/install-boundary-latch';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import { __resetDeviceAttestForTests } from '@/modules/mera-device-attest';
import { FIXTURE_ACCOUNT, HttpResponse, failSecureStore, http, secureStoreDump, server } from '@/test/helpers';

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
jest.mock('@/lib/logger', () => {
    const fns: Record<string, jest.Mock> = {};
    const logger = new Proxy({}, { get: (_t, key: string) => (fns[key] ??= jest.fn()) });
    return { __esModule: true, default: logger };
});

const KEY_SLOT = APP_ATTEST_KEY_ID_STORE_KEY;
const SIGN_IN_IOS = '*/api/auth/device/sign-in/ios';
const ME = FIXTURE_ACCOUNT.userId;
const refusal = () => HttpResponse.json({ code: 'DEVICE_ATTESTATION_FAILED', message: 'x' }, { status: 403 });

describe('signInWithDevice: the credential snapshot is best-effort (G11)', () => {
    let signInCalls: number;
    const count = ({ request }: { request: Request }) => {
        if (new URL(request.url).pathname === '/api/auth/device/sign-in/ios') signInCalls += 1;
    };

    beforeEach(() => {
        __resetIdentityStateForTests();
        __resetLegalConsentLatchForTests();
        __resetAuthReadQuarantineForTests();
        __resetInstallBoundaryForTests();
        __resetDeviceAttestForTests();
        releaseAuthReadQuarantine();
        (Platform as { OS: string }).OS = 'ios';
        mockAttest.isSupported.mockReset().mockResolvedValue(true);
        mockAttest.generateKey.mockReset().mockResolvedValue('key-1');
        mockAttest.attestKey.mockReset().mockResolvedValue('attestation-b64');
        mockAttest.generateAssertion.mockReset().mockResolvedValue('assertion-b64');
        signInCalls = 0;
        server.events.on('request:start', count);
    });
    afterEach(() => server.events.removeListener('request:start', count));

    it('an unreadable device-id slot does not abort the sign-in', async () => {
        await secureStore.setItemAsync(KEY_SLOT, 'stored-key');
        await secureStore.setItemAsync(DEVICE_ID_STORE_KEY, 'old-device');
        failSecureStore(DEVICE_ID_STORE_KEY, 'get');

        await expect(signInWithDevice()).resolves.toMatchObject({ status: 'success', userId: ME });
        expect(secureStoreDump()[KEY_SLOT]).toBe('stored-key');
    });

    // Today's outcome: an unreadable slot counts as nothing stored, so the refusal is not recovered.
    it('with only the device-id slot stored and unreadable, a 403 refusal is NOT recovered from (no severing, no second try)', async () => {
        await secureStore.setItemAsync(DEVICE_ID_STORE_KEY, 'old-device');
        failSecureStore(DEVICE_ID_STORE_KEY, 'get');
        server.use(http.post(SIGN_IN_IOS, refusal));

        await expect(signInWithDevice()).resolves.toEqual({ status: 'failed', reason: 'attestation-denied' });

        expect(signInCalls).toBe(1);
        expect(mockAttest.generateKey).toHaveBeenCalledTimes(1);
        expect(secureStoreDump()[DEVICE_ID_STORE_KEY]).toBe('old-device');
    });

    it('the same refusal with a readable device-id slot severs and re-enrolls once', async () => {
        await secureStore.setItemAsync(DEVICE_ID_STORE_KEY, 'old-device');
        let call = 0;
        server.use(http.post(SIGN_IN_IOS, () => (call++ === 0 ? refusal() : undefined)));
        mockAttest.generateKey.mockResolvedValue('key-2');

        await expect(signInWithDevice()).resolves.toMatchObject({ status: 'success', userId: ME });

        expect(signInCalls).toBe(2);
        expect(secureStoreDump()[DEVICE_ID_STORE_KEY]).toBeUndefined();
    });
});
