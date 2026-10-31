// Seam test for the silent launch bind (components/custom/auth/bind-phone.ts over
// lib/device-auth.ts convertWithDevice) and the store purchases sync that runs only after a mint. Real auth client, settings, user store and RevenueCat wrapper
// over its SDK mock; the mock auth service answers /device/*, with /device/convert set per test.
// The only other mocks are the attestation SDK wrapper and ANDROID_ID (device edges).
import Purchases from 'react-native-purchases';
import { Platform } from 'react-native';
import { DEVICE_BOUND_SETTING_KEY, __resetBindPhoneForTests, bindPhoneOnce } from '@/components/custom/auth/bind-phone';
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

beforeAll(() => {
    configureRevenueCat();
});

beforeEach(async () => {
    __resetBindPhoneForTests();
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

    // A former email account, signed in, as the OTP flow left it (the row is all that marks it).
    await signInFixtureAccount();
    await setSetting('cached_user_id', ME);
    await setSetting('cached_user_email', EMAIL);
    useUserStore.setState({ userId: ME });

    sent.length = 0;
    server.events.on('request:start', onRequest);
});

afterEach(() => {
    server.events.removeListener('request:start', onRequest);
    (Platform as { OS: string }).OS = 'ios';
});

describe('the store purchases sync: after a mint, never on resume', () => {
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
    it('binds a former email account once per device and account, without moving it', async () => {
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

    // MERA-APP-90: the server answers 401 when the session died; the launch bind retries next launch.
    it('a dead session (401) is a quiet temporary failure, never a Sentry event', async () => {
        const captured = jest.spyOn(logger, 'captureMessage');
        convertAnswers(fail(401, 'UNAUTHORIZED'));

        await bindPhoneOnce(ME);

        expect(captured).not.toHaveBeenCalled();
        await expect(getSetting(DEVICE_BOUND_SETTING_KEY)).resolves.toBeNull();
        captured.mockRestore();
    });

    it('skips a phone account (no email row), with no network', async () => {
        await setSetting('cached_user_email', 'x@anon.mera.news');

        await bindPhoneOnce(ME);

        expect(countTo('/device/convert')).toBe(0);
        await expect(getSetting(DEVICE_BOUND_SETTING_KEY)).resolves.toBeNull();
    });

    it('skips a phone that cannot attest, with no network', async () => {
        mockAttest.isSupported.mockResolvedValue(false);

        await bindPhoneOnce(ME);

        expect(countTo('/device/convert')).toBe(0);
        await expect(getSetting(DEVICE_BOUND_SETTING_KEY)).resolves.toBeNull();
    });
});
