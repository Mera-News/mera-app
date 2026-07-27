// apollo-client.ts transitively imports lib/stores/for-you-store → the
// WatermelonDB singleton (lib/database/index.ts), which instantiates a native
// SQLiteAdapter at import time. Mock the DB seam so the module can be
// imported under Jest — same pattern as the database-service test suites
// (see lib/__test-helpers__/mockDatabase.ts).
jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import client, { shouldRetryOperation } from '@/lib/apollo-client';
import { gql } from '@apollo/client';
import { useNetworkStore } from '@/lib/stores/network-store';
import { toastManager } from '@/lib/toast-manager';
import logger from '@/lib/logger';

describe('apollo-client', () => {
  beforeEach(() => {
    useNetworkStore.setState({ isConnected: true });
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
});
