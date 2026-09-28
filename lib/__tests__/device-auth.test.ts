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
    // The REAL classifier: duplicating it here would make the spec test a copy.
    isIntegrityUnavailableError: (e: unknown) =>
        (
            jest.requireActual('../../modules/mera-device-attest/index') as {
                isIntegrityUnavailableError: (err: unknown) => boolean;
            }
        ).isIntegrityUnavailableError(e),
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
    APP_ATTEST_KEY_PROVEN_STORE_KEY,
    DEVICE_ID_STORE_KEY,
    bindIntegrityNonce,
    clearDeviceAuthCredentials,
    deviceSignInAvailability,
    deviceSignInPath,
    signInWithDevice,
} from '../device-auth';

const KEY_SLOT = APP_ATTEST_KEY_ID_STORE_KEY;
/** The RETIRED device-reference slot. Nothing may read, send or write it. */
const RETIRED_REF_SLOT = 'mera_device_ref';

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
    it('sends ANDROID_ID as the deviceId and binds it into the Play Integrity nonce', async () => {
        (Platform as { OS: string }).OS = 'android';
        process.env.EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT = '123456';
        installServer();
        mockRequestIntegrityToken.mockResolvedValue('integrity-token');

        const result = await signInWithDevice();

        expect(result).toMatchObject({ status: 'success', userId: 'user-1' });
        expect(callsTo('/device/nonce')[0][1].body).toEqual({ purpose: 'integrity' });
        // The token is requested over the BOUND value; the body keeps the raw
        // server nonce and the same deviceId (the mock hash is `sha256(x)`,
        // which the base64url step leaves unchanged).
        expect(mockRequestIntegrityToken).toHaveBeenCalledWith(
            'sha256(nonce-1|android-hw-1)',
            '123456',
        );
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
        // The fallback id is the one bound into the token.
        expect(mockRequestIntegrityToken).toHaveBeenCalledWith(
            'sha256(nonce-1|dev-uuid-1)',
            null,
        );
        expect(mockSetItemAsync).toHaveBeenCalledWith(DEVICE_ID_STORE_KEY, 'dev-uuid-1');
    });

    it('omits the cloud project number when the env var is unset', async () => {
        (Platform as { OS: string }).OS = 'android';
        installServer();
        mockRequestIntegrityToken.mockResolvedValue('integrity-token');

        await signInWithDevice();

        expect(mockRequestIntegrityToken).toHaveBeenCalledWith(
            'sha256(nonce-1|android-hw-1)',
            null,
        );
    });

    it('resolves the deviceId BEFORE requesting the token', async () => {
        (Platform as { OS: string }).OS = 'android';
        installServer();
        const order: string[] = [];
        mockGetAndroidId.mockImplementation(() => {
            order.push('deviceId');
            return 'android-hw-1';
        });
        mockRequestIntegrityToken.mockImplementation(async () => {
            order.push('token');
            return 'integrity-token';
        });

        await signInWithDevice();

        expect(order).toEqual(['deviceId', 'token']);
    });

    it('a 403 on an ANDROID_ID device never retries: severing cannot change its record key', async () => {
        (Platform as { OS: string }).OS = 'android';
        let signInCalls = 0;
        installServer({
            '/device/sign-in/android': () => {
                signInCalls += 1;
                return { data: null, error: { status: 403, code: 'ACCOUNT_DELETED' } };
            },
        });
        mockRequestIntegrityToken.mockResolvedValue('integrity-token');

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'unknown' });
        expect(signInCalls).toBe(1);
        expect(mockDeleteItemAsync).not.toHaveBeenCalled();
    });
});

describe('bindIntegrityNonce (contract shared with the server)', () => {
    it('matches the shared test vector with a REAL SHA-256', async () => {
        const Crypto = require('expo-crypto') as { digestStringAsync: jest.Mock };
        const { createHash } = jest.requireActual('crypto') as typeof import('crypto');
        Crypto.digestStringAsync.mockImplementationOnce(async (_alg: string, input: string) =>
            createHash('sha256').update(Buffer.from(input, 'utf8')).digest('base64'),
        );

        const bound = await bindIntegrityNonce(
            'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
            '9774d56d682e549c',
        );

        expect(bound).toBe('5E2pe4wGK3Y4kgsLKC7K_V4VgNADSzrL2Z2XA7p6iNY');
        // Play Integrity: web-safe, no-wrap base64, 16..500 bytes.
        expect(bound).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('turns standard base64 into web-safe base64 with no padding', async () => {
        const Crypto = require('expo-crypto') as { digestStringAsync: jest.Mock };
        Crypto.digestStringAsync.mockResolvedValueOnce('ab+c/d==');
        await expect(bindIntegrityNonce('n', 'd')).resolves.toBe('ab-c_d');
    });
});

describe('deviceSignInPath', () => {
    it('iOS with native support is app-attest', async () => {
        await expect(deviceSignInPath()).resolves.toBe('app-attest');
    });

    it('Android with a readable ANDROID_ID is play-integrity', async () => {
        (Platform as { OS: string }).OS = 'android';
        await expect(deviceSignInPath()).resolves.toBe('play-integrity');
    });

    it('Android without ANDROID_ID is the uuid fallback', async () => {
        (Platform as { OS: string }).OS = 'android';
        mockGetAndroidId.mockReturnValue('');
        await expect(deviceSignInPath()).resolves.toBe('play-integrity-uuid');
    });

    it('unsupported with a dev token is dev-bypass, without one unavailable', async () => {
        mockIsSupported.mockResolvedValue(false);
        await expect(deviceSignInPath()).resolves.toBe('unavailable');
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
        await expect(deviceSignInPath()).resolves.toBe('dev-bypass');
    });
});

describe('retired deviceRef', () => {
    it('never reads, sends or stores it, even when a leftover is stored and an old server returns one', async () => {
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === KEY_SLOT ? 'stored-key' : k === RETIRED_REF_SLOT ? 'ref-stored' : null,
        );
        installServer({
            '/device/sign-in/ios': () => ({
                data: { user: { id: 'user-1' }, deviceRef: 'ref-fresh', trialAvailable: true },
                error: null,
            }),
        });
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        const result = await signInWithDevice();

        expect(result).toMatchObject({ status: 'success', userId: 'user-1', trialAvailable: true });
        expect(callsTo('/device/sign-in/ios')[0][1].body).not.toHaveProperty('deviceRef');
        expect(mockGetItemAsync).not.toHaveBeenCalledWith(RETIRED_REF_SLOT);
        expect(mockSetItemAsync).not.toHaveBeenCalledWith(RETIRED_REF_SLOT, expect.anything());
    });

    it('the Android and dev bodies carry no deviceRef', async () => {
        (Platform as { OS: string }).OS = 'android';
        installServer();
        mockRequestIntegrityToken.mockResolvedValue('integrity-token');
        await signInWithDevice();
        expect(callsTo('/device/sign-in/android')[0][1].body).not.toHaveProperty('deviceRef');

        mockIsSupported.mockResolvedValue(false);
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
        await signInWithDevice();
        expect(callsTo('/device/sign-in/dev')[0][1].body).toEqual({
            token: 'dev-token',
            deviceId: 'dev-uuid-1',
        });
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
            // Severed: the account slots cleared before the retry.
            expect(mockDeleteItemAsync).toHaveBeenCalledWith(KEY_SLOT);
            expect(mockDeleteItemAsync).toHaveBeenCalledWith(DEVICE_ID_STORE_KEY);
            // Fresh enrollment happened exactly once.
            expect(mockGenerateKey).toHaveBeenCalledTimes(1);
            expect(signInCalls).toBe(2);
        },
    );

    it('a PROVEN key the server no longer has a record for (403 after deletion) re-enrolls', async () => {
        const store: Record<string, string> = {
            [KEY_SLOT]: 'stored-key',
            [APP_ATTEST_KEY_PROVEN_STORE_KEY]: 'stored-key',
        };
        mockGetItemAsync.mockImplementation(async (k: string) => store[k] ?? null);
        mockSetItemAsync.mockImplementation(async (k: string, v: string) => {
            store[k] = v;
        });
        mockDeleteItemAsync.mockImplementation(async (k: string) => {
            delete store[k];
        });
        let signInCalls = 0;
        installServer({
            '/device/sign-in/ios': () => {
                signInCalls += 1;
                return signInCalls === 1
                    ? refusal('DEVICE_ATTESTATION_FAILED')
                    : { data: { user: { id: 'user-new' } }, error: null };
            },
        });
        mockGenerateKey.mockResolvedValue('key-2');
        mockAttestKey.mockResolvedValue('attestation-b64');
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        const result = await signInWithDevice();

        expect(result).toMatchObject({ status: 'success', userId: 'user-new' });
        expect(mockGenerateKey).toHaveBeenCalledTimes(1);
        expect(store[KEY_SLOT]).toBe('key-2');
    });

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

    it('a 400 DEVICE_ATTESTATION_FAILED on a proven key never clears anything', async () => {
        // Proven key: the virgin-key recovery (its own describe) must not
        // fire, and a 400 must never touch the deviceId either way.
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === KEY_SLOT
                ? 'stored-key'
                : k === APP_ATTEST_KEY_PROVEN_STORE_KEY
                    ? 'stored-key'
                    : null,
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
        // Proven key, so the 400 surfaces directly (no in-call recovery) and
        // the two user-level retries are exactly two nonces.
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === KEY_SLOT
                ? 'stored-key'
                : k === APP_ATTEST_KEY_PROVEN_STORE_KEY
                    ? 'stored-key'
                    : null,
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
    it('deletes the account credentials and any retired deviceRef leftover', async () => {
        await clearDeviceAuthCredentials();
        expect(mockDeleteItemAsync).toHaveBeenCalledWith(APP_ATTEST_KEY_ID_STORE_KEY);
        expect(mockDeleteItemAsync).toHaveBeenCalledWith(APP_ATTEST_KEY_PROVEN_STORE_KEY);
        expect(mockDeleteItemAsync).toHaveBeenCalledWith(DEVICE_ID_STORE_KEY);
        expect(mockDeleteItemAsync).toHaveBeenCalledWith(RETIRED_REF_SLOT);
    });

    it('is total: one failing delete does not stop the others, and it is logged by slot only', async () => {
        const logger = (require('@/lib/logger') as { default: { warn: jest.Mock } }).default;
        mockDeleteItemAsync.mockRejectedValueOnce(new Error('keychain locked'));
        await expect(clearDeviceAuthCredentials()).resolves.toBeUndefined();
        expect(mockDeleteItemAsync).toHaveBeenCalledTimes(4);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith('[device-auth] could not clear a device credential', {
            slot: 'appattest_key_id',
            errorName: 'Error',
        });
    });
});

describe('Play Integrity structural unavailability (MERA-APP-6P)', () => {
    const integrityRejection = (code: number) =>
        Object.assign(
            new Error(`Play Integrity token request failed: Integrity API error (${code}): x.`),
            { code: 'ERR_ATTEST_INTEGRITY_FAILED' },
        );

    beforeEach(() => {
        (Platform as { OS: string }).OS = 'android';
        installServer();
    });

    it('a permanent code (API_NOT_AVAILABLE) maps to the quiet UNSUPPORTED outcome, no Sentry capture', async () => {
        const logger = (require('@/lib/logger') as { default: Record<string, jest.Mock> }).default;
        mockRequestIntegrityToken.mockRejectedValue(integrityRejection(-1));

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'unsupported' });
        expect(logger.captureException).not.toHaveBeenCalled();
        expect(logger.captureMessage).not.toHaveBeenCalled();
        // At most one structured warn line.
        expect(logger.warn.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('a transient code (NETWORK_ERROR) keeps the retryable failure state', async () => {
        mockRequestIntegrityToken.mockRejectedValue(integrityRejection(-3));
        const result = await signInWithDevice();
        expect(result).toEqual({ status: 'failed', reason: 'unknown' });
    });

    it('the existing isSupported=false path is unchanged', async () => {
        mockIsSupported.mockResolvedValue(false);
        const result = await signInWithDevice();
        expect(result).toEqual({ status: 'unsupported' });
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('virgin-key assert rejection (rejected-enrollment recovery)', () => {
    // The prod gap: enrollment's server attest failed AFTER the client had a
    // key (or the server mis-stored it), so every later assert 400s forever.
    // A 400 on a key that has NEVER completed a sign-in severs and re-enrolls
    // once; a PROVEN key's 400 stays a plain denial.
    const statefulKeychain = (initial: Record<string, string>) => {
        const store: Record<string, string> = { ...initial };
        mockGetItemAsync.mockImplementation(async (k: string) => store[k] ?? null);
        mockDeleteItemAsync.mockImplementation(async (k: string) => {
            delete store[k];
        });
        mockSetItemAsync.mockImplementation(async (k: string, v: string) => {
            store[k] = v;
        });
        return store;
    };

    beforeEach(() => {
        mockGenerateKey.mockResolvedValue('key-2');
        mockAttestKey.mockResolvedValue('attestation-b64');
        mockGenerateAssertion.mockResolvedValue('assertion-b64');
    });

    it('assert 400 on a VIRGIN stored key severs it and re-enrolls once, then succeeds and marks proven', async () => {
        const store = statefulKeychain({ [APP_ATTEST_KEY_ID_STORE_KEY]: 'virgin-key' });
        let signInCalls = 0;
        installServer({
            '/device/sign-in/ios': () => {
                signInCalls += 1;
                return signInCalls === 1
                    ? { data: null, error: { status: 400, code: 'DEVICE_ATTESTATION_FAILED' } }
                    : { data: { user: { id: 'user-2' } }, error: null };
            },
        });

        const result = await signInWithDevice();

        expect(result).toMatchObject({ status: 'success', userId: 'user-2' });
        expect(mockGenerateKey).toHaveBeenCalledTimes(1);
        expect(signInCalls).toBe(2);
        expect(store[APP_ATTEST_KEY_ID_STORE_KEY]).toBe('key-2');
        expect(store[APP_ATTEST_KEY_PROVEN_STORE_KEY]).toBe('key-2');
    });

    it('recovers once and ONLY once: a persistent 400 surfaces as attestation-denied', async () => {
        statefulKeychain({ [APP_ATTEST_KEY_ID_STORE_KEY]: 'virgin-key' });
        installServer({
            '/device/sign-in/ios': () => ({
                data: null,
                error: { status: 400, code: 'DEVICE_ATTESTATION_FAILED' },
            }),
        });

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
        expect(mockGenerateKey).toHaveBeenCalledTimes(1);
    });

    it('assert 400 on a PROVEN key does NOT sever: a once-working binding is never destroyed on a denial', async () => {
        statefulKeychain({
            [APP_ATTEST_KEY_ID_STORE_KEY]: 'proven-key',
            [APP_ATTEST_KEY_PROVEN_STORE_KEY]: 'proven-key',
        });
        installServer({
            '/device/sign-in/ios': () => ({
                data: null,
                error: { status: 400, code: 'DEVICE_ATTESTATION_FAILED' },
            }),
        });

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
        expect(mockGenerateKey).not.toHaveBeenCalled();
        expect(mockDeleteItemAsync).not.toHaveBeenCalledWith(APP_ATTEST_KEY_ID_STORE_KEY);
    });

    it('a successful resume marks the stored key proven', async () => {
        const store = statefulKeychain({ [APP_ATTEST_KEY_ID_STORE_KEY]: 'stored-key' });
        installServer();

        await signInWithDevice();

        expect(store[APP_ATTEST_KEY_PROVEN_STORE_KEY]).toBe('stored-key');
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
