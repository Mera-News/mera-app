// The suppression classes that logger.captureException applies at the ONE choke
// point, and the cases that must still report.
//
// Kept in its own file because two of the classes need module-level mocks
// (the network store, and react-native's AppState) that the other logger suites
// deliberately run without.

import * as Sentry from '@sentry/react-native';
import { AppState } from 'react-native';

const mockCaptureException = jest
  .spyOn(Sentry, 'captureException')
  .mockReturnValue('event-id' as never);
const mockAddBreadcrumb = jest
  .spyOn(Sentry, 'addBreadcrumb')
  .mockImplementation(() => {});

// logger lazy-requires this (a static import would be a module-eval cycle:
// network-store imports logger). The alias and the relative specifier resolve
// to the same file, so one mock covers both.
// `mock`-prefixed so babel-plugin-jest-hoist allows the factory to close over it.
let mockIsConnected = true;
jest.mock('@/lib/stores/network-store', () => ({
  useNetworkStore: {
    getState: () => ({ isConnected: mockIsConnected, serverReachable: true }),
  },
}));

import logger, { classifySuppression } from '../logger';

function setConnected(value: boolean): void {
  mockIsConnected = value;
}

function setAppState(state: 'active' | 'background' | 'inactive'): void {
  (AppState as unknown as { currentState: string }).currentState = state;
}

describe('classifySuppression — the offline class', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setConnected(true);
    setAppState('active');
  });

  // MERA-APP-77: the Explore headlines fetch, fired on a device that had
  // already told us it had no link. The Apollo error link suppressed its own
  // capture; ArticleService's catch reported the same failure above it.
  it('suppresses a whatwg-fetch network failure when the device is offline', () => {
    setConnected(false);
    const err = new TypeError('Network request failed');

    expect(classifySuppression(err)).toBe('offline');
    logger.captureException(err, { tags: { service: 'article-service' } });

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ suppressed: 'offline' }),
      }),
    );
  });

  // MERA-APP-78: the Expo push-token fetch. Not a GraphQL call, so the Apollo
  // link's offline gate could never have covered it — the wrapped message is
  // the only thing identifying it.
  it('suppresses the wrapped Expo push-token failure when offline', () => {
    setConnected(false);
    const err = new Error(
      'Error encountered while fetching Expo token: TypeError: Network request failed.',
    );

    expect(classifySuppression(err)).toBe('offline');
  });

  // The gate is `=== false`, not `!isConnected`: the store seeds optimistically
  // to "assume online" until NetInfo's first fetch lands, so an unknown state
  // must fall on the REPORT side.
  it('REPORTS the same error when the device is connected', () => {
    setConnected(true);
    const err = new TypeError('Network request failed');

    expect(classifySuppression(err)).toBeNull();
    logger.captureException(err, { tags: { service: 'article-service' } });

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  // The predicate is broad on its own; the conjunction is what makes it safe.
  it('REPORTS a non-network error even while offline', () => {
    setConnected(false);
    expect(classifySuppression(new Error('Cannot read property x of undefined'))).toBeNull();
  });
});

describe('classifySuppression — the backgrounded-timeout class', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setConnected(true);
    setAppState('active');
  });

  function timeoutError(): Error {
    // The shape lib/apollo-fetch.ts throws on its own 30s abort.
    return Object.assign(new Error('Request timed out after 30000ms'), {
      isRequestTimeout: true as const,
      elapsedMs: 31597,
    });
  }

  // MERA-APP-79. The scheduler tick had no AppState gate, so feed-sync issued
  // GetRecentArticleCount while the app was backgrounded.
  it('suppresses our own 30s abort when the app is not foreground', () => {
    setAppState('background');
    expect(classifySuppression(timeoutError())).toBe('backgrounded-timeout');
  });

  it('REPORTS the same timeout in the foreground', () => {
    setAppState('active');
    const err = timeoutError();

    expect(classifySuppression(err)).toBeNull();
    logger.captureException(err, { tags: { source: 'apollo-error-link' } });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  // Apollo aborts on unsubscribe with the same "no statusCode" shape. That is a
  // cancellation, and it must not be read as our timeout.
  it('does not treat a bare AbortError as a backgrounded timeout', () => {
    setAppState('background');
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifySuppression(err)).toBe('cancelled');
  });
});

describe('classifySuppression — the no-credential class', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setConnected(true);
    setAppState('active');
  });

  // Duck-typed on the name so logger never imports lib/e2ee.
  it('suppresses an error named NoCredentialError', () => {
    const err = Object.assign(new Error('no device keypair'), {
      name: 'NoCredentialError',
    });
    expect(classifySuppression(err)).toBe('no-credential');
  });

  // The load-bearing half: a missing local keypair says nothing about the
  // session, so feeding the auth breaker here would trip it and pause
  // feed-sync over a local key.
  it('does NOT feed the auth breaker', () => {
    const breaker = require('../auth-failure-breaker') as typeof import('../auth-failure-breaker');
    breaker._resetForTests();
    const before = breaker._getBreakerState().consecutiveFailures;

    logger.captureException(
      Object.assign(new Error('no device keypair'), { name: 'NoCredentialError' }),
    );

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(breaker._getBreakerState().consecutiveFailures).toBe(before);
  });
});

describe('captureMessage fingerprint default', () => {
  beforeEach(() => jest.clearAllMocks());

  it('defaults the fingerprint to the message for a direct call', () => {
    const spy = jest.spyOn(Sentry, 'captureMessage').mockReturnValue('id' as never);
    logger.captureMessage('Auth circuit breaker tripped');
    expect(spy).toHaveBeenCalledWith(
      'Auth circuit breaker tripped',
      expect.objectContaining({ fingerprint: ['Auth circuit breaker tripped'] }),
    );
  });

  it('keeps an explicit fingerprint', () => {
    const spy = jest.spyOn(Sentry, 'captureMessage').mockReturnValue('id' as never);
    logger.captureMessage('msg', { fingerprint: ['pinned'] });
    expect(spy).toHaveBeenCalledWith(
      'msg',
      expect.objectContaining({ fingerprint: ['pinned'] }),
    );
  });

  // logger.error's messages are routinely interpolated, so that path keeps the
  // stack-based grouping it has always had.
  it('does NOT fingerprint a message routed through logger.error', () => {
    const spy = jest.spyOn(Sentry, 'captureMessage').mockReturnValue('id' as never);
    logger.error('failed for user 12345');
    expect(spy).toHaveBeenCalledWith(
      'failed for user 12345',
      expect.objectContaining({ fingerprint: undefined }),
    );
  });
});
