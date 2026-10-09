// clearAuthStorage through the real client: the server sign-out is guarded and bounded, and the
// local wipe happens whatever the network does.
import { authClient, clearAuthStorage, getJwtToken } from '@/lib/auth-client';
import { isJwtSubscriptionLocked } from '@/lib/subscription/jwt-subscription-gate';
import {
    advanceUntilDone,
    delay,
    failSecureStore,
    http,
    HttpResponse,
    secureStoreDump,
    server,
    signInFixtureAccount,
    useFakeClock,
} from '@/test/helpers';
import { authKeys, hits, recordAuth, resetAuthModuleState, subscriptionRequired } from './kit';

const SIGN_OUT = '*/api/auth/sign-out';

beforeEach(async () => {
    resetAuthModuleState();
    await signInFixtureAccount();
    // The expo client writes the session-data key on the first session read after sign-in.
    await authClient.getSession();
});

it('sends the server sign-out, with the session cookie', async () => {
    const seen = recordAuth();
    await clearAuthStorage();
    const signOuts = seen.filter((r) => r.path === '/sign-out');
    expect(signOuts).toHaveLength(1);
    expect(signOuts[0].cookie).toContain('better-auth.session_token=');
});

it('deletes the cookie and session-data keys from the secure store', async () => {
    const before = authKeys(secureStoreDump());
    expect(before.cookie).toBeDefined();
    expect(before.session).toBeDefined();

    await clearAuthStorage();

    expect(authKeys(secureStoreDump())).toEqual({});
});

it('invalidates the JWT cache: the next call starts from the session check and finds none', async () => {
    expect(await getJwtToken()).toEqual(expect.any(String));
    await clearAuthStorage();

    const seen = recordAuth();
    expect(await getJwtToken()).toBeNull();
    expect(hits(seen, '/get-session')).toBe(1);
    expect(hits(seen, '/token')).toBe(0);
});

it('lifts the subscription latch: the refusal belonged to the user who just left', async () => {
    server.use(subscriptionRequired());
    await getJwtToken();
    expect(isJwtSubscriptionLocked()).toBe(true);

    await clearAuthStorage();

    expect(isJwtSubscriptionLocked()).toBe(false);
});

// The user pressed the button: local state clears regardless of network, the inverse of the
// never-silent-logout invariant. A server outage must not leave the device signed in.
describe('when the server sign-out fails', () => {
    it('still wipes the keys when the request is rejected', async () => {
        server.use(http.post(SIGN_OUT, () => HttpResponse.error()));
        await expect(clearAuthStorage()).resolves.toBeUndefined();
        expect(authKeys(secureStoreDump())).toEqual({});
    });

    it('still wipes the keys when the server answers 500', async () => {
        server.use(http.post(SIGN_OUT, () => new HttpResponse(null, { status: 500 })));
        await expect(clearAuthStorage()).resolves.toBeUndefined();
        expect(authKeys(secureStoreDump())).toEqual({});
    });

    it('does not wait forever on a HANGING sign-out: the local wipe is bounded at 5s', async () => {
        const sessionKey = authKeys(secureStoreDump()).session!;
        // Starting the sign-out makes the client refetch the session, and that response rewrites the
        // session-data key. The refetch is real I/O, which fake time does not pace: marked here so the
        // test can see it land.
        const stored = JSON.parse(secureStoreDump()[sessionKey]);
        server.use(
            http.post(SIGN_OUT, () => delay('infinite')),
            http.get('*/api/auth/get-session', () => HttpResponse.json({ ...stored, refetched: true })),
        );
        useFakeClock(Date.now());
        const startedAt = Date.now();

        const clearing = clearAuthStorage();
        // Let the refetch land before the 5s is driven (real turns, no virtual time). Driven first, 5s
        // of fake time can pass before the response arrives on a loaded machine, and the late write
        // then lands after the wipe.
        for (let turns = 0; !secureStoreDump()[sessionKey]?.includes('refetched'); turns++) {
            if (turns > 20_000) throw new Error('the session refetch never landed');
            await new Promise((resolve) => setImmediate(resolve));
        }
        await advanceUntilDone(clearing);

        expect(authKeys(secureStoreDump())).toEqual({});
        const waited = Date.now() - startedAt;
        expect(waited).toBeGreaterThanOrEqual(5_000);
        expect(waited).toBeLessThan(6_000);
    });
});

describe('when a secure-store delete fails', () => {
    it('does not throw, and still deletes the other key', async () => {
        const { cookie, session } = authKeys(secureStoreDump());
        failSecureStore(cookie!, 'delete');

        await expect(clearAuthStorage()).resolves.toBeUndefined();

        const left = authKeys(secureStoreDump());
        expect(left.cookie).toBe(cookie);
        expect(left.session).toBeUndefined();
        expect(session).toBeDefined();
    });
});
