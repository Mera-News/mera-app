// Seam test for useAuthScreen, the sign-in screen's logic: which stage the local rows open on,
// the email track's hand-off, the "sign in with this phone" bookkeeping and its account-switch
// confirm, and Android Back on the gate. Real auth client, identity gate, stores and DB over MSW;
// the mocks are the attestation SDK wrapper and (through spies) BackHandler.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { BackHandler } from 'react-native';
import {
    __resetLegalConsentLatchForTests,
    wasLegalAcceptedThisProcess,
} from '@/components/custom/auth/legal-consent';
import { signInWithPhone, useAuthScreen, type DeviceSignInSuccess } from '@/components/custom/auth/useAuthScreen';
import * as settingService from '@/lib/database/services/setting-service';
import { __resetDeviceAttestForTests } from '@/modules/mera-device-attest';
import {
    IDENTITY_FAULT_KEY,
    __resetIdentityStateForTests,
    hasIdentityFault,
    isAccountSwitchHeld,
    readPendingAuthUserId,
} from '@/lib/security/identity-gate';
import { __resetInstallBoundaryForTests } from '@/lib/security/install-boundary';
import { __resetAuthReadQuarantineForTests, releaseAuthReadQuarantine } from '@/lib/security/install-boundary-latch';
import { useUserStore } from '@/lib/stores/user-store';
import {
    FIXTURE_ACCOUNT,
    HttpResponse,
    http,
    secureStoreDump,
    server,
    signInFixtureAccount,
    useFakeClock,
} from '@/test/helpers';
import { appConfig } from '@/test/mock-backend/fixtures/graphql/appConfig';

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

const SLUG = Constants.expoConfig?.slug || 'app';
const COOKIE_KEY = `${SLUG}_cookie`;
const ACCEPT_LEGAL = '*/api/auth/accept-legal';
const SIGN_OUT = '*/api/auth/sign-out';
const { email: EMAIL, userId: ME } = FIXTURE_ACCOUNT;
// The account this device holds in the "different account" cases; the mock server signs ME in.
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const INTRO_MS = 1200;

const replace = () => router.replace as jest.Mock;

/** Records the body of every request to `url` and lets the default handler answer. */
function record(url: string) {
    const bodies: Record<string, unknown>[] = [];
    server.use(
        http.post(url, async ({ request }) => {
            bodies.push((await request.clone().json().catch(() => ({}))) as Record<string, unknown>);
        }),
    );
    return bodies;
}

/** The staging dev bypass: unsupported hardware plus a configured token. */
function useDevBypass() {
    mockAttest.isSupported.mockResolvedValue(false);
    process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
}

const seedAccount = async (userId: string | null, email: string | null = null) => {
    if (userId) await settingService.setSetting('cached_user_id', userId);
    if (email) await settingService.setSetting('cached_user_email', email);
};

beforeEach(() => {
    jest.clearAllMocks();
    __resetIdentityStateForTests();
    __resetLegalConsentLatchForTests();
    __resetAuthReadQuarantineForTests();
    __resetInstallBoundaryForTests();
    __resetDeviceAttestForTests();
    releaseAuthReadQuarantine();
    delete process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN;
    mockAttest.isSupported.mockReset().mockResolvedValue(false);
    mockAttest.generateKey.mockReset().mockResolvedValue('key-1');
    mockAttest.attestKey.mockReset().mockResolvedValue('attestation-b64');
    mockAttest.generateAssertion.mockReset().mockResolvedValue('assertion-b64');
    mockAttest.requestIntegrityToken.mockReset().mockResolvedValue('integrity-token');
    useUserStore.setState({ needsReauth: false });
});

describe('the stage the gate opens on', () => {
    const open = (props: Parameters<typeof useAuthScreen>[0] = {}) => renderHook(() => useAuthScreen(props));

    it('no rows: loading, then the intro, then the welcome stage once the intro has held', async () => {
        useFakeClock(Date.now());
        const hook = open();
        expect(hook.result.current.stage).toBe('loading');

        for (let i = 0; i < 40 && hook.result.current.stage === 'loading'; i += 1) {
            await act(async () => {
                await jest.advanceTimersByTimeAsync(50);
            });
        }
        expect(hook.result.current.stage).toBe('intro');

        await act(async () => {
            await jest.advanceTimersByTimeAsync(INTRO_MS - 100);
        });
        expect(hook.result.current.stage).toBe('intro');
        await act(async () => {
            await jest.advanceTimersByTimeAsync(200);
        });
        expect(hook.result.current.stage).toBe('welcome');
    });

    it('a cached email and id open the re-auth gate on the email', async () => {
        await seedAccount(ME, EMAIL);
        await settingService.setSetting('cached_support_id', 'support-1');

        const hook = open();

        await waitFor(() => expect(hook.result.current.stage).toBe('reauth-email'));
        expect(hook.result.current).toMatchObject({ cachedEmail: EMAIL, cachedUserId: ME, supportId: 'support-1' });
    });

    it('an id without an email opens the no-email gate', async () => {
        await seedAccount(ME);

        const hook = open();

        await waitFor(() => expect(hook.result.current.stage).toBe('reauth-no-email'));
        expect(hook.result.current).toMatchObject({ cachedEmail: null, cachedUserId: ME });
    });

    it('an email without an id is not an account: the intro', async () => {
        await seedAccount(null, EMAIL);

        const hook = open();

        await waitFor(() => expect(hook.result.current.stage).toBe('intro'));
    });

    it('a failing settings read falls back to the intro', async () => {
        await seedAccount(ME, EMAIL);
        const read = jest.spyOn(settingService, 'getSetting').mockRejectedValueOnce(new Error('db unavailable'));

        const hook = open();

        await waitFor(() => expect(hook.result.current.stage).toBe('intro'));
        read.mockRestore();
    });

    // PE23: the device checks load independently of the settings reads, so a single rejected read
    // still offers the phone account's sign-in.
    describe('PE23 a failed settings read on an id-only account', () => {
        beforeEach(useDevBypass);

        const failOneRead = async () => {
            await seedAccount(ME);
            const read = jest.spyOn(settingService, 'getSetting').mockRejectedValueOnce(new Error('db unavailable'));
            const hook = open();
            await waitFor(() => expect(hook.result.current.stage).toBe('intro'));
            // Let the device checks settle too: the dev bypass answers within a few ticks.
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
            });
            read.mockRestore();
            return hook;
        };

        test('PE23 a failed settings read still offers sign-in without email', async () => {
            const hook = await failOneRead();

            expect(hook.result.current).toMatchObject({ availability: 'dev-bypass', canSignInWithoutEmail: true });
        });
    });

    it('offers phone sign-in only where the device can attest, and never on Forgot PIN', async () => {
        useDevBypass();
        const offered = open();
        await waitFor(() => expect(offered.result.current.availability).toBe('dev-bypass'));
        expect(offered.result.current).toMatchObject({ signInPath: 'dev-bypass', canSignInWithoutEmail: true });

        const forgotPin = open({ allowDeviceSignIn: false });
        await waitFor(() => expect(forgotPin.result.current.availability).toBe('dev-bypass'));
        expect(forgotPin.result.current.canSignInWithoutEmail).toBe(false);
    });

    it('a device that cannot attest offers the email path only', async () => {
        const hook = open();

        await waitFor(() => expect(hook.result.current.stage).not.toBe('loading'));
        expect(hook.result.current).toMatchObject({ availability: 'unavailable', canSignInWithoutEmail: false });
    });
});

describe('the email track', () => {
    it('handleVerificationSuccess stamps the current legal versions and calls onLoginSuccess', async () => {
        await signInFixtureAccount();
        const stamps = record(ACCEPT_LEGAL);
        const onLoginSuccess = jest.fn();
        const hook = renderHook(() => useAuthScreen({ onLoginSuccess }));
        act(() => hook.result.current.setPendingEmail('someone@example.com'));
        expect(hook.result.current.pendingEmail).toBe('someone@example.com');

        act(() => hook.result.current.handleVerificationSuccess(ME));

        expect(onLoginSuccess).toHaveBeenCalledWith(ME);
        expect(hook.result.current.pendingEmail).toBe('');
        expect(wasLegalAcceptedThisProcess(ME)).toBe(true);
        await waitFor(() => expect(stamps).toHaveLength(1));
        expect(stamps[0]).toEqual({ termsVersion: appConfig.termsVersion, privacyVersion: appConfig.privacyVersion });
    });
});

describe('signing in with this phone', () => {
    beforeEach(useDevBypass);

    it('the same account is signed in and booked: recorded, re-auth and fault cleared, consent latched and stamped', async () => {
        await seedAccount(ME, EMAIL);
        useUserStore.getState().setNeedsReauth(true);
        await settingService.setSetting(IDENTITY_FAULT_KEY, '1');
        const stamps = record(ACCEPT_LEGAL);

        const outcome = await signInWithPhone(ME);

        expect(outcome).toMatchObject({ kind: 'signed-in', result: { status: 'success', userId: ME } });
        expect(readPendingAuthUserId()).toBe(ME);
        expect(useUserStore.getState().needsReauth).toBe(false);
        await waitFor(async () => expect(await hasIdentityFault()).toBe(false));
        expect(wasLegalAcceptedThisProcess(ME)).toBe(true);
        expect(stamps).toEqual([{ termsVersion: appConfig.termsVersion, privacyVersion: appConfig.privacyVersion }]);
        expect(secureStoreDump()[COOKIE_KEY]).toBeDefined();
    });

    it('with no account on the device (the track) the phone account is simply signed in', async () => {
        const outcome = await signInWithPhone(null);

        expect(outcome).toMatchObject({ kind: 'signed-in', result: { userId: ME } });
        expect(readPendingAuthUserId()).toBe(ME);
    });

    describe('a phone that opens a DIFFERENT account than the one on this device', () => {
        /** Signs in as the phone's account (ME) while the device holds OTHER; nothing may be booked. */
        async function signInOverOther() {
            await seedAccount(OTHER, 'other@example.com');
            useUserStore.getState().setNeedsReauth(true);
            await settingService.setSetting(IDENTITY_FAULT_KEY, '1');
            const stamps = record(ACCEPT_LEGAL);
            const outcome = await signInWithPhone(OTHER);
            return { outcome, stamps };
        }

        it('is reported as different and records NOTHING', async () => {
            const { outcome, stamps } = await signInOverOther();

            expect(outcome).toMatchObject({ kind: 'different', result: { status: 'success', userId: ME } });
            expect(readPendingAuthUserId()).toBeNull();
            expect(useUserStore.getState().needsReauth).toBe(true);
            expect(await hasIdentityFault()).toBe(true);
            expect(wasLegalAcceptedThisProcess(ME)).toBe(false);
            expect(stamps).toEqual([]);
            // The sign-in itself already set the phone account's cookie, which is why the hold exists.
            expect(secureStoreDump()[COOKIE_KEY]).toBeDefined();
        });

        it('askSwitch holds the account at once, and the confirm is pending', async () => {
            const { outcome } = await signInOverOther();
            const hook = renderHook(() => useAuthScreen({}));

            act(() => hook.result.current.askSwitch((outcome as { result: DeviceSignInSuccess }).result));

            expect(isAccountSwitchHeld(ME)).toBe(true);
            expect(hook.result.current.pendingSwitch).toMatchObject({ userId: ME });
        });

        it('Keep (handleSwitchKeep) signs the phone account out: cookie gone, no pending switch, nothing recorded', async () => {
            useFakeClock(Date.now());
            const { outcome } = await signInOverOther();
            let signOuts = 0;
            server.use(
                http.post(SIGN_OUT, () => {
                    signOuts += 1;
                }),
            );
            const hook = renderHook(() => useAuthScreen({}));
            act(() => hook.result.current.askSwitch((outcome as { result: DeviceSignInSuccess }).result));
            expect(secureStoreDump()[COOKIE_KEY]).toBeDefined();

            await act(async () => {
                await hook.result.current.handleSwitchKeep();
            });

            expect(secureStoreDump()[COOKIE_KEY]).toBeUndefined();
            expect(hook.result.current.pendingSwitch).toBeNull();
            expect(signOuts).toBe(1);
            expect(readPendingAuthUserId()).toBeNull();
            // Held for the process: a stale read of the declined account must never act.
            expect(isAccountSwitchHeld(ME)).toBe(true);
        });

        it('Continue (handleSwitchContinue) releases the hold, books the account and hands over to onLoginSuccess', async () => {
            const { outcome, stamps } = await signInOverOther();
            const onLoginSuccess = jest.fn();
            const hook = renderHook(() => useAuthScreen({ onLoginSuccess }));
            act(() => hook.result.current.askSwitch((outcome as { result: DeviceSignInSuccess }).result));

            await act(async () => {
                await hook.result.current.handleSwitchContinue();
            });

            expect(isAccountSwitchHeld(ME)).toBe(false);
            expect(readPendingAuthUserId()).toBe(ME);
            expect(useUserStore.getState().needsReauth).toBe(false);
            await waitFor(async () => expect(await hasIdentityFault()).toBe(false));
            expect(wasLegalAcceptedThisProcess(ME)).toBe(true);
            expect(stamps).toHaveLength(1);
            expect(onLoginSuccess).toHaveBeenCalledWith(ME);
            expect(replace()).not.toHaveBeenCalled();
        });

        it('Continue without an onLoginSuccess routes to /logged-in', async () => {
            const { outcome } = await signInOverOther();
            const hook = renderHook(() => useAuthScreen({}));
            act(() => hook.result.current.askSwitch((outcome as { result: DeviceSignInSuccess }).result));

            await act(async () => {
                await hook.result.current.handleSwitchContinue();
            });

            expect(replace()).toHaveBeenCalledWith('/logged-in');
            expect(readPendingAuthUserId()).toBe(ME);
        });

        it('Continue with nothing pending does nothing', async () => {
            const hook = renderHook(() => useAuthScreen({}));

            await act(async () => {
                await hook.result.current.handleSwitchContinue();
            });

            expect(readPendingAuthUserId()).toBeNull();
            expect(replace()).not.toHaveBeenCalled();
        });
    });

    describe('outcomes that sign nobody in', () => {
        it('a device that cannot attest and has no dev token is unsupported', async () => {
            delete process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN;

            await expect(signInWithPhone(ME)).resolves.toEqual({ kind: 'unsupported' });
            expect(readPendingAuthUserId()).toBeNull();
        });

        it('native attestation that reports the platform unsupported maps to unsupported', async () => {
            // Native path: in a dev build the token would win over attestation.
            delete process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN;
            mockAttest.isSupported.mockResolvedValue(true);
            mockAttest.generateKey.mockRejectedValue(Object.assign(new Error('no'), { code: 'ERR_ATTEST_UNSUPPORTED' }));

            await expect(signInWithPhone(ME)).resolves.toEqual({ kind: 'unsupported' });
        });

        it('native attestation that fails maps to failed with the reason', async () => {
            // Native path: in a dev build the token would win over attestation.
            delete process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN;
            mockAttest.isSupported.mockResolvedValue(true);
            mockAttest.attestKey.mockRejectedValue(
                Object.assign(new Error('apple'), { code: 'ERR_ATTEST_SERVER_UNAVAILABLE' }),
            );

            await expect(signInWithPhone(ME)).resolves.toEqual({ kind: 'failed', reason: 'attestation-unavailable' });
            expect(readPendingAuthUserId()).toBeNull();
            expect(wasLegalAcceptedThisProcess(ME)).toBe(false);
        });

        it('a server that refuses the device maps to failed attestation-denied', async () => {
            server.use(
                http.post('*/api/auth/device/sign-in/dev', () =>
                    HttpResponse.json({ code: 'DEVICE_ATTESTATION_FAILED' }, { status: 400 }),
                ),
            );

            await expect(signInWithPhone(ME)).resolves.toEqual({ kind: 'failed', reason: 'attestation-denied' });
            expect(readPendingAuthUserId()).toBeNull();
        });
    });
});

describe('Android Back on the gate', () => {
    type Handler = () => boolean | null | undefined;
    const handlers: Handler[] = [];
    let removed = 0;
    let addListener: jest.SpyInstance;
    let exitApp: jest.SpyInstance;

    beforeEach(() => {
        handlers.length = 0;
        removed = 0;
        addListener = jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_event: string, handler: Handler) => {
            handlers.push(handler);
            return { remove: () => (removed += 1) };
        }) as never);
        exitApp = jest.spyOn(BackHandler, 'exitApp').mockImplementation(() => {});
    });

    afterEach(() => {
        addListener.mockRestore();
        exitApp.mockRestore();
    });

    /** The handler the hook registered last; presses it inside act. */
    const pressBack = () => {
        let handled: boolean | null | undefined;
        act(() => {
            handled = handlers[handlers.length - 1]();
        });
        return handled;
    };

    it('steps back from the code to the email and from the other-email step to the mismatch', async () => {
        await seedAccount(ME, EMAIL);
        const hook = renderHook(() => useAuthScreen({}));
        await waitFor(() => expect(hook.result.current.stage).toBe('reauth-email'));

        act(() => hook.result.current.go('reauth-otp'));
        expect(pressBack()).toBe(true);
        expect(hook.result.current.stage).toBe('reauth-email');

        act(() => hook.result.current.go('reauth-other-email'));
        expect(pressBack()).toBe(true);
        expect(hook.result.current.stage).toBe('reauth-mismatch');

        expect(pressBack()).toBe(true);
        expect(hook.result.current.stage).toBe('reauth-email');
        expect(exitApp).not.toHaveBeenCalled();
    });

    it('an account without an email steps back to the no-email gate', async () => {
        await seedAccount(ME);
        const hook = renderHook(() => useAuthScreen({}));
        await waitFor(() => expect(hook.result.current.stage).toBe('reauth-no-email'));

        act(() => hook.result.current.go('reauth-mismatch'));
        expect(pressBack()).toBe(true);

        expect(hook.result.current.stage).toBe('reauth-no-email');
    });

    it('leaves the app from the gate itself, where there is nothing behind it', async () => {
        await seedAccount(ME, EMAIL);
        const hook = renderHook(() => useAuthScreen({}));
        await waitFor(() => expect(hook.result.current.stage).toBe('reauth-email'));

        expect(pressBack()).toBe(true);

        expect(exitApp).toHaveBeenCalledTimes(1);
        expect(hook.result.current.stage).toBe('reauth-email');
    });

    it('registers nothing outside the gate, and drops its listener on the way out', async () => {
        const hook = renderHook(() => useAuthScreen({}));
        await waitFor(() => expect(hook.result.current.stage).toBe('intro'));
        expect(handlers).toHaveLength(0);

        await seedAccount(ME, EMAIL);
        const gate = renderHook(() => useAuthScreen({}));
        await waitFor(() => expect(gate.result.current.stage).toBe('reauth-email'));
        const registered = handlers.length;
        gate.unmount();

        expect(removed).toBe(registered);
    });
});
