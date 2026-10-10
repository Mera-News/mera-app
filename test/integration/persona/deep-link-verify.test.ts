// Seam test for useDeepLinkVerify, the logic behind the /verify-otp deep link. Real auth client,
// identity gate, stores and DB over MSW; the router is the integration setup's.
import { renderHook, waitFor } from '@testing-library/react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useDeepLinkVerify } from '@/components/custom/auth/useDeepLinkVerify';
import { wasLegalAcceptedThisProcess, __resetLegalConsentLatchForTests } from '@/components/custom/auth/legal-consent';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
    IDENTITY_FAULT_KEY,
    __resetIdentityStateForTests,
    hasIdentityFault,
    readPendingAuthUserId,
} from '@/lib/security/identity-gate';
import { __resetInstallBoundaryForTests } from '@/lib/security/install-boundary';
import { __resetAuthReadQuarantineForTests, releaseAuthReadQuarantine } from '@/lib/security/install-boundary-latch';
import { useUserStore } from '@/lib/stores/user-store';
import { FIXTURE_ACCOUNT, HttpResponse, http, secureStoreDump, server } from '@/test/helpers';
import { appConfig } from '@/test/mock-backend/fixtures/graphql/appConfig';

const SLUG = Constants.expoConfig?.slug || 'app';
const COOKIE_KEY = `${SLUG}_cookie`;
const SIGN_IN = '*/api/auth/sign-in/email-otp';
const ACCEPT_LEGAL = '*/api/auth/accept-legal';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const { email: EMAIL, otp: CODE, userId: ME } = FIXTURE_ACCOUNT;

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

const mount = (props: { otp?: string; email?: string }) => renderHook(() => useDeepLinkVerify(props));
const routed = () => waitFor(() => expect(replace()).toHaveBeenCalled());

beforeEach(() => {
    jest.clearAllMocks();
    __resetIdentityStateForTests();
    __resetLegalConsentLatchForTests();
    __resetAuthReadQuarantineForTests();
    __resetInstallBoundaryForTests();
    releaseAuthReadQuarantine();
    useUserStore.setState({ needsReauth: false });
});

describe('useDeepLinkVerify', () => {
    it.each([
        ['no code and no email', {}],
        ['a code without an email', { otp: CODE }],
        ['an email without a code', { email: EMAIL }],
    ])('%s goes to /login without calling the server', async (_label, props) => {
        const signIns = record(SIGN_IN);

        mount(props);
        await routed();

        expect(replace()).toHaveBeenCalledTimes(1);
        expect(replace()).toHaveBeenCalledWith('/login');
        expect(signIns).toEqual([]);
    });

    it('the fixture code with no cached account signs in, records the account and goes through the launch gate', async () => {
        // A sign-in that arrives while the app still shows the re-auth prompt and an identity fault.
        useUserStore.getState().setNeedsReauth(true);
        await setSetting(IDENTITY_FAULT_KEY, '1');
        const stamps = record(ACCEPT_LEGAL);

        mount({ otp: CODE, email: EMAIL });
        await routed();

        expect(replace()).toHaveBeenCalledWith('/logged-in');
        expect(readPendingAuthUserId()).toBe(ME);
        expect(secureStoreDump()[COOKIE_KEY]).toBeDefined();
        expect(useUserStore.getState().needsReauth).toBe(false);
        await waitFor(async () => {
            expect(await getSetting('cached_user_email')).toBe(EMAIL);
            expect(await hasIdentityFault()).toBe(false);
        });
        // Email users accepted at their original sign-up: the current versions are stamped silently.
        await waitFor(() => expect(stamps).toHaveLength(1));
        expect(stamps[0]).toEqual({ termsVersion: appConfig.termsVersion, privacyVersion: appConfig.privacyVersion });
        expect(wasLegalAcceptedThisProcess(ME)).toBe(true);
    });

    it('tries once: a re-render does not send the code again', async () => {
        const signIns = record(SIGN_IN);

        const hook = mount({ otp: CODE, email: EMAIL });
        await routed();
        hook.rerender({});

        expect(signIns).toHaveLength(1);
        expect(replace()).toHaveBeenCalledTimes(1);
    });

    it('a wrong code goes to /login and records nothing', async () => {
        mount({ otp: '000000', email: EMAIL });
        await routed();

        expect(replace()).toHaveBeenCalledWith('/login');
        expect(readPendingAuthUserId()).toBeNull();
        expect(secureStoreDump()[COOKIE_KEY]).toBeUndefined();
        expect(await getSetting('cached_user_email')).toBeNull();
    });

    it('a failed request goes to /login', async () => {
        server.use(http.post(SIGN_IN, () => HttpResponse.error()));

        mount({ otp: CODE, email: EMAIL });
        await routed();

        expect(replace()).toHaveBeenCalledTimes(1);
        expect(replace()).toHaveBeenCalledWith('/login');
        expect(readPendingAuthUserId()).toBeNull();
    });

    describe('a link for the fixture account on a device that holds ANOTHER account', () => {
        // The sign-in gate refuses a code for a different account (invariant 19); this doorway
        // uses the same refusal.
        const mountForeign = async () => {
            await setSetting('cached_user_id', OTHER);
            mount({ otp: CODE, email: EMAIL });
            await routed();
        };

        test('B3 a deep link for another account is refused like the sign-in gate does', async () => {
            await mountForeign();

            expect(replace()).not.toHaveBeenCalledWith('/logged-in/onboarding');
            expect(await getSetting('cached_user_id')).toBe(OTHER);
            expect(secureStoreDump()[COOKIE_KEY]).toBeUndefined();
        });
    });
});
