// authLink: the session cookie and the client header on every GraphQL request.
import { authClient } from '@/lib/auth-client';
import { clientHeaderValue } from '@/lib/observability/client-header';
import { failSecureStore, mockGql, secureStoreDump, server, signInFixtureAccount } from '@/test/helpers';
import { client, PROBE, recordRequests, resetLinkState } from './kit';

beforeEach(resetLinkState);

const send = () => client.query({ query: PROBE, fetchPolicy: 'no-cache' });

it('sends the real auth client\'s cookie after sign-in', async () => {
    await signInFixtureAccount();
    const seen = recordRequests();
    server.use(mockGql('LinkProbe', { probe: 'ok' }));

    await send();

    const cookie = authClient.getCookie();
    expect(cookie).toBeTruthy();
    expect(seen[0].headers.get('cookie')).toBe(cookie);
});

it('sends no cookie when signed out', async () => {
    const seen = recordRequests();
    server.use(mockGql('LinkProbe', { probe: 'ok' }));

    await send();

    expect(seen[0].headers.get('cookie')).toBeNull();
});

it('goes out without a cookie, and does not fail, when the keychain read throws', async () => {
    await signInFixtureAccount();
    expect(authClient.getCookie()).toBeTruthy();
    const keys = Object.keys(secureStoreDump());
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) failSecureStore(key, 'get');
    // The fault is live: the read the link makes no longer hands back the cookie. (The secure
    // store adapter already turns the throw into null, so authLink's own catch is a second layer.)
    expect(authClient.getCookie()).toBeFalsy();
    const seen = recordRequests();
    server.use(mockGql('LinkProbe', { probe: 'ok' }));

    const result = await send();

    expect(result.data).toEqual({ probe: 'ok' });
    expect(seen[0].headers.get('cookie')).toBeNull();
});

it('sends the x-mera-client header the build context produced', async () => {
    const seen = recordRequests();
    server.use(mockGql('LinkProbe', { probe: 'ok' }));

    await send();

    // Non-vacuous: the integration build context yields a value, so the header must be present.
    expect(clientHeaderValue).toMatch(/^[a-z]+\/.+\+.+ rt\/.+$/);
    expect(seen[0].headers.get('x-mera-client')).toBe(clientHeaderValue);
});
