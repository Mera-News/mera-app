// Seam test for device sign-in (lib/device-auth.ts): nonce, App Attest / Play Integrity, the dev
// bypass and the refusal recoveries. Real auth client, secure store and SHA-256 against the mock
// auth service; the only mocks are the attestation SDK wrapper, ANDROID_ID and the logger.
import { createHash } from 'node:crypto';
import Constants from 'expo-constants';
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
} from '@/lib/device-auth';
import logger from '@/lib/logger';
import { __resetLegalConsentLatchForTests } from '@/components/custom/auth/legal-consent';
import { __resetIdentityStateForTests } from '@/lib/security/identity-gate';
import { __resetAuthReadQuarantineForTests, releaseAuthReadQuarantine } from '@/lib/security/install-boundary-latch';
import { __resetInstallBoundaryForTests } from '@/lib/security/install-boundary';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import { __resetDeviceAttestForTests } from '@/modules/mera-device-attest';
import { FIXTURE_ACCOUNT, HttpResponse, failSecureStore, http, secureStoreDump, server } from '@/test/helpers';

// The attestation SDK wrapper is the device edge. Its error classifiers stay real, because the
// code mapping under test lives in them.
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

const mockAndroidId = jest.fn();
jest.mock('expo-application', () => ({ getAndroidId: () => mockAndroidId() }));

// Every method is a jest.fn, so the log lines and captures are assertable.
jest.mock('@/lib/logger', () => {
    const fns: Record<string, jest.Mock> = {};
    const logger = new Proxy({}, { get: (_t, key: string) => (fns[key] ??= jest.fn()) });
    return { __esModule: true, default: logger };
});

const SLUG = Constants.expoConfig?.slug || 'app';
const KEY_SLOT = APP_ATTEST_KEY_ID_STORE_KEY;
const PROVEN_SLOT = APP_ATTEST_KEY_PROVEN_STORE_KEY;
const RETIRED_REF_SLOT = `${SLUG}_device_ref`;
const ME = FIXTURE_ACCOUNT.userId;
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const sha256Base64 = (input: string) => createHash('sha256').update(input).digest('base64');
const dump = () => secureStoreDump();
const seed = (slots: Record<string, string>) => Promise.all(Object.entries(slots).map(([k, v]) => secureStore.setItemAsync(k, v)));
const log = logger as unknown as Record<string, jest.Mock>;

// ─── What the app sent to /device/* ──────────────────────────────────────────

interface Sent {
    path: string;
    body: Promise<any>;
}
const sent: Sent[] = [];
const onRequest = ({ request }: { request: Request }) => {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/api/auth/device/')) return;
    sent.push({ path: pathname.replace('/api/auth', ''), body: request.clone().json().catch(() => undefined) });
};
const bodiesTo = (path: string) => Promise.all(sent.filter((s) => s.path === path).map((s) => s.body));
const countTo = (path: string) => sent.filter((s) => s.path === path).length;
const noncePurposes = async () => (await bodiesTo('/device/nonce')).map((b) => b.purpose);

// ─── What the server answers ─────────────────────────────────────────────────

const rejection = (status: number, code: string) => HttpResponse.json({ code, message: code }, { status });
const SIGN_IN = (platform: 'ios' | 'android' | 'dev') => `*/api/auth/device/sign-in/${platform}`;
const ATTEST_IOS = '*/api/auth/device/attest/ios';

/** Answers the nth call (1-based) of the route with `answers[n-1]`, then the default handler. */
function answerInOrder(url: string, ...answers: (() => Response | undefined)[]) {
    let call = 0;
    server.use(http.post(url, () => answers[call++]?.()));
}

beforeEach(() => {
    jest.clearAllMocks();
    __resetIdentityStateForTests();
    __resetLegalConsentLatchForTests();
    __resetAuthReadQuarantineForTests();
    __resetInstallBoundaryForTests();
    __resetDeviceAttestForTests();
    releaseAuthReadQuarantine();

    (Platform as { OS: string }).OS = 'ios';
    delete process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN;
    delete process.env.EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT;

    mockAttest.isSupported.mockReset().mockResolvedValue(true);
    mockAttest.generateKey.mockReset().mockResolvedValue('key-1');
    mockAttest.attestKey.mockReset().mockResolvedValue('attestation-b64');
    mockAttest.generateAssertion.mockReset().mockResolvedValue('assertion-b64');
    mockAttest.requestIntegrityToken.mockReset().mockResolvedValue('integrity-token');
    mockAndroidId.mockReset().mockReturnValue('android-hw-1');

    sent.length = 0;
    server.events.on('request:start', onRequest);
});

afterEach(() => {
    server.events.removeListener('request:start', onRequest);
    (Platform as { OS: string }).OS = 'ios';
});

describe('iOS first-run enrollment', () => {
    it('enrolls (nonce, generateKey, attest, POST) then signs in with a FRESH nonce', async () => {
        let storedWhenAttestArrived: string | undefined = 'unset';
        server.use(
            http.post(ATTEST_IOS, () => {
                storedWhenAttestArrived = dump()[KEY_SLOT];
            }),
        );

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'success', userId: ME, trialAvailable: false });

        // Enrollment used one nonce (purpose attest); sign-in used another (purpose assert).
        expect(await noncePurposes()).toEqual(['attest', 'assert']);
        const [attestBody] = await bodiesTo('/device/attest/ios');
        const [signInBody] = await bodiesTo('/device/sign-in/ios');
        expect(attestBody).toEqual({ keyId: 'key-1', attestation: 'attestation-b64', nonce: attestBody.nonce });
        expect(signInBody).toEqual({ keyId: 'key-1', assertion: 'assertion-b64', nonce: signInBody.nonce });
        expect(signInBody.nonce).not.toBe(attestBody.nonce);

        // The nonce IS the client data: the native calls get its hash, the bodies carry it raw.
        expect(mockAttest.attestKey).toHaveBeenCalledWith('key-1', sha256Base64(attestBody.nonce));
        expect(mockAttest.generateAssertion).toHaveBeenCalledWith('key-1', sha256Base64(signInBody.nonce));

        // The keyId is persisted only after the server accepted the attestation.
        expect(storedWhenAttestArrived).toBeUndefined();
        expect(dump()[KEY_SLOT]).toBe('key-1');
    });

    it('does not persist the keyId when the server rejects the attestation', async () => {
        server.use(http.post(ATTEST_IOS, () => rejection(400, 'DEVICE_ATTESTATION_FAILED')));

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
        expect(dump()[KEY_SLOT]).toBeUndefined();
        expect(countTo('/device/sign-in/ios')).toBe(0);
    });
});

describe('iOS resume', () => {
    it('skips enrollment when a keyId is stored', async () => {
        await seed({ [KEY_SLOT]: 'stored-key' });

        const result = await signInWithDevice();

        expect(result).toMatchObject({ status: 'success', userId: ME });
        expect(mockAttest.generateKey).not.toHaveBeenCalled();
        expect(mockAttest.attestKey).not.toHaveBeenCalled();
        expect(countTo('/device/attest/ios')).toBe(0);
        expect(await noncePurposes()).toEqual(['assert']);
        expect(mockAttest.generateAssertion).toHaveBeenCalledWith('stored-key', expect.any(String));
    });

    it('a keychain READ failure aborts as retryable: it must never re-enroll', async () => {
        await seed({ [KEY_SLOT]: 'stored-key' });
        failSecureStore(KEY_SLOT, 'get');

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'unknown' });
        expect(mockAttest.generateKey).not.toHaveBeenCalled();
        expect(countTo('/device/attest/ios')).toBe(0);
    });

    it('a successful resume marks the stored key proven', async () => {
        await seed({ [KEY_SLOT]: 'stored-key' });

        await signInWithDevice();

        expect(dump()[PROVEN_SLOT]).toBe('stored-key');
    });
});

describe('iOS invalid-key recovery', () => {
    const invalidKey = () => Object.assign(new Error('invalid key'), { code: 'ERR_ATTEST_INVALID_KEY' });

    it('clears the dead keyId and restarts from generateKey', async () => {
        await seed({ [KEY_SLOT]: 'dead-key' });
        mockAttest.generateAssertion.mockRejectedValueOnce(invalidKey());
        mockAttest.generateKey.mockResolvedValue('key-2');

        const result = await signInWithDevice();

        expect(result).toMatchObject({ status: 'success', userId: ME });
        expect((await bodiesTo('/device/attest/ios'))[0]).toMatchObject({ keyId: 'key-2' });
        expect(dump()[KEY_SLOT]).toBe('key-2');
        expect(mockAttest.generateAssertion).toHaveBeenLastCalledWith('key-2', expect.any(String));
    });

    it('does not loop: an invalid key right after enrollment fails instead of re-enrolling', async () => {
        mockAttest.generateAssertion.mockRejectedValue(invalidKey());

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'unknown' });
        expect(mockAttest.generateKey).toHaveBeenCalledTimes(1);
    });
});

describe('Android', () => {
    beforeEach(() => {
        (Platform as { OS: string }).OS = 'android';
    });

    /** What the app asked Play Integrity to bind, recomputed from the nonce it sent the server. */
    const bound = (nonce: string, deviceId: string) =>
        createHash('sha256').update(`${nonce}|${deviceId}`).digest('base64url');

    it('sends ANDROID_ID as the deviceId and binds it into the Play Integrity nonce', async () => {
        process.env.EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT = '123456';

        const result = await signInWithDevice();

        expect(result).toMatchObject({ status: 'success', userId: ME });
        expect(await noncePurposes()).toEqual(['integrity']);
        const [body] = await bodiesTo('/device/sign-in/android');
        // The body keeps the RAW server nonce; the token was requested over the bound value.
        expect(body).toEqual({ integrityToken: 'integrity-token', nonce: body.nonce, deviceId: 'android-hw-1' });
        expect(mockAttest.requestIntegrityToken).toHaveBeenCalledWith(bound(body.nonce, 'android-hw-1'), '123456');
    });

    it.each([
        ['throws', () => { throw new Error('unavailable'); }],
        ['returns an empty string', () => ''],
        ['returns null', () => null],
    ])('falls back to a stored UUID when getAndroidId %s', async (_label, impl) => {
        mockAndroidId.mockImplementation(impl);

        await signInWithDevice();

        const [body] = await bodiesTo('/device/sign-in/android');
        expect(body.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        // The fallback id is the one bound into the token, and it is kept for the next attempt.
        expect(mockAttest.requestIntegrityToken).toHaveBeenCalledWith(bound(body.nonce, body.deviceId), null);
        expect(dump()[DEVICE_ID_STORE_KEY]).toBe(body.deviceId);
    });

    it('omits the cloud project number when the env var is unset', async () => {
        await signInWithDevice();

        expect(mockAttest.requestIntegrityToken).toHaveBeenCalledWith(expect.any(String), null);
    });

    it('resolves the deviceId BEFORE requesting the token', async () => {
        const order: string[] = [];
        mockAndroidId.mockImplementation(() => {
            order.push('deviceId');
            return 'android-hw-1';
        });
        mockAttest.requestIntegrityToken.mockImplementation(async () => {
            order.push('token');
            return 'integrity-token';
        });

        await signInWithDevice();

        expect(order).toEqual(['deviceId', 'token']);
    });

    it('a 403 on an ANDROID_ID device never retries: severing cannot change its record key', async () => {
        server.use(http.post(SIGN_IN('android'), () => rejection(403, 'ACCOUNT_DELETED')));

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'unknown' });
        expect(countTo('/device/sign-in/android')).toBe(1);
    });

    it('the body carries no deviceRef', async () => {
        await signInWithDevice();

        const [body] = await bodiesTo('/device/sign-in/android');
        expect(Object.keys(body).sort()).toEqual(['deviceId', 'integrityToken', 'nonce']);
    });
});

describe('Play Integrity classification', () => {
    const integrityRejection = (code: number) =>
        Object.assign(new Error(`Play Integrity token request failed: Integrity API error (${code}): x.`), {
            code: 'ERR_ATTEST_INTEGRITY_FAILED',
        });

    beforeEach(() => {
        (Platform as { OS: string }).OS = 'android';
    });

    it.each([-1, -2, -6, -9, -14, -15])(
        'code %i (this environment can never attest) is the quiet UNSUPPORTED outcome, no capture',
        async (code) => {
            mockAttest.requestIntegrityToken.mockRejectedValue(integrityRejection(code));

            const result = await signInWithDevice();

            expect(result).toEqual({ status: 'unsupported' });
            expect(log.captureException).not.toHaveBeenCalled();
            expect(log.captureMessage).not.toHaveBeenCalled();
            // At most the one structured warn line.
            expect(log.warn.mock.calls.length).toBeLessThanOrEqual(1);
        },
    );

    it.each([-8, -12, -17, -100])('code %i is retryable attestation-unavailable, captured as a warning', async (code) => {
        mockAttest.requestIntegrityToken.mockRejectedValue(integrityRejection(code));

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-unavailable' });
        expect(log.captureException).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({ level: 'warning', fingerprint: ['play-integrity-transient'] }),
        );
    });

    it('NETWORK_ERROR (-3) and misuse codes keep the retryable unknown failure, captured', async () => {
        mockAttest.requestIntegrityToken.mockRejectedValue(integrityRejection(-3));

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'unknown' });
        expect(log.captureException).toHaveBeenCalled();
    });

    it('a code in the text of some other error is not classified', async () => {
        mockAttest.requestIntegrityToken.mockRejectedValue(new Error('Integrity API error (-1): x.'));

        await expect(signInWithDevice()).resolves.toEqual({ status: 'failed', reason: 'unknown' });
    });

    it('the existing isSupported=false path is unchanged: unsupported, no network', async () => {
        mockAttest.isSupported.mockResolvedValue(false);

        await expect(signInWithDevice()).resolves.toEqual({ status: 'unsupported' });
        expect(sent).toHaveLength(0);
    });
});

describe('bindIntegrityNonce (contract shared with the server)', () => {
    it('matches the shared test vector with a REAL SHA-256', async () => {
        const bound = await bindIntegrityNonce('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', '9774d56d682e549c');

        expect(bound).toBe('5E2pe4wGK3Y4kgsLKC7K_V4VgNADSzrL2Z2XA7p6iNY');
        // Play Integrity: web-safe, no-wrap base64, 16..500 bytes.
        expect(bound).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('turns standard base64 into web-safe base64 with no padding', async () => {
        const inputs = Array.from({ length: 200 }, (_, i) => [`nonce-${i}`, `device-${i}`] as const);
        const standard = inputs.map(([n, d]) => sha256Base64(`${n}|${d}`));
        // Not vacuous: among these digests there are ones carrying '+', '/' and the '=' pad.
        expect(standard.some((s) => s.includes('+'))).toBe(true);
        expect(standard.some((s) => s.includes('/'))).toBe(true);
        expect(standard.every((s) => s.endsWith('='))).toBe(true);

        for (const [i, [n, d]] of inputs.entries()) {
            const bound = await bindIntegrityNonce(n, d);
            expect(bound).toBe(standard[i].replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
            expect(bound).toMatch(/^[A-Za-z0-9_-]{43}$/);
        }
    });
});

describe('deviceSignInPath and availability', () => {
    it('iOS with native support is app-attest', async () => {
        await expect(deviceSignInPath()).resolves.toBe('app-attest');
    });

    it('Android with a readable ANDROID_ID is play-integrity', async () => {
        (Platform as { OS: string }).OS = 'android';
        await expect(deviceSignInPath()).resolves.toBe('play-integrity');
    });

    it('Android without ANDROID_ID is the uuid fallback', async () => {
        (Platform as { OS: string }).OS = 'android';
        mockAndroidId.mockReturnValue('');
        await expect(deviceSignInPath()).resolves.toBe('play-integrity-uuid');
    });

    it('unsupported with a dev token is dev-bypass, without one unavailable', async () => {
        mockAttest.isSupported.mockResolvedValue(false);
        await expect(deviceSignInPath()).resolves.toBe('unavailable');
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
        await expect(deviceSignInPath()).resolves.toBe('dev-bypass');
    });

    it('availability is native when supported', async () => {
        await expect(deviceSignInAvailability()).resolves.toBe('native');
    });

    it('availability is dev-bypass when unsupported but the token is set', async () => {
        mockAttest.isSupported.mockResolvedValue(false);
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
        await expect(deviceSignInAvailability()).resolves.toBe('dev-bypass');
    });

    it('availability is unavailable when unsupported and no token', async () => {
        mockAttest.isSupported.mockResolvedValue(false);
        await expect(deviceSignInAvailability()).resolves.toBe('unavailable');
    });
});

describe('the sign-in response', () => {
    it('an older server that omits trialAvailable reads as null, and the optional fields are ignored', async () => {
        server.use(http.post(SIGN_IN('ios'), () => HttpResponse.json({ user: { id: OTHER } })));

        await expect(signInWithDevice()).resolves.toEqual({ status: 'success', userId: OTHER, trialAvailable: null });
    });
});

describe('retired deviceRef', () => {
    it('is never read, sent or stored, even when a leftover is stored and an old server returns one', async () => {
        await seed({ [KEY_SLOT]: 'stored-key', [RETIRED_REF_SLOT]: 'ref-stored' });
        const reads = jest.spyOn(secureStore, 'getItemAsync');
        server.use(
            http.post(SIGN_IN('ios'), () =>
                HttpResponse.json({ user: { id: ME }, deviceRef: 'ref-fresh', trialAvailable: true }),
            ),
        );

        const result = await signInWithDevice();

        expect(result).toMatchObject({ status: 'success', userId: ME, trialAvailable: true });
        expect((await bodiesTo('/device/sign-in/ios'))[0]).not.toHaveProperty('deviceRef');
        expect(reads).not.toHaveBeenCalledWith(RETIRED_REF_SLOT);
        // Not overwritten with the one the server sent.
        expect(dump()[RETIRED_REF_SLOT]).toBe('ref-stored');
        reads.mockRestore();
    });
});

describe('refusal recovery (S10)', () => {
    const ok = (id: string = ME) => () => HttpResponse.json({ user: { id }, minted: false });

    it.each(['DEVICE_ATTESTATION_FAILED', 'ACCOUNT_DELETED'])(
        'a stored credential refused with 403 %s severs and re-enrolls ONCE, then succeeds',
        async (code) => {
            await seed({ [KEY_SLOT]: 'stored-key', [DEVICE_ID_STORE_KEY]: 'old-device' });
            answerInOrder(SIGN_IN('ios'), () => rejection(403, code), ok(OTHER));
            mockAttest.generateKey.mockResolvedValue('key-2');

            const result = await signInWithDevice();

            expect(result).toMatchObject({ status: 'success', userId: OTHER });
            // Severed: the account slots were cleared before the retry...
            expect(dump()[DEVICE_ID_STORE_KEY]).toBeUndefined();
            // ...and the retry enrolled a fresh key exactly once.
            expect(mockAttest.generateKey).toHaveBeenCalledTimes(1);
            expect(dump()[KEY_SLOT]).toBe('key-2');
            expect(countTo('/device/sign-in/ios')).toBe(2);
            // Every re-entry fetches a fresh nonce: assert, attest, assert.
            expect(await noncePurposes()).toEqual(['assert', 'attest', 'assert']);
        },
    );

    it('a PROVEN key the server no longer has a record for (403 after deletion) re-enrolls', async () => {
        await seed({ [KEY_SLOT]: 'stored-key', [PROVEN_SLOT]: 'stored-key' });
        answerInOrder(SIGN_IN('ios'), () => rejection(403, 'DEVICE_ATTESTATION_FAILED'), ok(OTHER));
        mockAttest.generateKey.mockResolvedValue('key-2');

        const result = await signInWithDevice();

        expect(result).toMatchObject({ status: 'success', userId: OTHER });
        expect(mockAttest.generateKey).toHaveBeenCalledTimes(1);
        expect(dump()[KEY_SLOT]).toBe('key-2');
    });

    it('recovers once and ONLY once: a second 403 surfaces as failure', async () => {
        await seed({ [KEY_SLOT]: 'stored-key' });
        server.use(http.post(SIGN_IN('ios'), () => rejection(403, 'DEVICE_ATTESTATION_FAILED')));
        mockAttest.generateKey.mockResolvedValue('key-2');

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
        expect(mockAttest.generateKey).toHaveBeenCalledTimes(1);
        expect(countTo('/device/sign-in/ios')).toBe(2);
    });

    it('a 400 DEVICE_ATTESTATION_FAILED on a proven key never clears anything', async () => {
        await seed({ [KEY_SLOT]: 'stored-key', [PROVEN_SLOT]: 'stored-key', [DEVICE_ID_STORE_KEY]: 'old-device' });
        server.use(http.post(SIGN_IN('ios'), () => rejection(400, 'DEVICE_ATTESTATION_FAILED')));

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
        expect(dump()).toMatchObject({ [KEY_SLOT]: 'stored-key', [PROVEN_SLOT]: 'stored-key', [DEVICE_ID_STORE_KEY]: 'old-device' });
        expect(mockAttest.generateKey).not.toHaveBeenCalled();
    });

    it('a fresh install (nothing stored) never retries on 403', async () => {
        server.use(http.post(SIGN_IN('ios'), () => rejection(403, 'DEVICE_ATTESTATION_FAILED')));

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
        expect(countTo('/device/sign-in/ios')).toBe(1);
        expect(mockAttest.generateKey).toHaveBeenCalledTimes(1);
    });

    it('503 and a dropped connection never sever the device binding', async () => {
        await seed({ [KEY_SLOT]: 'stored-key', [DEVICE_ID_STORE_KEY]: 'old-device' });
        server.use(http.post(SIGN_IN('ios'), () => rejection(503, 'DEVICE_ATTESTATION_UNAVAILABLE')));
        await expect(signInWithDevice()).resolves.toEqual({ status: 'failed', reason: 'attestation-unavailable' });

        server.use(http.post(SIGN_IN('ios'), () => HttpResponse.error()));
        await expect(signInWithDevice()).resolves.toMatchObject({ status: 'failed' });

        expect(dump()).toMatchObject({ [KEY_SLOT]: 'stored-key', [DEVICE_ID_STORE_KEY]: 'old-device' });
    });
});

describe('virgin-key assert rejection (rejected-enrollment recovery)', () => {
    const rejectAssert = () => rejection(400, 'DEVICE_ATTESTATION_FAILED');

    beforeEach(() => {
        mockAttest.generateKey.mockResolvedValue('key-2');
    });

    it('a 400 on a VIRGIN stored key severs the KEY only and re-enrolls once, then succeeds and marks proven', async () => {
        await seed({ [KEY_SLOT]: 'virgin-key', [DEVICE_ID_STORE_KEY]: 'old-device' });
        answerInOrder(SIGN_IN('ios'), rejectAssert, () => HttpResponse.json({ user: { id: OTHER } }));

        const result = await signInWithDevice();

        expect(result).toMatchObject({ status: 'success', userId: OTHER });
        expect(mockAttest.generateKey).toHaveBeenCalledTimes(1);
        expect(countTo('/device/sign-in/ios')).toBe(2);
        expect(dump()[KEY_SLOT]).toBe('key-2');
        expect(dump()[PROVEN_SLOT]).toBe('key-2');
        // The account binding itself is untouched: only the key was severed.
        expect(dump()[DEVICE_ID_STORE_KEY]).toBe('old-device');
    });

    it('recovers once and ONLY once: a persistent 400 surfaces as attestation-denied', async () => {
        await seed({ [KEY_SLOT]: 'virgin-key' });
        server.use(http.post(SIGN_IN('ios'), rejectAssert));

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
        expect(mockAttest.generateKey).toHaveBeenCalledTimes(1);
    });

    it('a 400 on a PROVEN key does NOT sever: a once-working binding is never destroyed on a denial', async () => {
        await seed({ [KEY_SLOT]: 'proven-key', [PROVEN_SLOT]: 'proven-key' });
        server.use(http.post(SIGN_IN('ios'), rejectAssert));

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
        expect(mockAttest.generateKey).not.toHaveBeenCalled();
        expect(dump()[KEY_SLOT]).toBe('proven-key');
    });

    it('an unreadable proven marker counts as proven: never sever on uncertainty', async () => {
        await seed({ [KEY_SLOT]: 'maybe-proven', [PROVEN_SLOT]: 'maybe-proven' });
        failSecureStore(PROVEN_SLOT, 'get');
        server.use(http.post(SIGN_IN('ios'), rejectAssert));

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'failed', reason: 'attestation-denied' });
        expect(mockAttest.generateKey).not.toHaveBeenCalled();
        expect(dump()[KEY_SLOT]).toBe('maybe-proven');
    });
});

describe('dev bypass', () => {
    beforeEach(() => {
        mockAttest.isSupported.mockResolvedValue(false);
    });

    it('is used only when unsupported AND the env token is set; persists a stable deviceId', async () => {
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';

        const result = await signInWithDevice();

        expect(result).toEqual({ status: 'success', userId: ME, trialAvailable: false });
        const [body] = await bodiesTo('/device/sign-in/dev');
        expect(body).toEqual({ token: 'dev-token', deviceId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
        expect(dump()[DEVICE_ID_STORE_KEY]).toBe(body.deviceId);
        expect(Object.keys(body)).not.toContain('deviceRef');
    });

    it('reuses the persisted deviceId on later sign-ins', async () => {
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
        await seed({ [DEVICE_ID_STORE_KEY]: 'persisted-id' });

        await signInWithDevice();

        expect(await bodiesTo('/device/sign-in/dev')).toEqual([{ token: 'dev-token', deviceId: 'persisted-id' }]);
        expect(dump()[DEVICE_ID_STORE_KEY]).toBe('persisted-id');
    });

    it('unsupported with NO token reports unsupported and never touches the network', async () => {
        await expect(signInWithDevice()).resolves.toEqual({ status: 'unsupported' });
        expect(sent).toHaveLength(0);
    });
});

describe('server error handling', () => {
    it('maps 400 DEVICE_ATTESTATION_FAILED on sign-in to attestation-denied', async () => {
        await seed({ [KEY_SLOT]: 'stored-key', [PROVEN_SLOT]: 'stored-key' });
        server.use(http.post(SIGN_IN('ios'), () => rejection(400, 'DEVICE_ATTESTATION_FAILED')));

        await expect(signInWithDevice()).resolves.toEqual({ status: 'failed', reason: 'attestation-denied' });
    });

    it('maps 503 DEVICE_ATTESTATION_UNAVAILABLE to attestation-unavailable', async () => {
        server.use(http.post(ATTEST_IOS, () => rejection(503, 'DEVICE_ATTESTATION_UNAVAILABLE')));

        await expect(signInWithDevice()).resolves.toEqual({ status: 'failed', reason: 'attestation-unavailable' });
    });

    it('maps ERR_ATTEST_SERVER_UNAVAILABLE from the native side to attestation-unavailable', async () => {
        mockAttest.attestKey.mockRejectedValue(Object.assign(new Error('apple'), { code: 'ERR_ATTEST_SERVER_UNAVAILABLE' }));

        await expect(signInWithDevice()).resolves.toEqual({ status: 'failed', reason: 'attestation-unavailable' });
    });

    it('maps ERR_ATTEST_UNSUPPORTED from the native side to unsupported', async () => {
        mockAttest.generateKey.mockRejectedValue(Object.assign(new Error('no'), { code: 'ERR_ATTEST_UNSUPPORTED' }));

        await expect(signInWithDevice()).resolves.toEqual({ status: 'unsupported' });
    });

    it('maps any other server rejection to unknown, reported once', async () => {
        server.use(http.post(ATTEST_IOS, () => rejection(500, 'BOOM')));

        await expect(signInWithDevice()).resolves.toEqual({ status: 'failed', reason: 'unknown' });
        expect(log.captureMessage).toHaveBeenCalledWith(
            'Device sign-in rejected by server',
            expect.objectContaining({ level: 'warning', extra: expect.objectContaining({ status: 500, code: 'BOOM' }) }),
        );
    });

    it('a response without a nonce is a malformed-response failure, not a crash', async () => {
        server.use(http.post('*/api/auth/device/nonce', () => HttpResponse.json({})));

        await expect(signInWithDevice()).resolves.toEqual({ status: 'failed', reason: 'unknown' });
    });

    it('a sign-in response without a user id is a malformed-response failure', async () => {
        server.use(http.post(SIGN_IN('ios'), () => HttpResponse.json({ user: {} })));

        await expect(signInWithDevice()).resolves.toEqual({ status: 'failed', reason: 'unknown' });
    });

    it('maps a transport throw (offline) to a retryable network failure', async () => {
        server.use(http.post('*/api/auth/device/nonce', () => HttpResponse.error()));

        await expect(signInWithDevice()).resolves.toEqual({ status: 'failed', reason: 'network' });
    });

    it('every failure logs ONE structured line, with no nonce or token in it (F4)', async () => {
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'super-secret-dev-token';
        await seed({ [KEY_SLOT]: 'stored-key', [PROVEN_SLOT]: 'stored-key' });
        server.use(http.post(SIGN_IN('ios'), () => rejection(400, 'DEVICE_ATTESTATION_FAILED')));

        await signInWithDevice();

        expect(log.warn).toHaveBeenCalledTimes(1);
        const [message, context] = log.warn.mock.calls[0];
        expect(message).toBe('[device-auth] sign-in failed');
        expect(context).toMatchObject({
            status: 'failed',
            reason: 'attestation-denied',
            path: '/device/sign-in/ios',
            httpStatus: 400,
            code: 'DEVICE_ATTESTATION_FAILED',
        });
        const [{ nonce }] = await bodiesTo('/device/sign-in/ios');
        const serialized = JSON.stringify(log.warn.mock.calls[0]);
        expect(serialized).not.toContain(nonce);
        expect(serialized).not.toContain('super-secret-dev-token');
    });

    it('a retry starts over with a FRESH nonce', async () => {
        // A proven key, so the 400 surfaces directly and two attempts are exactly two nonces.
        await seed({ [KEY_SLOT]: 'stored-key', [PROVEN_SLOT]: 'stored-key' });
        server.use(http.post(SIGN_IN('ios'), () => rejection(400, 'DEVICE_ATTESTATION_FAILED')));

        await signInWithDevice();
        await signInWithDevice();

        const hashes = mockAttest.generateAssertion.mock.calls.map(([, hash]) => hash);
        expect(hashes).toHaveLength(2);
        expect(hashes[0]).not.toEqual(hashes[1]);
        expect(countTo('/device/nonce')).toBe(2);
    });
});

describe('clearDeviceAuthCredentials (S10: deletion severs, logout preserves)', () => {
    const SLOTS = [KEY_SLOT, PROVEN_SLOT, DEVICE_ID_STORE_KEY, RETIRED_REF_SLOT];

    it('deletes the account credentials and any retired deviceRef leftover, and nothing else', async () => {
        await seed({ ...Object.fromEntries(SLOTS.map((k) => [k, 'x'])), [`${SLUG}_cookie`]: 'session' });

        await clearDeviceAuthCredentials();

        for (const slot of SLOTS) expect(dump()[slot]).toBeUndefined();
        expect(dump()[`${SLUG}_cookie`]).toBe('session');
    });

    it('is total: one failing delete does not stop the others, and it is logged by slot only', async () => {
        await seed(Object.fromEntries(SLOTS.map((k) => [k, 'x'])));
        failSecureStore(KEY_SLOT, 'delete', new Error('keychain locked'));

        await expect(clearDeviceAuthCredentials()).resolves.toBeUndefined();

        expect(dump()[KEY_SLOT]).toBe('x');
        for (const slot of SLOTS.filter((s) => s !== KEY_SLOT)) expect(dump()[slot]).toBeUndefined();
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledWith('[device-auth] could not clear a device credential', {
            slot: 'appattest_key_id',
            errorName: 'Error',
        });
    });
});
