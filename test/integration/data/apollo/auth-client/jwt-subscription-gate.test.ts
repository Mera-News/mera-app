// The `/token` subscription gate through the real client: a 403 SUBSCRIPTION_REQUIRED is terminal
// for the session, and nothing else is.
import { getJwtToken } from '@/lib/auth-client';
import { clearJwtSubscriptionLock, isJwtSubscriptionLocked } from '@/lib/subscription/jwt-subscription-gate';
import { server, signInFixtureAccount } from '@/test/helpers';
import { hits, recordAuth, resetAuthModuleState, spyLogger, subscriptionRequired, tokenUnauthorized } from './kit';

beforeEach(async () => {
    resetAuthModuleState();
    await signInFixtureAccount();
});

it('stops asking after a 403 SUBSCRIPTION_REQUIRED: no second /token and no second /get-session', async () => {
    server.use(subscriptionRequired());
    const seen = recordAuth();

    expect(await getJwtToken()).toBeNull();
    expect(await getJwtToken()).toBeNull();
    expect(await getJwtToken()).toBeNull();

    // One refusal, then silence: three calls, one round trip. The /get-session that tripped
    // better-auth's rate limiter is skipped too.
    expect(hits(seen, '/token')).toBe(1);
    expect(hits(seen, '/get-session')).toBe(1);
});

it('latches the refusal for the rest of the session', async () => {
    server.use(subscriptionRequired());
    expect(isJwtSubscriptionLocked()).toBe(false);
    await getJwtToken();
    expect(isJwtSubscriptionLocked()).toBe(true);
});

it('is not a fault: nothing goes to Sentry', async () => {
    server.use(subscriptionRequired());
    const logs = spyLogger();
    await getJwtToken();
    expect(logs.capture).not.toHaveBeenCalled();
});

// The regression guard that matters: too broad a predicate and a user whose session merely
// lapsed could never re-auth.
it('KEEPS RETRYING after a generic 401 (expired session)', async () => {
    server.use(tokenUnauthorized());
    const seen = recordAuth();

    expect(await getJwtToken()).toBeNull();
    expect(await getJwtToken()).toBeNull();

    expect(hits(seen, '/token')).toBe(2);
    expect(isJwtSubscriptionLocked()).toBe(false);
});

it('mints a real JWT again once the lock is lifted, with no restart', async () => {
    server.use(subscriptionRequired({ once: true }));
    expect(await getJwtToken()).toBeNull();
    expect(isJwtSubscriptionLocked()).toBe(true);

    // What a confirmed purchase does: the server reports a paid tier, which setServerBilling turns
    // into this call.
    clearJwtSubscriptionLock();

    expect(await getJwtToken()).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
});
