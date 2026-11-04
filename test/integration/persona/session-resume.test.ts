// The silent resume of a dead session, at its seams: ReauthOnReturn, the real breaker, the real
// auth client and device sign-in over the mock backend, the real keychain fake and in-memory DB.
// The dev bypass is the attestation path, so no device edge is mocked.
import { renderHook, waitFor } from '@testing-library/react-native';
import Constants from 'expo-constants';
import { router, usePathname } from 'expo-router';
import ReauthOnReturn from '@/components/custom/auth/ReauthOnReturn';
import { _resetForTests as resetAuthBreaker } from '@/lib/auth-failure-breaker';
import { addFact, hasAnyFacts } from '@/lib/database/services/fact-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { DEVICE_ID_STORE_KEY } from '@/lib/device-auth';
import * as revenuecat from '@/lib/revenuecat';
import { __resetIdentityStateForTests, isAccountSwitchHeld } from '@/lib/security/identity-gate';
import { SESSION_RESUME_AT_KEY, resumeDeadSession, whenForeground } from '@/lib/session-resume';
import { usePinStore } from '@/lib/stores/pin-store';
import { useUserStore } from '@/lib/stores/user-store';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import {
    FIXTURE_ACCOUNT,
    HttpResponse,
    http,
    secureStoreDump,
    server,
    setAppState,
    signInFixtureAccount,
} from '@/test/helpers';

const ME = FIXTURE_ACCOUNT.userId;
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const COOKIE_KEY = `${Constants.expoConfig?.slug || 'app'}_cookie`;
const HOUR_MS = 60 * 60_000;
const REAUTH = { pathname: '/login', params: { reauth: '1' } };

const sessionUser = { id: OTHER, email: 'other@anon.mera.news', name: '', emailVerified: false };
const signInReply = (id: string, minted: boolean) =>
    new Response(JSON.stringify({ user: { ...sessionUser, id }, trialAvailable: false, minted }), {
        headers: {
            'content-type': 'application/json',
            'set-cookie': `better-auth.session_token=${id}.sig; Path=/; Max-Age=3600`,
        },
    });

/** The sign-in posts the app made. Each answers `reply`, or the default handler. */
function deviceSignIns(reply?: () => Response) {
    const bodies: Record<string, unknown>[] = [];
    server.use(
        http.post('*/api/auth/device/sign-in/dev', async ({ request }) => {
            bodies.push((await request.clone().json()) as Record<string, unknown>);
            return reply?.();
        }),
    );
    return bodies;
}

/** The server says dead until the sign-in has replaced the session, then alive (the default). */
function deadUntilResumed(bodies: unknown[]) {
    server.use(
        http.get('*/api/auth/get-session', ({ request }) =>
            new URL(request.url).searchParams.has('disableCookieCache') && bodies.length === 0
                ? HttpResponse.json(null)
                : undefined,
        ),
    );
}

const alwaysDead = () =>
    server.use(
        http.get('*/api/auth/get-session', ({ request }) =>
            new URL(request.url).searchParams.has('disableCookieCache') ? HttpResponse.json(null) : undefined,
        ),
    );

async function returnToApp(): Promise<void> {
    setAppState('background');
    setAppState('active');
    await new Promise((resolve) => setTimeout(resolve, 200));
}

const replaced = () => jest.mocked(router.replace).mock.calls;

beforeEach(async () => {
    process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
    resetAuthBreaker();
    __resetIdentityStateForTests();
    jest.mocked(router.replace).mockClear();
    jest.mocked(usePathname).mockReturnValue('/logged-in/app_container/world');
    usePinStore.setState({ locked: false });
    setAppState('active');
    await signInFixtureAccount();
    await setSetting('cached_user_id', ME);
    await addFact('Lives in Pune');
    useUserStore.setState({ needsReauth: true });
});

afterEach(() => {
    delete process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN;
});

describe('a bound key', () => {
    it('brings the session back in place: no gate, flag cleared, local data untouched', async () => {
        const acceptLegal: unknown[] = [];
        server.use(http.post('*/api/auth/accept-legal', () => void acceptLegal.push(1)));
        const posts = deviceSignIns();
        deadUntilResumed(posts);
        await renderHook(() => ReauthOnReturn());

        await returnToApp();

        await waitFor(() => expect(useUserStore.getState().needsReauth).toBe(false));
        expect(posts).toEqual([expect.objectContaining({ resumeOnly: true })]);
        expect(replaced()).toEqual([]);
        expect(await hasAnyFacts()).toBe(true);
        expect(await getSetting('cached_user_id')).toBe(ME);
        // The reader tapped nothing, so nothing was consented to.
        expect(acceptLegal).toEqual([]);
    });

    it('shows the gate when the session stays dead after the sign-in', async () => {
        const posts = deviceSignIns();
        alwaysDead();
        await renderHook(() => ReauthOnReturn());

        await returnToApp();

        await waitFor(() => expect(replaced()).toEqual([[REAUTH]]));
        expect(posts).toHaveLength(1);
        expect(useUserStore.getState().needsReauth).toBe(true);
    });
});

describe('a key that cannot resume', () => {
    it('409 DEVICE_NOT_BOUND shows the gate and changes nothing', async () => {
        const posts = deviceSignIns(() =>
            HttpResponse.json({ code: 'DEVICE_NOT_BOUND', message: 'x' }, { status: 409 }),
        );
        alwaysDead();
        const cookie = secureStoreDump()[COOKIE_KEY];
        await renderHook(() => ReauthOnReturn());

        await returnToApp();

        await waitFor(() => expect(replaced()).toEqual([[REAUTH]]));
        expect(posts).toHaveLength(1);
        expect(secureStoreDump()[COOKIE_KEY]).toBe(cookie);
        expect(await hasAnyFacts()).toBe(true);
    });

    it('a 403 refusal never severs the device or retries (no S10 recovery)', async () => {
        await secureStore.setItemAsync(DEVICE_ID_STORE_KEY, 'stored-device');
        const posts = deviceSignIns(() =>
            HttpResponse.json({ code: 'ACCOUNT_DELETED', message: 'x' }, { status: 403 }),
        );
        alwaysDead();
        await renderHook(() => ReauthOnReturn());

        await returnToApp();

        await waitFor(() => expect(replaced()).toEqual([[REAUTH]]));
        expect(posts).toHaveLength(1);
        expect(secureStoreDump()[DEVICE_ID_STORE_KEY]).toBe('stored-device');
    });
});

describe.each([
    ['a server older than the flag mints', () => signInReply(OTHER, true)],
    ['the key opens another account', () => signInReply(OTHER, false)],
])('%s', (_name, reply) => {
    it('fails, drops that session and keeps every local thing, with no store sync', async () => {
        const storeSync = jest.spyOn(revenuecat, 'requestStorePurchasesSync');
        const posts = deviceSignIns(reply);
        alwaysDead();
        await renderHook(() => ReauthOnReturn());

        await returnToApp();

        await waitFor(() => expect(replaced()).toEqual([[REAUTH]]));
        expect(posts).toHaveLength(1);
        expect(isAccountSwitchHeld(OTHER)).toBe(true);
        expect(secureStoreDump()[COOKIE_KEY] ?? '').not.toContain(`${OTHER}.sig`);
        expect(storeSync).not.toHaveBeenCalled();
        expect(await getSetting('cached_user_id')).toBe(ME);
        expect(await hasAnyFacts()).toBe(true);
        expect(useUserStore.getState().needsReauth).toBe(true);
        storeSync.mockRestore();
    });
});

it('minted: true is a failure on its own, whatever id it names', async () => {
    deviceSignIns(() => signInReply(ME, true));

    expect(await resumeDeadSession()).toBe(false);

    expect(secureStoreDump()[COOKIE_KEY]).toBeUndefined();
});

describe('when it must not run', () => {
    it('a locked app (the PIN rule) makes no device sign-in', async () => {
        usePinStore.setState({ locked: true });
        const posts = deviceSignIns();

        expect(await resumeDeadSession()).toBe(false);

        expect(posts).toEqual([]);
        expect(await getSetting(SESSION_RESUME_AT_KEY)).toBeNull();
    });

    it('a background wake makes no device sign-in', async () => {
        setAppState('background');
        const posts = deviceSignIns();

        expect(await resumeDeadSession()).toBe(false);

        expect(posts).toEqual([]);
    });

    it('a test account never resumes: its sign-in route would mint', async () => {
        process.env.EXPO_PUBLIC_TEST_ACCOUNT_TOKEN = 'test-token';
        const minted: unknown[] = [];
        server.use(http.post('*/api/auth/test-account/sign-in', () => void minted.push(1)));

        expect(await resumeDeadSession()).toBe(false);

        delete process.env.EXPO_PUBLIC_TEST_ACCOUNT_TOKEN;
        expect(minted).toEqual([]);
    });
});

describe('no loop', () => {
    it('concurrent verdicts share one attempt', async () => {
        const posts = deviceSignIns();
        deadUntilResumed(posts);

        const [a, b] = await Promise.all([resumeDeadSession(), resumeDeadSession()]);

        expect([a, b]).toEqual([true, true]);
        expect(posts).toHaveLength(1);
    });

    it('a failed attempt is not repeated inside the cooldown, across launches too', async () => {
        const posts = deviceSignIns(() =>
            HttpResponse.json({ code: 'DEVICE_NOT_BOUND', message: 'x' }, { status: 409 }),
        );

        expect(await resumeDeadSession()).toBe(false);
        expect(await resumeDeadSession()).toBe(false);
        expect(posts).toHaveLength(1);

        // The stamp is a settings row, which is what a relaunch reads.
        await setSetting(SESSION_RESUME_AT_KEY, String(Date.now() - HOUR_MS + 60_000));
        expect(await resumeDeadSession()).toBe(false);
        expect(posts).toHaveLength(1);

        await setSetting(SESSION_RESUME_AT_KEY, String(Date.now() - HOUR_MS - 1));
        expect(await resumeDeadSession()).toBe(false);
        expect(posts).toHaveLength(2);
    });

    it('a resume that does not hold spends the same attempt', async () => {
        const posts = deviceSignIns();
        alwaysDead();

        expect(await resumeDeadSession()).toBe(false);
        expect(await resumeDeadSession()).toBe(false);

        expect(posts).toHaveLength(1);
    });
});

describe('whenForeground', () => {
    it('resolves only once the reader is back', async () => {
        setAppState('background');
        let done = false;
        void whenForeground().then(() => {
            done = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(done).toBe(false);

        setAppState('active');
        await waitFor(() => expect(done).toBe(true));
    });
});
