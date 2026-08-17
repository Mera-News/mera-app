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
    DEV_DEVICE_ID_STORE_KEY,
    deviceSignInAvailability,
    signInWithDevice,
    utf8ToBase64,
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
});

afterAll(() => {
    (Platform as { OS: string }).OS = originalPlatform;
});

describe('utf8ToBase64', () => {
    it('matches Buffer for ASCII and multibyte input', () => {
        for (const s of ['{"nonce":"abc-123"}', 'héllo wörld', '日本語', '']) {
            expect(utf8ToBase64(s)).toBe(Buffer.from(s, 'utf8').toString('base64'));
        }
    });
});

describe('iOS first-run enrollment', () => {
    it('enrolls (nonce -> generateKey -> attest -> POST) then signs in with a FRESH nonce', async () => {
        installServer();
        mockGenerateKey.mockResolvedValue('key-1');
        mockAttestKey.mockResolvedValue('attestation-b64');
        mockGenerateAssertion.mockResolvedValue('assertion-b64');

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'success', userId: 'user-1' });

        // Enrollment used nonce-1; sign-in used nonce-2. Never the same nonce.
        expect(callsTo('/device/nonce')).toHaveLength(2);
        expect(mockAttestKey).toHaveBeenCalledWith('key-1', 'sha256(nonce-1)');
        const attestBody = callsTo('/device/attest/ios')[0][1].body;
        expect(attestBody).toEqual({
            keyId: 'key-1',
            attestation: 'attestation-b64',
            nonce: 'nonce-1',
        });

        const clientData = JSON.stringify({ nonce: 'nonce-2' });
        expect(mockGenerateAssertion).toHaveBeenCalledWith('key-1', `sha256(${clientData})`);
        const signInBody = callsTo('/device/sign-in/ios')[0][1].body;
        expect(signInBody).toEqual({
            keyId: 'key-1',
            assertion: 'assertion-b64',
            clientData: Buffer.from(clientData, 'utf8').toString('base64'),
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

        expect(result).toEqual({ status: 'success', userId: 'user-1' });
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

        expect(result).toEqual({ status: 'success', userId: 'user-1' });
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
    it('requests a classic integrity token with the nonce and posts it', async () => {
        (Platform as { OS: string }).OS = 'android';
        process.env.EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT = '123456';
        installServer();
        mockRequestIntegrityToken.mockResolvedValue('integrity-token');

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'success', userId: 'user-1' });
        expect(mockRequestIntegrityToken).toHaveBeenCalledWith('nonce-1', '123456');
        expect(callsTo('/device/sign-in/android')[0][1].body).toEqual({
            integrityToken: 'integrity-token',
            nonce: 'nonce-1',
        });
    });

    it('omits the cloud project number when the env var is unset', async () => {
        (Platform as { OS: string }).OS = 'android';
        installServer();
        mockRequestIntegrityToken.mockResolvedValue('integrity-token');

        await signInWithDevice();

        expect(mockRequestIntegrityToken).toHaveBeenCalledWith('nonce-1', null);
    });
});

describe('dev bypass', () => {
    it('used only when unsupported AND the env token is set; persists a stable deviceId', async () => {
        mockIsSupported.mockResolvedValue(false);
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
        installServer();

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'success', userId: 'user-1' });
        expect(callsTo('/device/sign-in/dev')[0][1].body).toEqual({
            token: 'dev-token',
            deviceId: 'dev-uuid-1',
        });
        expect(mockSetItemAsync).toHaveBeenCalledWith(DEV_DEVICE_ID_STORE_KEY, 'dev-uuid-1');
    });

    it('reuses the persisted deviceId on later sign-ins', async () => {
        mockIsSupported.mockResolvedValue(false);
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
        mockGetItemAsync.mockImplementation(async (k: string) =>
            k === DEV_DEVICE_ID_STORE_KEY ? 'persisted-id' : null,
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
