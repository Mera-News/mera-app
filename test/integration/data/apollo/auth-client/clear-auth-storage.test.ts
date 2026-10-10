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
// Taken at load, before any test installs the fake clock, which replaces process.hrtime.
const realHrtime = process.hrtime.bigint.bind(process.hrtime);

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
        // A session read that lands while the sign-out hangs rewrites the session-data key. It is real I/O,
        // which fake time does not pace: started here, and marked so the test can see it land.
        const stored = JSON.parse(secureStoreDump()[sessionKey]);
        server.use(
            http.post(SIGN_OUT, () => delay('infinite')),
            http.get('*/api/auth/get-session', () => HttpResponse.json({ ...stored, refetched: true })),
        );
        useFakeClock(Date.now());
        const startedAt = Date.now();

        void authClient.getSession();
        const clearing = clearAuthStorage();
        // Let the read land before the 5s is driven (real turns, no virtual time). Driven first, 5s of
        // fake time can pass before the response arrives on a loaded machine, and the late write then
        // lands after the wipe. Bounded by real time through the hrtime captured at load.
        const waitStart = realHrtime();
        const refetchLanded = () => secureStoreDump()[sessionKey]?.includes('refetched') === true;
        while (!refetchLanded() && realHrtime() - waitStart < 3_000_000_000n) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        expect(refetchLanded()).toBe(true);
        await advanceUntilDone(clearing);

        expect(authKeys(secureStoreDump())).toEqual({});
        const waited = Date.now() - startedAt;
        expect(waited).toBeGreaterThanOrEqual(5_000);
        expect(waited).toBeLessThan(6_000);
    });
});

// A session read that is still in flight when the user logs out (the client also starts one itself
// after a sign-out) writes its reply to the session-data key when it lands, so the signed-out account's
// id and email come back into the keychain after the local wipe.
describe('when a get-session reply lands late', () => {
    // Each hop (request, reply, keychain write) is real I/O that fake time does not pace, so the test
    // lets real turns pass for it and drives fake time only for the 5.5 s hold on the reply.
    const realTurns = async (turns: number, done: () => boolean = () => false) => {
        for (let i = 0; i < turns && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
    };

    beforeEach(() => {
        useFakeClock(Date.now());
    });

    async function logoutWithLateSessionReply(): Promise<string> {
        const sessionKey = authKeys(secureStoreDump()).session!;
        const stored = JSON.parse(secureStoreDump()[sessionKey]);
        let requested = false;
        let replied = false;
        server.use(
            http.get('*/api/auth/get-session', async () => {
                requested = true;
                await delay(5_500);
                replied = true;
                return HttpResponse.json(stored);
            }),
        );
        void authClient.getSession();
        await realTurns(20_000, () => requested);
        if (!requested) throw new Error('the session read never started');
        await advanceUntilDone(clearAuthStorage());
        expect(authKeys(secureStoreDump())).toEqual({});
        expect(replied).toBe(false);

        await jest.advanceTimersByTimeAsync(6_000);
        await realTurns(20_000, () => replied);
        if (!replied) throw new Error('the late reply never arrived');
        // The client writes the reply to the keychain a few turns after the response.
        await realTurns(2_000);
        return sessionKey;
    }

    test.failing('DA46: no session data is left in the keychain after logout, even when a get-session reply lands late', async () => {
        const sessionKey = await logoutWithLateSessionReply();
        const left = secureStoreDump()[sessionKey];
        expect(left === undefined || left === '{}').toBe(true);
    });

    it('DA46 today: a late get-session reply rewrites session data after the local wipe', async () => {
        const sessionKey = await logoutWithLateSessionReply();
        expect(JSON.parse(secureStoreDump()[sessionKey])).toEqual(expect.objectContaining({ user: expect.anything() }));
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
