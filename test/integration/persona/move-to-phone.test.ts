// Seam test for the move to phone sign-in (components/custom/auth/move-to-phone.ts over
// lib/device-auth.ts convertWithDevice), the silent launch bind, and the store purchases sync that
// runs only after a mint or a move. Real auth client, settings, user store and RevenueCat wrapper
// over its SDK mock; the mock auth service answers /device/*, with /device/convert set per test.
// The only other mocks are the attestation SDK wrapper and ANDROID_ID (device edges).
import Purchases from 'react-native-purchases';
import { Platform } from 'react-native';
import {
    DEVICE_BOUND_SETTING_KEY,
    __resetMoveToPhoneForTests,
    bindPhoneOnce,
    emailSignInEnded,
    isEmailAccount,
    moveToPhone,
    type MoveStep,
} from '@/components/custom/auth/move-to-phone';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { signInWithDevice } from '@/lib/device-auth';
import logger from '@/lib/logger';
import { __resetStoreSyncForTests, configureRevenueCat, loginRevenueCat } from '@/lib/revenuecat';
import { useUserStore } from '@/lib/stores/user-store';
import { __resetDeviceAttestForTests } from '@/modules/mera-device-attest';
import { FIXTURE_ACCOUNT, HttpResponse, http, server, signInFixtureAccount } from '@/test/helpers';

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
const CONVERT = '*/api/auth/device/convert';
const EMAIL = FIXTURE_ACCOUNT.email;
const P = Purchases as unknown as Record<string, jest.Mock>;

// ─── What the app sent ───────────────────────────────────────────────────────

const sent: { path: string; body: Promise<any> }[] = [];
const onRequest = ({ request }: { request: Request }) => {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/api/auth/device/')) return;
    sent.push({ path: pathname.replace('/api/auth', ''), body: request.clone().json().catch(() => undefined) });
};
const bodiesTo = (path: string) => Promise.all(sent.filter((s) => s.path === path).map((s) => s.body));
const countTo = (path: string) => sent.filter((s) => s.path === path).length;

/** /device/convert answers, one per call in order; the last one repeats. */
function convertAnswers(...answers: (() => Response)[]) {
    let call = 0;
    server.use(http.post(CONVERT, () => answers[Math.min(call++, answers.length - 1)]()));
}
const ok = (status: string) => () => HttpResponse.json({ status, supportId: '1234567' });
const fail = (status: number, code: string) => () => HttpResponse.json({ code, message: code }, { status });

async function untilQuiet(check: () => boolean | Promise<boolean>, ms = 2000) {
    for (let spent = 0; spent < ms; spent += 20) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('condition never held');
}

function recordSteps() {
    const steps: MoveStep[] = [];
    return { steps, onStep: (s: MoveStep) => steps.push(s) };
}

beforeAll(() => {
    configureRevenueCat();
});

beforeEach(async () => {
    __resetMoveToPhoneForTests();
    __resetStoreSyncForTests();
    __resetDeviceAttestForTests();
    (Platform as { OS: string }).OS = 'ios';
    delete process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN;
    mockAttest.isSupported.mockReset().mockResolvedValue(true);
    mockAttest.generateKey.mockReset().mockResolvedValue('key-1');
    mockAttest.attestKey.mockReset().mockResolvedValue('attestation-b64');
    mockAttest.generateAssertion.mockReset().mockResolvedValue('assertion-b64');
    mockAttest.requestIntegrityToken.mockReset().mockResolvedValue('integrity-token');
    P.getAppUserID.mockResolvedValue(ME);

    // An email account, signed in, as the OTP flow leaves it.
    await signInFixtureAccount();
    await setSetting('cached_user_id', ME);
    await setSetting('cached_user_email', EMAIL);
    useUserStore.setState({ userId: ME, userEmail: EMAIL });

    sent.length = 0;
    server.events.on('request:start', onRequest);
});

afterEach(() => {
    server.events.removeListener('request:start', onRequest);
    (Platform as { OS: string }).OS = 'ios';
});

describe('moveToPhone', () => {
    it('converts with the same fields as the iOS sign-in, then forgets only the email', async () => {
        convertAnswers(ok('converted'));
        const { steps, onStep } = recordSteps();

        await expect(moveToPhone(onStep)).resolves.toEqual({ kind: 'moved' });

        expect(steps).toEqual(['checking', 'linking', 'removing', 'done']);
        const [body] = await bodiesTo('/device/convert');
        expect(body).toEqual({ platform: 'ios', keyId: 'key-1', assertion: 'assertion-b64', nonce: expect.any(String) });
        expect(countTo('/device/sign-in/ios')).toBe(0);
        await expect(getSetting('cached_user_email')).resolves.toBeNull();
        expect(useUserStore.getState().userEmail).toBeNull();
        // Same account: identity untouched, nothing wiped.
        await expect(getSetting('cached_user_id')).resolves.toBe(ME);
        expect(useUserStore.getState().userId).toBe(ME);
    });

    it('Android posts the Play Integrity fields with the platform named', async () => {
        (Platform as { OS: string }).OS = 'android';
        convertAnswers(ok('converted'));

        await expect(moveToPhone(() => {})).resolves.toEqual({ kind: 'moved' });

        const [body] = await bodiesTo('/device/convert');
        expect(body).toEqual({
            platform: 'android',
            integrityToken: 'integrity-token',
            nonce: expect.any(String),
            deviceId: 'android-hw-1',
        });
    });

    it('already-converted (done before, here or on another phone) cleans up the same way', async () => {
        convertAnswers(ok('already-converted'));

        await expect(moveToPhone(() => {})).resolves.toEqual({ kind: 'moved' });
        await expect(getSetting('cached_user_email')).resolves.toBeNull();
    });

    it('a failed convert changes nothing, and a retry with a fresh nonce succeeds', async () => {
        convertAnswers(fail(503, 'DEVICE_ATTESTATION_UNAVAILABLE'), ok('converted'));
        const first = recordSteps();

        await expect(moveToPhone(first.onStep)).resolves.toEqual({ kind: 'failed', step: 'linking' });
        expect(first.steps).toEqual(['checking', 'linking']);
        await expect(getSetting('cached_user_email')).resolves.toBe(EMAIL);
        expect(useUserStore.getState().userEmail).toBe(EMAIL);

        await expect(moveToPhone(() => {})).resolves.toEqual({ kind: 'moved' });
        const bodies = await bodiesTo('/device/convert');
        expect(bodies).toHaveLength(2);
        expect(bodies[0].nonce).not.toBe(bodies[1].nonce);
        await expect(getSetting('cached_user_email')).resolves.toBeNull();
    });

    it('a failed phone check stops at checking and never posts', async () => {
        mockAttest.generateAssertion.mockRejectedValue(Object.assign(new Error('x'), { code: 'ERR_ATTEST_SERVER_UNAVAILABLE' }));

        await expect(moveToPhone(() => {})).resolves.toEqual({ kind: 'failed', step: 'checking' });
        expect(countTo('/device/convert')).toBe(0);
        await expect(getSetting('cached_user_email')).resolves.toBe(EMAIL);
    });

    it('a server without the route yet (404) is a quiet temporary failure', async () => {
        convertAnswers(fail(404, 'NOT_FOUND'));

        await expect(moveToPhone(() => {})).resolves.toEqual({ kind: 'failed', step: 'linking' });
        await expect(getSetting('cached_user_email')).resolves.toBe(EMAIL);
    });

    // MERA-APP-90: the server answers 401 when the session died; the launch bind retries next launch.
    it('a dead session (401) is a quiet temporary failure, never a Sentry event', async () => {
        const captured = jest.spyOn(logger, 'captureMessage');
        convertAnswers(fail(401, 'UNAUTHORIZED'));

        await expect(moveToPhone(() => {})).resolves.toEqual({ kind: 'failed', step: 'linking' });
        expect(captured).not.toHaveBeenCalled();
        await expect(getSetting('cached_user_email')).resolves.toBe(EMAIL);
        captured.mockRestore();
    });

    it('a phone that cannot attest is unsupported, with no network and nothing changed', async () => {
        mockAttest.isSupported.mockResolvedValue(false);

        await expect(moveToPhone(() => {})).resolves.toEqual({ kind: 'unsupported' });
        expect(sent).toHaveLength(0);
        await expect(getSetting('cached_user_email')).resolves.toBe(EMAIL);
    });

    it('a dev build with the token converts through the dev fields', async () => {
        process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
        convertAnswers(ok('converted'));

        await expect(moveToPhone(() => {})).resolves.toEqual({ kind: 'moved' });
        const [body] = await bodiesTo('/device/convert');
        expect(body).toEqual({ platform: 'dev', token: 'dev-token', deviceId: expect.any(String) });
    });
});

describe('the store purchases sync: after a mint or a move, never on resume', () => {
    it('runs right after a move (RevenueCat already holds this account)', async () => {
        convertAnswers(ok('converted'));

        await moveToPhone(() => {});

        await untilQuiet(() => P.syncPurchases.mock.calls.length === 1);
    });

    it('a mint owes the new account a sync, run at its loginRevenueCat, once', async () => {
        P.getAppUserID.mockResolvedValue('$RCAnonymousID:previous');
        server.use(
            http.post('*/api/auth/device/sign-in/ios', () =>
                HttpResponse.json({ user: { id: ME }, minted: true, trialAvailable: false }),
            ),
        );

        await expect(signInWithDevice()).resolves.toMatchObject({ status: 'success', minted: true });
        await new Promise((r) => setTimeout(r, 50));
        // Never onto whoever RevenueCat still holds.
        expect(P.syncPurchases).not.toHaveBeenCalled();

        await loginRevenueCat(ME);
        await untilQuiet(() => P.syncPurchases.mock.calls.length === 1);

        // Owed once: the next launch's login (a resume) does not sync again.
        await loginRevenueCat(ME);
        await new Promise((r) => setTimeout(r, 50));
        expect(P.syncPurchases).toHaveBeenCalledTimes(1);
    });

    it('a resume (an existing account signing in again) never syncs', async () => {
        await expect(signInWithDevice()).resolves.toMatchObject({ status: 'success', minted: false });
        await loginRevenueCat(ME);
        await new Promise((r) => setTimeout(r, 50));
        expect(P.syncPurchases).not.toHaveBeenCalled();
    });
});

describe('the silent launch bind', () => {
    it('binds an email account once per device and account, without moving it', async () => {
        convertAnswers(ok('bound'));

        await bindPhoneOnce(ME);
        await bindPhoneOnce(ME);

        const bodies = await bodiesTo('/device/convert');
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatchObject({ platform: 'ios', bindOnly: true, keyId: 'key-1' });
        await expect(getSetting(DEVICE_BOUND_SETTING_KEY)).resolves.toBe(ME);
        await expect(getSetting('cached_user_email')).resolves.toBe(EMAIL);
        expect(P.syncPurchases).not.toHaveBeenCalled();
    });

    it('a failure records nothing, so the next launch tries again', async () => {
        convertAnswers(fail(503, 'DEVICE_ATTESTATION_UNAVAILABLE'), ok('already-bound'));

        await bindPhoneOnce(ME);
        await expect(getSetting(DEVICE_BOUND_SETTING_KEY)).resolves.toBeNull();

        await bindPhoneOnce(ME);
        await expect(getSetting(DEVICE_BOUND_SETTING_KEY)).resolves.toBe(ME);
        await expect(getSetting('cached_user_id')).resolves.toBe(ME);
    });

    it('skips a phone that cannot attest, with no network', async () => {
        mockAttest.isSupported.mockResolvedValue(false);

        await bindPhoneOnce(ME);

        expect(countTo('/device/convert')).toBe(0);
        await expect(getSetting(DEVICE_BOUND_SETTING_KEY)).resolves.toBeNull();
    });
});

describe('isEmailAccount and the cutoff', () => {
    it('reads the stored email first', async () => {
        await expect(isEmailAccount()).resolves.toBe(true);
    });

    it('a phone account (no stored email, placeholder on the session) is not one', async () => {
        await setSetting('cached_user_email', 'x@anon.mera.news');
        server.use(
            http.get('*/api/auth/get-session', () =>
                HttpResponse.json({ session: { id: 's', userId: ME }, user: { id: ME, email: 'x@anon.mera.news' } }),
            ),
        );
        await expect(isEmailAccount()).resolves.toBe(false);
    });

    it('email sign-in ends at local midnight on 30 October 2026', () => {
        expect(emailSignInEnded(new Date(2026, 9, 29, 23, 59).getTime())).toBe(false);
        expect(emailSignInEnded(new Date(2026, 9, 30, 0, 0).getTime())).toBe(true);
    });
});
