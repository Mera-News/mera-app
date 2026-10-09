// getJwtToken and invalidateJwtCache through the real better-auth client against the mock auth
// backend: the 30s cache, the dedupe, and every failure shape of `/get-session` and `/token`.
import { getJwtToken, invalidateJwtCache } from '@/lib/auth-client';
import {
    HttpResponse,
    http,
    server,
    signInFixtureAccount,
    useFakeClock,
} from '@/test/helpers';
import { hits, recordAuth, resetAuthModuleState, spyLogger } from './kit';

beforeEach(resetAuthModuleState);

const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const TTL_MS = 30_000;

// First in the file: the auth client keeps its session state for the whole file, so the
// signed-out case must run before any test signs in.
it('returns null without a session, and never asks for a token', async () => {
    const seen = recordAuth();
    expect(await getJwtToken()).toBeNull();
    expect(hits(seen, '/get-session')).toBe(1);
    expect(hits(seen, '/token')).toBe(0);
});

it('returns the token after sign-in', async () => {
    await signInFixtureAccount();
    expect(await getJwtToken()).toMatch(JWT_SHAPE);
});

describe('cache', () => {
    it('serves the cached token inside the TTL with no request at all, and re-fetches after it', async () => {
        await signInFixtureAccount();
        useFakeClock(Date.now());
        const seen = recordAuth();

        const first = await getJwtToken();
        expect(await getJwtToken()).toBe(first);
        expect(hits(seen, '/token')).toBe(1);
        expect(hits(seen, '/get-session')).toBe(1);

        await jest.advanceTimersByTimeAsync(TTL_MS - 1_000);
        expect(await getJwtToken()).toBe(first);
        expect(hits(seen, '/token')).toBe(1);

        await jest.advanceTimersByTimeAsync(2_000);
        expect(await getJwtToken()).toMatch(JWT_SHAPE);
        expect(hits(seen, '/token')).toBe(2);
        expect(hits(seen, '/get-session')).toBe(2);
    });

    it('invalidateJwtCache forces a fresh request on the next call', async () => {
        await signInFixtureAccount();
        const seen = recordAuth();
        await getJwtToken();
        invalidateJwtCache();
        await getJwtToken();
        expect(hits(seen, '/token')).toBe(2);
        expect(hits(seen, '/get-session')).toBe(2);
    });
});

it('dedupes concurrent calls to one session check and one token request', async () => {
    await signInFixtureAccount();
    const seen = recordAuth();
    const [a, b, c] = await Promise.all([getJwtToken(), getJwtToken(), getJwtToken()]);
    expect(a).toMatch(JWT_SHAPE);
    expect([b, c]).toEqual([a, a]);
    expect(hits(seen, '/token')).toBe(1);
    expect(hits(seen, '/get-session')).toBe(1);
});

describe('failures', () => {
    it('returns null on an error response from /token and asks again next time (nothing cached)', async () => {
        await signInFixtureAccount();
        server.use(
            http.get('*/api/auth/token', () => HttpResponse.json({ code: 'BAD', message: 'broken' }, { status: 500 })),
        );
        const seen = recordAuth();
        const logs = spyLogger();
        expect(await getJwtToken()).toBeNull();
        expect(await getJwtToken()).toBeNull();
        expect(hits(seen, '/token')).toBe(2);
        expect(logs.capture).not.toHaveBeenCalled();
    });

    it('returns null when /token answers 200 without a token', async () => {
        await signInFixtureAccount();
        server.use(http.get('*/api/auth/token', () => HttpResponse.json({})));
        expect(await getJwtToken()).toBeNull();
    });

    it('returns null and captures once when /get-session throws (a transport failure)', async () => {
        await signInFixtureAccount();
        server.use(http.get('*/api/auth/get-session', () => HttpResponse.error()));
        const logs = spyLogger();
        expect(await getJwtToken()).toBeNull();
        expect(logs.capture).toHaveBeenCalledTimes(1);
        expect(logs.capture).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({ tags: { service: 'auth-client', method: 'getJwtToken' } }),
        );
    });

    it('returns null and captures once when /token throws (a transport failure)', async () => {
        await signInFixtureAccount();
        server.use(http.get('*/api/auth/token', () => HttpResponse.error()));
        const logs = spyLogger();
        expect(await getJwtToken()).toBeNull();
        expect(logs.capture).toHaveBeenCalledTimes(1);
    });
});
