// The suppression classes logger.captureException applies at the ONE choke point, and the
// cases that must still report. Real network store and real AppState driver; only Sentry
// (an edge) is spied on.

import * as Sentry from '@sentry/react-native';
import logger, { classifySuppression } from '@/lib/logger';
import { useNetworkStore } from '@/lib/stores/network-store';
import * as breaker from '@/lib/auth-failure-breaker';
import { setAppState } from '@/test/helpers';

const mockCaptureException = jest
  .spyOn(Sentry, 'captureException')
  .mockReturnValue('event-id' as never);
const mockAddBreadcrumb = jest.spyOn(Sentry, 'addBreadcrumb').mockImplementation(() => {});
const mockCaptureMessage = jest.spyOn(Sentry, 'captureMessage').mockReturnValue('id' as never);

function setConnected(value: boolean): void {
  useNetworkStore.getState().setIsConnected(value);
}

beforeEach(() => {
  setConnected(true);
  setAppState('active');
});

afterAll(() => {
  setConnected(true);
  setAppState('active');
});

describe('classifySuppression, the offline class', () => {
  // MERA-APP-77: the Explore headlines fetch, fired on a device that had already told us it
  // had no link. The Apollo error link suppressed its own capture; ArticleService's catch
  // reported the same failure above it.
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

  // MERA-APP-78: the Expo push-token fetch. Not a GraphQL call, so the Apollo link's offline
  // gate could never have covered it; the wrapped message is the only thing identifying it.
  it('suppresses the wrapped Expo push-token failure when offline', () => {
    setConnected(false);
    const err = new Error(
      'Error encountered while fetching Expo token: TypeError: Network request failed.',
    );

    expect(classifySuppression(err)).toBe('offline');
  });

  // The gate is `=== false`, not `!isConnected`: an unknown state must fall on the REPORT side.
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

describe('classifySuppression, the backgrounded-timeout class', () => {
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

  // Apollo aborts on unsubscribe with the same "no statusCode" shape. That is a cancellation,
  // and it must not be read as our timeout.
  it('does not treat a bare AbortError as a backgrounded timeout', () => {
    setAppState('background');
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifySuppression(err)).toBe('cancelled');
  });
});

describe('classifySuppression, the no-credential class', () => {
  // Duck-typed on the name so logger never imports lib/e2ee.
  it('suppresses an error named NoCredentialError', () => {
    const err = Object.assign(new Error('no device keypair'), {
      name: 'NoCredentialError',
    });
    expect(classifySuppression(err)).toBe('no-credential');
  });

  // The load-bearing half: a missing local keypair says nothing about the session, so feeding
  // the auth breaker here would trip it and pause feed-sync over a local key.
  it('does NOT feed the auth breaker', () => {
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
  it('defaults the fingerprint to the message for a direct call', () => {
    logger.captureMessage('Auth circuit breaker tripped');
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Auth circuit breaker tripped',
      expect.objectContaining({ fingerprint: ['Auth circuit breaker tripped'] }),
    );
  });

  it('keeps an explicit fingerprint', () => {
    logger.captureMessage('msg', { fingerprint: ['pinned'] });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'msg',
      expect.objectContaining({ fingerprint: ['pinned'] }),
    );
  });

  // logger.error's messages are routinely interpolated, so that path keeps the stack-based
  // grouping it has always had.
  it('does NOT fingerprint a message routed through logger.error', () => {
    logger.error('failed for user 12345');
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'failed for user 12345',
      expect.objectContaining({ fingerprint: undefined }),
    );
  });
});
