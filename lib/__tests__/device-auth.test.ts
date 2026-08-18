/**
 * Device sign-in orchestration (lib/device-auth.ts) with the native module
 * mocked: first-run enrollment, resume, invalid-key recovery, the staging dev
 * bypass, and server 400/503 handling. Every failure must surface as a typed,
 * retryable result — never a throw.
 */

const mockIsSupported = jest.fn();
const mockGenerateKey = jest.fn();
const mockAttestKey = jest.fn();
const mockGenerateAssertion = jest.fn();
const mockRequestIntegrityToken = jest.fn();

jest.mock('@/modules/mera-device-attest', () => ({
    isSupported: (...args: unknown[]) => mockIsSupported(...args),
    generateKey: (...args: unknown[]) => mockGenerateKey(...args),
    attestKey: (...args: unknown[]) => mockAttestKey(...args),
    generateAssertion: (...args: unknown[]) => mockGenerateAssertion(...args),
    requestIntegrityToken: (...args: unknown[]) => mockRequestIntegrityToken(...args),
    isInvalidKeyError: (e: unknown) =>
        (e as { code?: string } | null)?.code === 'ERR_ATTEST_INVALID_KEY',
}));

const mockFetch = jest.fn();
const mockGetSession = jest.fn();
jest.mock('@/lib/auth-client', () => ({
    authClient: {
        $fetch: (...args: unknown[]) => mockFetch(...args),
        getSession: (...args: unknown[]) => mockGetSession(...args),
    },
}));

const mockGetItemAsync = jest.fn();
const mockSetItemAsync = jest.fn();
const mockDeleteItemAsync = jest.fn();
jest.mock('@/lib/utils/secure-store-adapter', () => ({
    secureStore: {
        getItemAsync: (k: string) => mockGetItemAsync(k),
        setItemAsync: (k: string, v: string) => mockSetItemAsync(k, v),
        deleteItemAsync: (k: string) => mockDeleteItemAsync(k),
    },
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        captureMessage: jest.fn(),
        addBreadcrumb: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
    },
}));

jest.mock('expo-constants', () => ({
    __esModule: true,
    default: { expoConfig: { slug: 'mera' } },
}));

const mockGetAndroidId = jest.fn((): string | null => 'android-hw-1');
jest.mock('expo-application', () => ({
    getAndroidId: () => mockGetAndroidId(),
}));

// Deterministic hash stand-in: the value only has to travel intact from the
// hashing step to the native call / server body assertions below.
jest.mock('expo-crypto', () => ({
    digestStringAsync: jest.fn(async (_alg: string, input: string) => `sha256(${input})`),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { BASE64: 'base64' },
    randomUUID: jest.fn(() => 'dev-uuid-1'),
}));

import { Platform } from 'react-native';

import {
    APP_ATTEST_KEY_ID_STORE_KEY,
    DEVICE_ID_STORE_KEY,
    DEVICE_REF_STORE_KEY,
    clearDeviceAuthCredentials,
    deviceSignInAvailability,
    signInWithDevice,
} from '../device-auth';

const KEY_SLOT = APP_ATTEST_KEY_ID_STORE_KEY;

/** Route the $fetch mock: a nonce counter plus per-path handlers. */
function installServer(overrides: Record<string, (body: any) => any> = {}) {
    let nonceCount = 0;
    mockFetch.mockImplementation(async (path: string, init?: { body?: any }) => {
        if (overrides[path]) return overrides[path](init?.body);
        if (path === '/device/nonce') {
            nonceCount += 1;
            return { data: { nonce: `nonce-${nonceCount}` }, error: null };
        }
        if (path === '/device/attest/ios') return { data: { success: true }, error: null };
        if (
            path === '/device/sign-in/ios' ||
            path === '/device/sign-in/android' ||
            path === '/device/sign-in/dev'
        ) {
            return { data: { user: { id: 'user-1' } }, error: null };
        }
        throw new Error(`Unexpected path ${path}`);
    });
}

function callsTo(path: string) {
    return mockFetch.mock.calls.filter(([p]) => p === path);
}

const originalPlatform = Platform.OS;

beforeEach(() => {
    jest.clearAllMocks();
    (Platform as { OS: string }).OS = 'ios';
    delete process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN;
    delete process.env.EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT;
    mockIsSupported.mockResolvedValue(true);
    mockGetItemAsync.mockResolvedValue(null);
    mockSetItemAsync.mockResolvedValue(undefined);
    mockDeleteItemAsync.mockResolvedValue(undefined);
    mockGetSession.mockResolvedValue(null);
    mockGetAndroidId.mockReturnValue('android-hw-1');
});

afterAll(() => {
    (Platform as { OS: string }).OS = originalPlatform;
});

describe('iOS first-run enrollment', () => {
    it('enrolls (nonce -> generateKey -> attest -> POST) then signs in with a FRESH nonce', async () => {
        installServer();
        mockGenerateKey.mockResolvedValue('key-1');
        mockAttestKey.mockResolvedValue('attestation-b64');
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        const result = await signInWithDevice();

        expect(result).toEqual({
            status: 'success',
            userId: 'user-1',
            trialAvailable: null,
            welcomeBack: false,
        });

        // Enrollment used nonce-1 (purpose attest); sign-in used nonce-2
        // (purpose assert). Never the same nonce.
        expect(callsTo('/device/nonce')).toHaveLength(2);
        expect(callsTo('/device/nonce')[0][1].body).toEqual({ purpose: 'attest' });
        expect(callsTo('/device/nonce')[1][1].body).toEqual({ purpose: 'assert' });
        expect(mockAttestKey).toHaveBeenCalledWith('key-1', 'sha256(nonce-1)');
        const attestBody = callsTo('/device/attest/ios')[0][1].body;
        expect(attestBody).toEqual({
            keyId: 'key-1',
            attestation: 'attestation-b64',
            nonce: 'nonce-1',
        });

        // The nonce IS the client data: the assertion signs its hash, the body
        // carries it raw.
        expect(mockGenerateAssertion).toHaveBeenCalledWith('key-1', 'sha256(nonce-2)');
        const signInBody = callsTo('/device/sign-in/ios')[0][1].body;
        expect(signInBody).toEqual({
            keyId: 'key-1',
            assertion: 'assertion-b64',
            nonce: 'nonce-2',
        });

        // The keyId is persisted only after the server accepted the attestation.
        expect(mockSetItemAsync).toHaveBeenCalledWith(KEY_SLOT, 'key-1');
    });

    it('does not persist the keyId when the server rejects the attestation', async () => {
        installServer({
            '/device/attest/ios': () => ({
                data: null,
                error: { status: 400, code: 'DEVICE_ATTESTATION_FAILED' },
            }),
        });
        mockGenerateKey.mockResolvedValue('key-1');
        mockAttestKey.mockResolvedValue('attestation-b64');

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
        expect(mockSetItemAsync).not.toHaveBeenCalledWith(KEY_SLOT, expect.anything());
    });
});

describe('iOS resume', () => {
    it('skips enrollment when a keyId is stored', async () => {
        installServer();
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === KEY_SLOT ? 'stored-key' : null,
        );
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        const result = await signInWithDevice();

        expect(result).toMatchObject({ status: 'success', userId: 'user-1' });
        expect(mockGenerateKey).not.toHaveBeenCalled();
        expect(mockAttestKey).not.toHaveBeenCalled();
        expect(callsTo('/device/attest/ios')).toHaveLength(0);
        expect(callsTo('/device/nonce')).toHaveLength(1);
        expect(mockGenerateAssertion).toHaveBeenCalledWith('stored-key', expect.any(String));
    });

    it('a keychain READ failure aborts as retryable — it must never re-enroll', async () => {
        installServer();
        mockGetItemAsync.mockRejectedValue(new Error('keychain locked'));

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'unknown' });
        expect(mockGenerateKey).not.toHaveBeenCalled();
    });
});

describe('iOS invalid-key recovery', () => {
    it('clears the dead keyId and restarts from generateKey', async () => {
        installServer();
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === KEY_SLOT ? 'dead-key' : null,
        );
        mockGenerateAssertion
            .mockRejectedValueOnce(
                Object.assign(new Error('invalid key'), { code: 'ERR_ATTEST_INVALID_KEY' }),
            )
            .mockResolvedValue('assertion-b64');
        mockGenerateKey.mockResolvedValue('key-2');
        mockAttestKey.mockResolvedValue('attestation-b64');

        const result = await signInWithDevice();

        expect(result).toMatchObject({ status: 'success', userId: 'user-1' });
        expect(mockDeleteItemAsync).toHaveBeenCalledWith(KEY_SLOT);
        expect(mockSetItemAsync).toHaveBeenCalledWith(KEY_SLOT, 'key-2');
        expect(mockGenerateAssertion).toHaveBeenLastCalledWith('key-2', expect.any(String));
    });

    it('does not loop: an invalid key right after enrollment fails instead of re-enrolling', async () => {
        installServer();
        // No stored key -> enrollment happens -> assertion still says invalid.
        mockGenerateKey.mockResolvedValue('key-1');
        mockAttestKey.mockResolvedValue('attestation-b64');
        mockGenerateAssertion.mockRejectedValue(
            Object.assign(new Error('invalid key'), { code: 'ERR_ATTEST_INVALID_KEY' }),
        );

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'unknown' });
        expect(mockGenerateKey).toHaveBeenCalledTimes(1);
    });
});

describe('Android', () => {
    it('sends ANDROID_ID as the deviceId (the S10 trial-memory anchor)', async () => {
        (Platform as { OS: string }).OS = 'android';
        process.env.EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT = '123456';
        installServer();
        mockRequestIntegrityToken.mockResolvedValue('integrity-token');

        const result = await signInWithDevice();

        expect(result).toMatchObject({ status: 'success', userId: 'user-1' });
        expect(callsTo('/device/nonce')[0][1].body).toEqual({ purpose: 'integrity' });
        expect(mockRequestIntegrityToken).toHaveBeenCalledWith('nonce-1', '123456');
        expect(callsTo('/device/sign-in/android')[0][1].body).toEqual({
            integrityToken: 'integrity-token',
            nonce: 'nonce-1',
            deviceId: 'android-hw-1',
        });
    });

    it('falls back to the stored UUID when getAndroidId throws or is empty', async () => {
        (Platform as { OS: string }).OS = 'android';
        installServer();
        mockRequestIntegrityToken.mockResolvedValue('integrity-token');
        mockGetAndroidId.mockImplementation(() => {
            throw new Error('unavailable');
        });

        await signInWithDevice();

        expect(callsTo('/device/sign-in/android')[0][1].body).toMatchObject({
            deviceId: 'dev-uuid-1',
        });
        expect(mockSetItemAsync).toHaveBeenCalledWith(DEVICE_ID_STORE_KEY, 'dev-uuid-1');
    });

    it('omits the cloud project number when the env var is unset', async () => {
        (Platform as { OS: string }).OS = 'android';
        installServer();
        mockRequestIntegrityToken.mockResolvedValue('integrity-token');

        await signInWithDevice();

        expect(mockRequestIntegrityToken).toHaveBeenCalledWith('nonce-1', null);
    });
});

describe('deviceRef anchor (S10)', () => {
    it('presents the stored deviceRef on sign-in and stores a returned one', async () => {
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === KEY_SLOT ? 'stored-key' : k === DEVICE_REF_STORE_KEY ? 'ref-stored' : null,
        );
        installServer({
            '/device/sign-in/ios': () => ({
                data: { user: { id: 'user-1' }, deviceRef: 'ref-fresh', trialAvailable: true },
                error: null,
            }),
        });
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        const result = await signInWithDevice();

        expect(callsTo('/device/sign-in/ios')[0][1].body).toMatchObject({ deviceRef: 'ref-stored' });
        expect(mockSetItemAsync).toHaveBeenCalledWith(DEVICE_REF_STORE_KEY, 'ref-fresh');
        expect(result).toMatchObject({ status: 'success', trialAvailable: true });
    });

    it('omits deviceRef entirely when none is stored (first mint), then stores the minted one', async () => {
        installServer({
            '/device/sign-in/ios': () => ({
                data: { user: { id: 'user-1' }, deviceRef: 'ref-minted' },
                error: null,
            }),
        });
        mockGenerateKey.mockResolvedValue('key-1');
        mockAttestKey.mockResolvedValue('attestation-b64');
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        await signInWithDevice();

        expect(callsTo('/device/sign-in/ios')[0][1].body).not.toHaveProperty('deviceRef');
        expect(mockSetItemAsync).toHaveBeenCalledWith(DEVICE_REF_STORE_KEY, 'ref-minted');
    });

    it('the dev bypass keeps its stored UUID deviceId and presents the deviceRef too', async () => {
        mockIsSupported.mockResolvedValue(false);
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === DEVICE_REF_STORE_KEY ? 'ref-stored' : null,
        );
        installServer();

        await signInWithDevice();

        expect(callsTo('/device/sign-in/dev')[0][1].body).toEqual({
            token: 'dev-token',
            deviceId: 'dev-uuid-1',
            deviceRef: 'ref-stored',
        });
    });
});

describe('welcome-back gating (S12: minted === true AND trialAvailable === false)', () => {
    // `trialAvailable` rides EVERY sign-in response (deploy-verified), resumes
    // included — a promoIneligible account's routine resume carries false. The
    // server therefore ships `minted` (true only when the call CREATED the
    // user); the gate requires both, and treats an absent `minted` (older
    // server) as false so nothing fires against a stale deployment.
    const signInServer = (fields: Record<string, unknown>) =>
        installServer({
            '/device/sign-in/ios': () => ({
                data: { user: { id: 'user-1' }, ...fields },
                error: null,
            }),
        });

    beforeEach(() => {
        mockGenerateKey.mockResolvedValue('key-1');
        mockAttestKey.mockResolvedValue('attestation-b64');
        mockGenerateAssertion.mockResolvedValue('assertion-b64');
    });

    it('denied MINT -> welcomeBack true, even with a surviving deviceRef', async () => {
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === DEVICE_REF_STORE_KEY ? 'ref-survivor' : null,
        );
        signInServer({ minted: true, trialAvailable: false, deviceRef: 'ref-minted' });
        expect(await signInWithDevice()).toMatchObject({ status: 'success', welcomeBack: true });
    });

    it('REGRESSION: a denied RESUME (minted false, trialAvailable false) never routes to welcome-back', async () => {
        // The routine logout -> login of a promoIneligible account. The
        // trialAvailable-only predicate would have shown /welcome-back on
        // every one of these, forever.
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === KEY_SLOT ? 'stored-key' : null,
        );
        signInServer({ minted: false, trialAvailable: false });
        expect(await signInWithDevice()).toMatchObject({
            welcomeBack: false,
            trialAvailable: false,
        });
    });

    it('granted mint and trial-eligible resume -> welcomeBack false', async () => {
        signInServer({ minted: true, trialAvailable: true });
        expect(await signInWithDevice()).toMatchObject({ welcomeBack: false });
        signInServer({ minted: false, trialAvailable: true });
        expect(await signInWithDevice()).toMatchObject({ welcomeBack: false });
    });

    it('minted ABSENT (older server) is false: never fires, even with trialAvailable false', async () => {
        signInServer({ trialAvailable: false });
        expect(await signInWithDevice()).toMatchObject({ welcomeBack: false });
    });
});

describe('refusal recovery (S10)', () => {
    const refusal = (code: string) => ({ data: null, error: { status: 403, code } });

    it.each(['DEVICE_ATTESTATION_FAILED', 'ACCOUNT_DELETED'])(
        'a stored credential refused with 403 %s severs and re-enrolls ONCE, then succeeds',
        async (code) => {
            // Stateful keychain: severing must make the retry re-enroll, so
            // the mock has to actually forget deleted keys.
            const store: Record<string, string> = { [KEY_SLOT]: 'stored-key' };
            mockGetItemAsync.mockImplementation(async (k: string) => store[k] ?? null);
            mockDeleteItemAsync.mockImplementation(async (k: string) => {
                delete store[k];
            });
            let signInCalls = 0;
            installServer({
                '/device/sign-in/ios': () => {
                    signInCalls += 1;
                    return signInCalls === 1
                        ? refusal(code)
                        : { data: { user: { id: 'user-2' } }, error: null };
                },
            });
            mockGenerateKey.mockResolvedValue('key-2');
            mockAttestKey.mockResolvedValue('attestation-b64');
            mockGenerateAssertion.mockResolvedValue('assertion-b64');

            const result = await signInWithDevice();

            expect(result).toMatchObject({ status: 'success', userId: 'user-2' });
            // Severed: the ACCOUNT slots cleared before the retry; the
            // deviceRef survives (trial history, never cleared by any flow).
            expect(mockDeleteItemAsync).toHaveBeenCalledWith(KEY_SLOT);
            expect(mockDeleteItemAsync).toHaveBeenCalledWith(DEVICE_ID_STORE_KEY);
            expect(mockDeleteItemAsync).not.toHaveBeenCalledWith(DEVICE_REF_STORE_KEY);
            // Fresh enrollment happened exactly once.
            expect(mockGenerateKey).toHaveBeenCalledTimes(1);
            expect(signInCalls).toBe(2);
        },
    );

    it('recovers once and ONLY once: a second 403 surfaces as failure', async () => {
        const store: Record<string, string> = { [KEY_SLOT]: 'stored-key' };
        mockGetItemAsync.mockImplementation(async (k: string) => store[k] ?? null);
        mockDeleteItemAsync.mockImplementation(async (k: string) => {
            delete store[k];
        });
        installServer({
            '/device/sign-in/ios': () => refusal('DEVICE_ATTESTATION_FAILED'),
        });
        mockGenerateKey.mockResolvedValue('key-2');
        mockAttestKey.mockResolvedValue('attestation-b64');
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
        expect(mockGenerateKey).toHaveBeenCalledTimes(1);
    });

    it('a 400 DEVICE_ATTESTATION_FAILED never clears credentials', async () => {
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === KEY_SLOT ? 'stored-key' : null,
        );
        installServer({
            '/device/sign-in/ios': () => ({
                data: null,
                error: { status: 400, code: 'DEVICE_ATTESTATION_FAILED' },
            }),
        });
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
        expect(mockDeleteItemAsync).not.toHaveBeenCalled();
    });

    it('a fresh install (nothing stored) never retries on 403', async () => {
        let signInCalls = 0;
        installServer({
            '/device/sign-in/ios': () => {
                signInCalls += 1;
                return refusal('DEVICE_ATTESTATION_FAILED');
            },
        });
        mockGenerateKey.mockResolvedValue('key-1');
        mockAttestKey.mockResolvedValue('attestation-b64');
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
        expect(signInCalls).toBe(1);
    });
});

describe('dev bypass', () => {
    it('used only when unsupported AND the env token is set; persists a stable deviceId', async () => {
        mockIsSupported.mockResolvedValue(false);
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
        installServer();

        const result = await signInWithDevice();

        expect(result).toEqual({
            status: 'success',
            userId: 'user-1',
            trialAvailable: null,
            welcomeBack: false,
        });
        expect(callsTo('/device/sign-in/dev')[0][1].body).toEqual({
            token: 'dev-token',
            deviceId: 'dev-uuid-1',
        });
        expect(mockSetItemAsync).toHaveBeenCalledWith(DEVICE_ID_STORE_KEY, 'dev-uuid-1');
    });

    it('reuses the persisted deviceId on later sign-ins', async () => {
        mockIsSupported.mockResolvedValue(false);
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === DEVICE_ID_STORE_KEY ? 'persisted-id' : null,
        );
        installServer();

        await signInWithDevice();

        expect(callsTo('/device/sign-in/dev')[0][1].body).toEqual({
            token: 'dev-token',
            deviceId: 'persisted-id',
        });
        expect(mockSetItemAsync).not.toHaveBeenCalled();
    });

    it('unsupported with NO token reports unsupported and never touches the network', async () => {
        mockIsSupported.mockResolvedValue(false);
        installServer();

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'unsupported' });
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('server error handling', () => {
    it('maps 400 DEVICE_ATTESTATION_FAILED on sign-in to attestation-denied', async () => {
        installServer({
            '/device/sign-in/ios': () => ({
                data: null,
                error: { status: 400, code: 'DEVICE_ATTESTATION_FAILED' },
            }),
        });
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === KEY_SLOT ? 'stored-key' : null,
        );
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
    });

    it('maps 503 DEVICE_ATTESTATION_UNAVAILABLE to attestation-unavailable', async () => {
        installServer({
            '/device/attest/ios': () => ({
                data: null,
                error: { status: 503, code: 'DEVICE_ATTESTATION_UNAVAILABLE' },
            }),
        });
        mockGenerateKey.mockResolvedValue('key-1');
        mockAttestKey.mockResolvedValue('attestation-b64');

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-unavailable' });
    });

    it('maps a transport throw (offline) to a retryable network failure', async () => {
        mockFetch.mockRejectedValue(new TypeError('Network request failed'));

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'network' });
    });

    it('every failure logs ONE structured console line, with no nonce or token in it (F4)', async () => {
        const logger = (require('@/lib/logger') as { default: { warn: jest.Mock } }).default;
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'super-secret-dev-token';
        installServer({
            '/device/sign-in/ios': () => ({
                data: null,
                error: { status: 400, code: 'DEVICE_ATTESTATION_FAILED' },
            }),
        });
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === KEY_SLOT ? 'stored-key' : null,
        );
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        await signInWithDevice();

        expect(logger.warn).toHaveBeenCalledTimes(1);
        const [message, context] = logger.warn.mock.calls[0];
        expect(message).toBe('[device-auth] sign-in failed');
        expect(context).toMatchObject({
            status: 'failed',
            reason: 'attestation-denied',
            path: '/device/sign-in/ios',
            httpStatus: 400,
            code: 'DEVICE_ATTESTATION_FAILED',
        });
        const serialized = JSON.stringify(logger.warn.mock.calls[0]);
        expect(serialized).not.toContain('nonce-');
        expect(serialized).not.toContain('super-secret-dev-token');
    });

    it('a retry starts over with a FRESH nonce', async () => {
        installServer({
            '/device/sign-in/ios': () => ({
                data: null,
                error: { status: 400, code: 'DEVICE_ATTESTATION_FAILED' },
            }),
        });
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === KEY_SLOT ? 'stored-key' : null,
        );
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        await signInWithDevice();
        await signInWithDevice();

        const nonces = mockGenerateAssertion.mock.calls.map(([, hash]) => hash);
        expect(nonces[0]).not.toEqual(nonces[1]);
        expect(callsTo('/device/nonce')).toHaveLength(2);
    });
});

describe('clearDeviceAuthCredentials (S10: deletion severs, logout preserves)', () => {
    it('deletes the ACCOUNT credentials only; the deviceRef is trial history and survives', async () => {
        await clearDeviceAuthCredentials();
        expect(mockDeleteItemAsync).toHaveBeenCalledWith(APP_ATTEST_KEY_ID_STORE_KEY);
        expect(mockDeleteItemAsync).toHaveBeenCalledWith(DEVICE_ID_STORE_KEY);
        // The e2e proved the old behavior minted a FRESH trial after every
        // deletion: severing must never touch the trial-memory anchor.
        expect(mockDeleteItemAsync).not.toHaveBeenCalledWith(DEVICE_REF_STORE_KEY);
    });

    it('deletion keeps the deviceRef, so the NEXT mint presents it and gets no trial', async () => {
        // Post-deletion state: account creds severed, trial anchor kept.
        const store: Record<string, string> = {
            [APP_ATTEST_KEY_ID_STORE_KEY]: 'key-1',
            [DEVICE_ID_STORE_KEY]: 'uuid-1',
            [DEVICE_REF_STORE_KEY]: 'ref-kept',
        };
        mockGetItemAsync.mockImplementation(async (k: string) => store[k] ?? null);
        mockDeleteItemAsync.mockImplementation(async (k: string) => {
            delete store[k];
        });
        await clearDeviceAuthCredentials();
        expect(store[DEVICE_REF_STORE_KEY]).toBe('ref-kept');

        installServer({
            '/device/sign-in/ios': () => ({
                data: { user: { id: 'user-3' }, trialAvailable: false },
                error: null,
            }),
        });
        mockGenerateKey.mockResolvedValue('key-2');
        mockAttestKey.mockResolvedValue('attestation-b64');
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        const result = await signInWithDevice();

        expect(callsTo('/device/sign-in/ios')[0][1].body).toMatchObject({ deviceRef: 'ref-kept' });
        expect(result).toMatchObject({ status: 'success', trialAvailable: false });
    });

    it('is total: one failing delete does not stop the others', async () => {
        mockDeleteItemAsync.mockRejectedValueOnce(new Error('keychain locked'));
        await expect(clearDeviceAuthCredentials()).resolves.toBeUndefined();
        expect(mockDeleteItemAsync).toHaveBeenCalledTimes(2);
    });
});

describe('deviceSignInAvailability', () => {
    it('native when supported', async () => {
        mockIsSupported.mockResolvedValue(true);
        expect(await deviceSignInAvailability()).toBe('native');
    });

    it('dev-bypass when unsupported but the token is set', async () => {
        mockIsSupported.mockResolvedValue(false);
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
        expect(await deviceSignInAvailability()).toBe('dev-bypass');
    });

    it('unavailable when unsupported and no token', async () => {
        mockIsSupported.mockResolvedValue(false);
        expect(await deviceSignInAvailability()).toBe('unavailable');
    });
});
