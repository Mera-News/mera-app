// apollo-client.ts transitively imports lib/stores/for-you-store → the
// WatermelonDB singleton (lib/database/index.ts), which instantiates a native
// SQLiteAdapter at import time. Mock the DB seam so the module can be
// imported under Jest — same pattern as the database-service test suites
// (see lib/__test-helpers__/mockDatabase.ts).
jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import client, { parseRetryAfterMs, shouldRetryOperation, throttleWaitMs } from '@/lib/apollo-client';
import { gql } from '@apollo/client';
import { __resetIdentityFaultForTests } from '@/lib/security/identity-gate';
import {
  _resetNetworkTrackingForTests,
  useNetworkStore,
} from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import { toastManager } from '@/lib/toast-manager';
import logger from '@/lib/logger';

describe('apollo-client', () => {
  beforeEach(() => {
    useNetworkStore.setState({
      isConnected: true,
      serverReachable: true,
      serverSlow: false,
    });
    // The transport-failure counter is module-level and therefore leaks across
    // tests in this file: without this, the failures driven by one test push a
    // later one past SERVER_FAILURE_THRESHOLD and silently change its outcome
    // (it suppressed the toast-while-online assertion when first added).
    _resetNetworkTrackingForTests();
    jest.restoreAllMocks();
  });

  // ── shouldRetryOperation (RetryLink's retryIf) ──────────────────────────
  describe('shouldRetryOperation', () => {
    it('is exported and the client is constructed', () => {
      expect(client).toBeDefined();
      expect(typeof shouldRetryOperation).toBe('function');
    });

    it('never retries while offline, regardless of error shape', () => {
      useNetworkStore.setState({ isConnected: false });
      expect(shouldRetryOperation(new Error('network fail'))).toBe(false);
      expect(shouldRetryOperation({ statusCode: 500 })).toBe(false);
      expect(shouldRetryOperation({ response: { status: 503 } })).toBe(false);
      expect(shouldRetryOperation(undefined)).toBe(false);
    });

    it('retries a generic transient network error while online', () => {
      useNetworkStore.setState({ isConnected: true });
      expect(shouldRetryOperation(new Error('ECONNRESET'))).toBe(true);
    });

    it('retries a 5xx server error while online', () => {
      useNetworkStore.setState({ isConnected: true });
      expect(shouldRetryOperation({ statusCode: 502 })).toBe(true);
      expect(shouldRetryOperation({ response: { status: 500 } })).toBe(true);
    });

    it('never retries a 4xx client error, even while online', () => {
      useNetworkStore.setState({ isConnected: true });
      expect(shouldRetryOperation({ statusCode: 402 })).toBe(false);
      expect(shouldRetryOperation({ response: { status: 404 } })).toBe(false);
      expect(shouldRetryOperation({ statusCode: 429 })).toBe(false);
    });

    it('never retries a GraphQL (non-network) error carrying a `result`', () => {
      useNetworkStore.setState({ isConnected: true });
      expect(shouldRetryOperation({ result: { errors: [] } })).toBe(false);
    });

    it('never retries a falsy error', () => {
      useNetworkStore.setState({ isConnected: true });
      expect(shouldRetryOperation(null)).toBe(false);
      expect(shouldRetryOperation(undefined)).toBe(false);
    });
  });

  // ── errorLink toast gating ───────────────────────────────────────────────
  // Drives a real failing request through the configured client (mocked
  // fetch) to verify the toast is suppressed while offline and shown while
  // online — the behavior added alongside shouldRetryOperation.
  describe('offline toast suppression', () => {
    const QUERY = gql`query Smoke { smoke }`;
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
      fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network fail'));
      jest.spyOn(toastManager, 'showNetworkError').mockImplementation(() => {});
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('does not show a network-error toast while offline', async () => {
      useNetworkStore.setState({ isConnected: false });
      await expect(
        client.query({ query: QUERY, fetchPolicy: 'network-only' }),
      ).rejects.toBeTruthy();
      expect(toastManager.showNetworkError).not.toHaveBeenCalled();
    });

    it('shows a network-error toast while online', async () => {
      useNetworkStore.setState({ isConnected: true });
      await expect(
        client.query({ query: QUERY, fetchPolicy: 'network-only' }),
      ).rejects.toBeTruthy();
      expect(toastManager.showNetworkError).toHaveBeenCalledTimes(1);
    });

    it('stops toasting once the server is known unreachable', async () => {
      // The global offline band covers this state persistently, so a per-query
      // toast on top of it repeats the same message once per query.
      useNetworkStore.setState({ isConnected: true, serverReachable: false });
      await expect(
        client.query({ query: QUERY, fetchPolicy: 'network-only' }),
      ).rejects.toBeTruthy();
      expect(toastManager.showNetworkError).not.toHaveBeenCalled();
    });
  });

  // ── server-reachability signal ───────────────────────────────────────────
  // The band and the identity gate both key off this. The distinctions that
  // matter: a server that ANSWERS (any status < 500) is reachable however it
  // answered, and a CANCELLED request proves nothing either way.
  describe('server reachability tracking', () => {
    const QUERY = gql`query Smoke { smoke }`;
    let fetchSpy: jest.SpyInstance;

    afterEach(() => {
      fetchSpy?.mockRestore();
    });

    const runFailingQuery = async () => {
      await expect(
        client.query({ query: QUERY, fetchPolicy: 'network-only' }),
      ).rejects.toBeTruthy();
    };

    it('needs two consecutive transport failures before declaring the server down', async () => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new Error('network fail'));
      jest.spyOn(toastManager, 'showNetworkError').mockImplementation(() => {});

      await runFailingQuery();
      // One failed operation is not an outage — it is a blip.
      expect(useNetworkStore.getState().serverReachable).toBe(true);

      await runFailingQuery();
      expect(useNetworkStore.getState().serverReachable).toBe(false);
    });

    it('treats our own request timeout as evidence the server is down', async () => {
      const timeout = Object.assign(new Error('Request timed out after 30000ms'), {
        isRequestTimeout: true as const,
        name: 'AbortError',
      });
      fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(timeout);
      jest.spyOn(toastManager, 'showNetworkError').mockImplementation(() => {});

      await runFailingQuery();
      await runFailingQuery();
      expect(useNetworkStore.getState().serverReachable).toBe(false);
    });

    it('does NOT count a cancelled request — navigation must not fake an outage', async () => {
      // Screen unmount / tab switch / superseded pull-to-refresh. Same "no
      // statusCode" shape as a timeout, but it carries no timeout marker.
      const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
      fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(abort);
      jest.spyOn(toastManager, 'showNetworkError').mockImplementation(() => {});

      await runFailingQuery();
      await runFailingQuery();
      await runFailingQuery();
      expect(useNetworkStore.getState().serverReachable).toBe(true);
    });

    it('recovers the moment the server answers again', async () => {
      useNetworkStore.setState({ isConnected: true, serverReachable: false });
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { smoke: 'ok' } }),
        json: async () => ({ data: { smoke: 'ok' } }),
        headers: new Headers({ 'content-type': 'application/json' }),
      } as unknown as Response);

      await client.query({ query: QUERY, fetchPolicy: 'network-only' });
      expect(useNetworkStore.getState().serverReachable).toBe(true);
    });
  });

  // ── errorLink noSyncStatus opt-out ───────────────────────────────────────
  // A GraphQL error on an operation that is NOT part of the feed sync must not
  // paint "sync failed" across For You. The first such operation is
  // intercomIdentity (lib/intercom.ts): on a server that has not deployed the
  // query yet, its only correct user-visible outcome is an email support link,
  // not telling the user their news is broken.
  //
  // This asserts the HONOURING half. lib/__tests__/intercom.test.ts asserts the
  // sending half (that the flag is on the operation); neither is worth much
  // without the other.
  describe('errorLink noSyncStatus opt-out', () => {
    const QUERY = gql`query NoSyncStatusProbe { probe }`;
    const graphqlErrorResponse = () => ({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          data: null,
          errors: [{ message: 'Cannot query field "probe"', extensions: { code: 'BAD_USER_INPUT' } }],
        }),
    });

    let fetchSpy: jest.SpyInstance;
    let syncSpy: jest.SpyInstance;

    beforeEach(() => {
      const { useForYouStore } = require('@/lib/stores/for-you-store');
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(graphqlErrorResponse() as unknown as Response);
      syncSpy = jest.spyOn(useForYouStore.getState(), 'setSyncStatusMessage');
      useNetworkStore.setState({ isConnected: true });
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('suppresses the sync-failed banner when the operation opts out', async () => {
      await expect(
        client.query({
          query: QUERY,
          fetchPolicy: 'network-only',
          context: { noSyncStatus: true },
        }),
      ).rejects.toBeTruthy();
      expect(syncSpy).not.toHaveBeenCalled();
    });

    it('still paints the banner for an ordinary operation', async () => {
      await expect(
        client.query({ query: QUERY, fetchPolicy: 'network-only' }),
      ).rejects.toBeTruthy();
      expect(syncSpy).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'failed', headlineKey: 'sync.syncFailed' }),
      );
    });

    // The real caller, not a probe. AppVersionService is a best-effort startup
    // check on a server-whitelisted public query with no relationship to the
    // feed, so a throttled version check must not tell the user their news is
    // broken. Asserted through the service rather than by restating its context
    // object, so removing the opt-out at the call site fails here.
    it('does not paint the banner for the app-version check', async () => {
      // syncSpy is re-spied in beforeEach but jest.spyOn on an already-spied
      // method returns the SAME mock, so its call log carries over from the
      // preceding tests in this block. Clear it, or this assertion fails on
      // someone else's banner.
      syncSpy.mockClear();
      const { AppVersionService } = require('@/lib/app-version-service');
      await expect(AppVersionService.getVersionInfo()).rejects.toBeTruthy();
      expect(syncSpy).not.toHaveBeenCalled();
    });

    // The opt-out suppresses the banner only. Losing the Sentry capture with it
    // would turn a visible failure into a silent one.
    it('still reports the app-version failure to Sentry', async () => {
      const captureSpy = jest.spyOn(logger, 'captureException');
      const { AppVersionService } = require('@/lib/app-version-service');
      await expect(AppVersionService.getVersionInfo()).rejects.toBeTruthy();
      expect(captureSpy).toHaveBeenCalled();
    });
  });

  // ── errorLink Sentry-capture gating (Sentry MERA-APP-5F/4P/4N) ───────────
  // Previously captureException fired unconditionally for every network
  // error; the isConnected gate only suppressed the toast. That meant every
  // offline user's every no-cache query filed a Sentry event. The capture
  // itself must now move inside the isConnected gate: known-offline degrades
  // to a breadcrumb, online (or not-yet-known) still reports.
  describe('errorLink Sentry-capture gating', () => {
    const QUERY = gql`query Smoke2 { smoke2 }`;
    let fetchSpy: jest.SpyInstance;
    let captureSpy: jest.SpyInstance;
    let breadcrumbSpy: jest.SpyInstance;

    beforeEach(() => {
      fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network fail'));
      jest.spyOn(toastManager, 'showNetworkError').mockImplementation(() => {});
      captureSpy = jest.spyOn(logger, 'captureException');
      breadcrumbSpy = jest.spyOn(logger, 'addBreadcrumb');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('produces a breadcrumb (not captureException) when isConnected is false (known offline)', async () => {
      useNetworkStore.setState({ isConnected: false });
      await expect(
        client.query({ query: QUERY, fetchPolicy: 'network-only' }),
      ).rejects.toBeTruthy();
      expect(captureSpy).not.toHaveBeenCalled();
      expect(breadcrumbSpy).toHaveBeenCalled();
    });

    it('still calls captureException when isConnected is true (known online)', async () => {
      useNetworkStore.setState({ isConnected: true });
      await expect(
        client.query({ query: QUERY, fetchPolicy: 'network-only' }),
      ).rejects.toBeTruthy();
      expect(captureSpy).toHaveBeenCalled();
    });

    it('still calls captureException when isConnected is an unknown (non-boolean) value', async () => {
      // Pins the actual behavior the fix hinges on: the gate must be
      // `=== false`, not `!isConnected`. With `undefined` (simulating a
      // not-yet-seeded value), `!isConnected` is truthy — it would wrongly
      // suppress — while `=== false` is false, so it still reports. A test
      // that only ever feeds the gate `true`/`false` can't distinguish the
      // two operators; this one can.
      useNetworkStore.setState({ isConnected: undefined as unknown as boolean });
      await expect(
        client.query({ query: QUERY, fetchPolicy: 'network-only' }),
      ).rejects.toBeTruthy();
      expect(captureSpy).toHaveBeenCalled();
    });
  });

  // ── identity-fault backstop (ownership 403) ──────────────────────────────
  // The server raises ForbiddenException('Access denied: resource belongs to
  // another user') whenever the authenticated session and the `userId` query
  // ARGUMENT disagree. Every personalized query on a screen fails identically,
  // so the link must collapse the storm into ONE recovery trigger instead of
  // one Sentry event + one "sync failed" banner + one LogBox toast per query.
  describe('identity-fault backstop (ownership 403)', () => {
    const QUERY = gql`query Ownership { ownership }`;
    let fetchSpy: jest.SpyInstance;
    let captureSpy: jest.SpyInstance;
    let messageSpy: jest.SpyInstance;

    const ownershipResponse = (message = 'Access denied: resource belongs to another user') => ({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          data: null,
          errors: [{ message, extensions: { code: 'FORBIDDEN', statusCode: 403 } }],
        }),
    });

    beforeEach(() => {
      __resetIdentityFaultForTests();
      useUserStore.setState({ needsReauth: false });
      useNetworkStore.setState({ isConnected: true });
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(ownershipResponse() as unknown as Response);
      captureSpy = jest.spyOn(logger, 'captureException').mockImplementation(() => undefined as any);
      messageSpy = jest.spyOn(logger, 'captureMessage').mockImplementation(() => undefined as any);
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    const run = async () => {
      await expect(
        client.query({ query: QUERY, fetchPolicy: 'network-only' }),
      ).rejects.toBeTruthy();
    };

    it('flips needsReauth exactly once and logs one identity-gate message', async () => {
      await run();
      expect(useUserStore.getState().needsReauth).toBe(true);
      expect(messageSpy).toHaveBeenCalledTimes(1);
      expect(messageSpy.mock.calls[0][1]).toMatchObject({ tags: { source: 'identity-gate' } });
    });

    it('suppresses the per-query Sentry capture and the sync-failed banner', async () => {
      await run();
      // captureException and setSyncStatusMessage({state:'failed'}) live in the
      // same generic branch; returning before it silences both.
      expect(captureSpy).not.toHaveBeenCalled();
    });

    it('does not retry the operation', async () => {
      await run();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('a second ownership 403 does not re-trigger the recovery flow', async () => {
      await run();
      await run();
      await run();
      expect(messageSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('leaves an unrelated FORBIDDEN error on the generic path', async () => {
      fetchSpy.mockResolvedValue(
        ownershipResponse('Forbidden') as unknown as Response,
      );
      await run();
      expect(messageSpy).not.toHaveBeenCalled();
      expect(useUserStore.getState().needsReauth).toBe(false);
      expect(captureSpy).toHaveBeenCalled();
    });
  });
});

// ── Retry-After ────────────────────────────────────────────────────────────
// ErrorLink's callback receives no headers, but the raw Response is reachable:
// BaseHttpLink calls operation.setContext({ response }) before parsing, and
// createOperation hands every link the same closure-backed context. For a real
// HTTP 429 the response is on the ServerError itself, which is what the network
// branch reads - RetryLink reuses the operation across attempts, so the context
// copy can be a previous attempt's.
describe('parseRetryAfterMs', () => {
  const withHeader = (value: string | null) => ({
    headers: { get: (name: string) => (name === 'retry-after' ? value : null) },
  });

  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs(withHeader('5'))).toBe(5000);
  });

  it('parses 0 as an immediate retry, not as absent', () => {
    expect(parseRetryAfterMs(withHeader('0'))).toBe(0);
  });

  it('parses an HTTP-date into a forward delta', () => {
    const at = new Date(Date.now() + 12_000).toUTCString();
    const ms = parseRetryAfterMs(withHeader(at));
    expect(ms).toBeGreaterThan(9_000);
    expect(ms).toBeLessThanOrEqual(13_000);
  });

  it('treats a past HTTP-date as no instruction', () => {
    const at = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(withHeader(at))).toBeNull();
  });

  it('returns null for an absent header', () => {
    expect(parseRetryAfterMs(withHeader(null))).toBeNull();
  });

  it('returns null for garbage rather than throwing', () => {
    expect(parseRetryAfterMs(withHeader('soon'))).toBeNull();
    expect(parseRetryAfterMs(withHeader('-5'))).toBeNull();
    expect(parseRetryAfterMs(withHeader(''))).toBeNull();
  });

  it('returns null when there is no response or no headers at all', () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs({})).toBeNull();
    expect(parseRetryAfterMs({ headers: {} })).toBeNull();
  });

  it('returns null when headers.get throws', () => {
    expect(
      parseRetryAfterMs({ headers: { get: () => { throw new Error('nope'); } } }),
    ).toBeNull();
  });
});

describe('throttleWaitMs', () => {
  it('falls back to exponential backoff when there is no header', () => {
    expect(throttleWaitMs(null, 0)).toBe(500);
    expect(throttleWaitMs(null, 1)).toBe(1000);
    expect(throttleWaitMs(null, 2)).toBe(2000);
  });

  // The compliance half: jitter is ADDITIVE. A symmetric spread would send half
  // of all retries back BEFORE the moment the server named, which is the one
  // thing Retry-After forbids.
  it('never returns less than the server asked for', () => {
    for (let i = 0; i < 500; i++) {
      expect(throttleWaitMs(5000, 0)).toBeGreaterThanOrEqual(5000);
    }
  });

  it('adds at most 20 percent on top', () => {
    for (let i = 0; i < 500; i++) {
      expect(throttleWaitMs(5000, 0)).toBeLessThanOrEqual(6000);
    }
  });

  // Without the spread, every client the server throttled with the same integer
  // comes back in the same millisecond - the convoy the 429 was breaking up.
  it('actually spreads, rather than returning a constant', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(throttleWaitMs(5000, 0));
    expect(seen.size).toBeGreaterThan(50);
  });

  it('caps the wait at 30s so three of them fit inside the 3min job timeout', () => {
    for (let i = 0; i < 200; i++) {
      expect(throttleWaitMs(600_000, 0)).toBe(30_000);
    }
    expect(throttleWaitMs(29_000, 0)).toBeLessThanOrEqual(30_000);
  });

  it('prefers the header over the backoff even late in the attempt sequence', () => {
    expect(throttleWaitMs(5000, 2)).toBeGreaterThanOrEqual(5000);
  });
});
