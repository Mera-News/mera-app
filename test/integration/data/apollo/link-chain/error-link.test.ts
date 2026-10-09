// errorLink and authSuccessLink behind the real client: auth failures, the ownership 403 backstop,
// expected error codes, the sync-failed banner and the breaker reset.
import { _getBreakerState } from '@/lib/auth-failure-breaker';
import { authClient } from '@/lib/auth-client';
import { AppVersionService } from '@/lib/app-version-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { hasIdentityFault } from '@/lib/security/identity-gate';
import { waitFor } from '@testing-library/react-native';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import { HttpResponse, mockGql, mockGqlError, server, signInFixtureAccount } from '@/test/helpers';
import { client, crumbs, failureOf, PROBE, rawOp, recordRequests, resetLinkState, spyLogger } from './kit';

beforeEach(resetLinkState);

const probe = (context?: Record<string, unknown>) =>
    failureOf(client.query({ query: PROBE, fetchPolicy: 'no-cache', context }));
const banner = () => useForYouStore.getState().syncStatusMessage;
const failures = () => _getBreakerState().consecutiveFailures;

describe('UNAUTHENTICATED', () => {
    it.each([
        ['extensions.code', mockGqlError('LinkProbe', 'UNAUTHENTICATED')],
        ['extensions.statusCode 401', mockGqlError('LinkProbe', 'SOMETHING_ELSE', { statusCode: 401 })],
    ])('%s: a breadcrumb and one breaker failure, no capture, no retry, session kept', async (_shape, handler) => {
        await signInFixtureAccount();
        const logs = spyLogger();
        const seen = recordRequests();
        server.use(handler);

        const err = await probe();

        expect(err).toBeTruthy();
        expect(crumbs(logs.crumb)).toContain('GraphQL UNAUTHENTICATED');
        expect(failures()).toBe(1);
        expect(logs.capture).not.toHaveBeenCalled();
        expect(seen).toHaveLength(1);
        expect(authClient.getCookie()).toBeTruthy();
        expect(banner()).toBeNull();
    });

    it('a network 401: a breadcrumb and one breaker failure, no capture, no retry, session kept', async () => {
        await signInFixtureAccount();
        const logs = spyLogger();
        const seen = recordRequests();
        server.use(rawOp('LinkProbe', () => HttpResponse.text('no session', { status: 401 })));

        expect(await probe()).toBeTruthy();

        expect(crumbs(logs.crumb)).toContain('Network 401');
        expect(failures()).toBe(1);
        expect(logs.capture).not.toHaveBeenCalled();
        expect(seen).toHaveLength(1);
        expect(authClient.getCookie()).toBeTruthy();
    });
});

describe('ownership 403 backstop', () => {
    // Both writes are fire and forget: the fault marker the next cold start resolves before the
    // shell, and the needs-reauth row. Waiting keeps them from landing after the test ends.
    const persisted = () =>
        waitFor(async () => {
            expect(await hasIdentityFault()).toBe(true);
            expect(await getSetting('needs_reauth')).toBe('1');
        });

    const ownership = (message = 'Access denied: resource belongs to another user') =>
        mockGqlError('LinkProbe', 'FORBIDDEN', { message, statusCode: 403 });

    it('flips needs-reauth once, logs one identity-gate message, and stays quiet otherwise', async () => {
        const logs = spyLogger();
        const seen = recordRequests();
        server.use(ownership());

        expect(await probe()).toBeTruthy();

        expect(useUserStore.getState().needsReauth).toBe(true);
        await persisted();
        expect(logs.message).toHaveBeenCalledTimes(1);
        expect(logs.message.mock.calls[0][1]).toMatchObject({ tags: { source: 'identity-gate' } });
        expect(logs.capture).not.toHaveBeenCalled();
        expect(banner()).toBeNull();
        expect(seen).toHaveLength(1);
    });

    it('a second and third fault do not re-trigger the recovery flow', async () => {
        const logs = spyLogger();
        const seen = recordRequests();
        server.use(ownership());

        await probe();
        await probe();
        await probe();
        await persisted();

        expect(logs.message).toHaveBeenCalledTimes(1);
        expect(seen).toHaveLength(3);
    });

    it('leaves an unrelated FORBIDDEN on the generic path', async () => {
        const logs = spyLogger();
        server.use(ownership('Forbidden'));

        await probe();

        expect(logs.message).not.toHaveBeenCalled();
        expect(useUserStore.getState().needsReauth).toBe(false);
        expect(logs.capture).toHaveBeenCalledTimes(1);
        expect(banner()).toMatchObject({ state: 'failed', headlineKey: 'sync.syncFailed' });
    });
});

describe('expectedErrorCodes', () => {
    const expecting = { noSyncStatus: true, expectedErrorCodes: ['GRAPHQL_VALIDATION_FAILED'] };

    it('a listed code is a breadcrumb, not a capture, and the rejection still reaches the caller', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('LinkProbe', 'GRAPHQL_VALIDATION_FAILED'));

        const err = await probe(expecting);

        expect(err).toBeTruthy();
        expect(logs.capture).not.toHaveBeenCalled();
        expect(logs.crumb).toHaveBeenCalledWith(
            'GraphQL expected error',
            'apollo-error-link',
            { operationName: 'LinkProbe', errorCode: 'GRAPHQL_VALIDATION_FAILED' },
            'info',
        );
        expect(banner()).toBeNull();
    });

    it('a code the operation did not list is captured', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('LinkProbe', 'INTERNAL_SERVER_ERROR'));
        await probe(expecting);
        expect(logs.capture).toHaveBeenCalledTimes(1);
    });

    it('the same code on an operation that lists nothing is captured', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('LinkProbe', 'GRAPHQL_VALIDATION_FAILED'));
        await probe({ noSyncStatus: true });
        expect(logs.capture).toHaveBeenCalledTimes(1);
    });
});

describe('the sync-failed banner and noSyncStatus', () => {
    it('an ordinary operation paints the banner and is captured', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('LinkProbe', 'BAD_USER_INPUT'));
        await probe();
        expect(banner()).toMatchObject({ state: 'failed', headlineKey: 'sync.syncFailed' });
        expect(logs.capture).toHaveBeenCalledTimes(1);
    });

    it('noSyncStatus suppresses the banner but not the capture', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('LinkProbe', 'BAD_USER_INPUT'));
        await probe({ noSyncStatus: true });
        expect(banner()).toBeNull();
        expect(logs.capture).toHaveBeenCalledTimes(1);
    });

    it('the app-version check opts out of the banner and is still reported', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('AppVersionInfo', 'BAD_USER_INPUT'));
        await expect(AppVersionService.getVersionInfo()).rejects.toBeTruthy();
        expect(banner()).toBeNull();
        expect(logs.capture).toHaveBeenCalledTimes(1);
    });
});

describe('authSuccessLink', () => {
    it('an error-free result resets the breaker', async () => {
        server.use(mockGqlError('LinkProbe', 'UNAUTHENTICATED'));
        await probe();
        expect(failures()).toBe(1);

        server.use(mockGql('LinkProbe', { probe: 'ok' }));
        await client.query({ query: PROBE, fetchPolicy: 'no-cache' });

        expect(failures()).toBe(0);
    });

    it('a result carrying errors does not reset the breaker, but still proves the server answered', async () => {
        server.use(mockGqlError('LinkProbe', 'UNAUTHENTICATED'));
        await probe();
        useNetworkStore.setState({ serverReachable: false });

        server.use(mockGqlError('LinkProbe', 'BAD_USER_INPUT'));
        await probe({ noSyncStatus: true });

        expect(failures()).toBe(1);
        expect(useNetworkStore.getState().serverReachable).toBe(true);
    });
});
