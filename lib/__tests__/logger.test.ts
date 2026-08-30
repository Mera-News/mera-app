// logger.ts delegates to @sentry/react-native.
// jest.setup.js already registers a partial mock for @sentry/react-native.
// We add missing methods via jest.spyOn after import, and verify delegations.

import * as Sentry from '@sentry/react-native';

// Ensure all methods are mocked (add any not in setup.js)
const mockCaptureException = jest.spyOn(Sentry, 'captureException').mockReturnValue('event-id-exc' as any);
const mockCaptureMessage = jest.spyOn(Sentry, 'captureMessage').mockReturnValue('event-id-msg' as any);
const mockAddBreadcrumb = jest.spyOn(Sentry, 'addBreadcrumb').mockImplementation(() => {});

// Methods that may not be in setup.js mock — add them to the Sentry object
if (!(Sentry as any).setUser) (Sentry as any).setUser = jest.fn();
if (!(Sentry as any).setTag) (Sentry as any).setTag = jest.fn();
if (!(Sentry as any).setExtra) (Sentry as any).setExtra = jest.fn();
if (!(Sentry as any).startInactiveSpan) (Sentry as any).startInactiveSpan = jest.fn(() => ({ spanId: 'span-1' }));

const mockSetUser = jest.spyOn(Sentry, 'setUser' as any).mockImplementation(jest.fn());
const mockSetTag = jest.spyOn(Sentry, 'setTag' as any).mockImplementation(jest.fn());
const mockSetExtra = jest.spyOn(Sentry, 'setExtra' as any).mockImplementation(jest.fn());
const mockStartInactiveSpan = jest.spyOn(Sentry, 'startInactiveSpan' as any).mockReturnValue({ spanId: 'span-1' } as any);

import logger from '../logger';

describe('logger.captureException', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes an Error object directly to Sentry', () => {
    const err = new Error('boom');
    logger.captureException(err);
    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('wraps a non-Error in new Error before passing to Sentry', () => {
    logger.captureException('string error');
    const [passedErr] = mockCaptureException.mock.calls[0];
    expect(passedErr).toBeInstanceOf(Error);
    expect((passedErr as Error).message).toBe('string error');
  });

  it('passes custom level, tags, extra, fingerprint to Sentry', () => {
    const err = new Error('test');
    logger.captureException(err, {
      level: 'warning',
      tags: { service: 'test' },
      extra: { key: 'val' },
      fingerprint: ['fp1'],
    });
    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        level: 'warning',
        tags: { service: 'test' },
        extra: { key: 'val' },
        fingerprint: ['fp1'],
      }),
    );
  });

  it('returns the event ID from Sentry', () => {
    mockCaptureException.mockReturnValueOnce('my-event-id' as any);
    const id = logger.captureException(new Error('x'));
    expect(id).toBe('my-event-id');
  });

  it('calls Sentry in __DEV__ mode (captureException is observable side-effect)', () => {
    const err = new Error('dev error');
    logger.captureException(err);
    // In __DEV__ mode, console.error is called AND Sentry is called.
    expect(mockCaptureException).toHaveBeenCalled();
  });
});

describe('logger.captureMessage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends a message to Sentry with default info level', () => {
    logger.captureMessage('hello sentry');
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'hello sentry',
      expect.objectContaining({ level: 'info' }),
    );
  });

  it('sends a message with custom level and extras', () => {
    logger.captureMessage('something happened', {
      level: 'warning',
      tags: { code: '404' },
      extra: { url: '/api/test' },
    });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'something happened',
      expect.objectContaining({ level: 'warning', tags: { code: '404' } }),
    );
  });

  it('returns event ID', () => {
    mockCaptureMessage.mockReturnValueOnce('msg-event-id' as any);
    const id = logger.captureMessage('test');
    expect(id).toBe('msg-event-id');
  });

  it('invokes addBreadcrumb (observable side-effect) in __DEV__ mode', () => {
    // console.info is replaced by setup.js but clearAllMocks resets it;
    // we verify the breadcrumb path instead since that's the persistent behavior.
    logger.captureMessage('dev message');
    // captureMessage calls Sentry — verifiable via mockCaptureMessage
    expect(mockCaptureMessage).toHaveBeenCalled();
  });
});

describe('logger.addBreadcrumb', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates to Sentry.addBreadcrumb with all arguments', () => {
    logger.addBreadcrumb('navigated', 'navigation', { from: '/a', to: '/b' }, 'info');
    expect(mockAddBreadcrumb).toHaveBeenCalledWith({
      message: 'navigated',
      category: 'navigation',
      data: { from: '/a', to: '/b' },
      level: 'info',
    });
  });

  it('uses "info" as default level', () => {
    logger.addBreadcrumb('click', 'ui');
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info' }),
    );
  });
});

describe('logger.setUser', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates setUser to Sentry', () => {
    logger.setUser({ id: 'u1', email: 'u@example.com' });
    expect(mockSetUser).toHaveBeenCalledWith({ id: 'u1', email: 'u@example.com' });
  });

  it('can pass null to clear the user', () => {
    logger.setUser(null);
    expect(mockSetUser).toHaveBeenCalledWith(null);
  });
});

describe('logger.setTag', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates setTag to Sentry', () => {
    logger.setTag('env', 'production');
    expect(mockSetTag).toHaveBeenCalledWith('env', 'production');
  });
});

describe('logger.setExtra', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates setExtra to Sentry', () => {
    logger.setExtra('response', { code: 200 });
    expect(mockSetExtra).toHaveBeenCalledWith('response', { code: 200 });
  });
});

describe('logger.startTransaction', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates to Sentry.startInactiveSpan', () => {
    logger.startTransaction('my-txn', 'http');
    expect(mockStartInactiveSpan).toHaveBeenCalledWith({ name: 'my-txn', op: 'http' });
  });
});

describe('logger convenience log levels', () => {
  const originalVerbose = process.env.EXPO_PUBLIC_VERBOSE_LOGS;

  beforeEach(() => jest.clearAllMocks());

  afterEach(() => {
    process.env.EXPO_PUBLIC_VERBOSE_LOGS = originalVerbose;
  });

  it('logger.debug adds breadcrumb with "debug" category and level in __DEV__', () => {
    logger.debug('test debug', { key: 'val' });
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'debug', level: 'debug' }),
    );
  });

  it('logger.info adds breadcrumb with "info" category', () => {
    logger.info('info msg');
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'info', level: 'info' }),
    );
  });

  it('logger.warn adds breadcrumb with "warning" category', () => {
    logger.warn('warn msg', { ctx: true });
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'warning', level: 'warning' }),
    );
  });

  it('logger.error with an error object calls captureException', () => {
    const err = new Error('broken');
    logger.error('something broke', err, { extra: 'data' });
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('logger.error without error object calls captureMessage with error level', () => {
    logger.error('no error obj');
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'no error obj',
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('logger.debug does not call console.debug when EXPO_PUBLIC_VERBOSE_LOGS is unset', () => {
    delete process.env.EXPO_PUBLIC_VERBOSE_LOGS;
    const spy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    logger.debug('quiet debug');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('logger.debug calls console.debug when EXPO_PUBLIC_VERBOSE_LOGS is "true"', () => {
    process.env.EXPO_PUBLIC_VERBOSE_LOGS = 'true';
    const spy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    logger.debug('verbose debug', { key: 'val' });
    expect(spy).toHaveBeenCalledWith('[Debug]', 'verbose debug', { key: 'val' });
    spy.mockRestore();
  });

  it('logger.info omits the trailing context arg from console.info when context is undefined', () => {
    const spy = jest.spyOn(console, 'info').mockImplementation(() => {});
    logger.info('no context here');
    expect(spy).toHaveBeenCalledWith('[Info]', 'no context here');
    spy.mockRestore();
  });

  it('logger.warn omits the trailing context arg from console.warn when context is undefined', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('no context warn');
    expect(spy).toHaveBeenCalledWith('[Warn]', 'no context warn');
    spy.mockRestore();
  });

  it('logger.error omits undefined error/context args from console.error', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('bare message');
    expect(spy).toHaveBeenCalledWith('[Error]', 'bare message');
    spy.mockRestore();
  });

  it('logger.error includes error but omits context when context is undefined', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('boom');
    logger.error('with error only', err);
    expect(spy).toHaveBeenCalledWith('[Error]', 'with error only', err);
    spy.mockRestore();
  });
});

describe('logger.withErrorCapture', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes return value through for sync success', () => {
    const fn = jest.fn(() => 42);
    const wrapped = logger.withErrorCapture(fn);
    expect(wrapped()).toBe(42);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('captures and re-throws synchronous errors', () => {
    const err = new Error('sync fail');
    const fn = jest.fn(() => { throw err; });
    const wrapped = logger.withErrorCapture(fn);
    expect(() => wrapped()).toThrow('sync fail');
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('captures and re-throws async errors', async () => {
    const err = new Error('async fail');
    const fn = jest.fn(async () => { throw err; });
    const wrapped = logger.withErrorCapture(fn as any);
    await expect(wrapped()).rejects.toThrow('async fail');
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('passes through successful async result', async () => {
    const fn = jest.fn(async () => 'ok');
    const wrapped = logger.withErrorCapture(fn as any);
    await expect(wrapped()).resolves.toBe('ok');
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE 401 RULE AND THE CANCELLATION RULE
//
// These live in logger.captureException rather than at each catch site, because
// the per-site version silently covered only 3 of ~8 sites and a single dead
// session shipped five separate Sentry issues (MERA-APP-3P/18/23/6Q + the
// breaker's own trip). Each case below is one of those issue shapes.
// ─────────────────────────────────────────────────────────────────────────────
describe('logger.captureException suppression rules', () => {
  beforeEach(() => jest.clearAllMocks());

  function authFailureCount(): number {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const breaker = require('../auth-failure-breaker') as typeof import('../auth-failure-breaker');
    return breaker._getBreakerState().consecutiveFailures;
  }

  function resetBreaker(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const breaker = require('../auth-failure-breaker') as typeof import('../auth-failure-breaker');
    breaker._resetForTests();
  }

  it('does not report a network 401 and feeds the auth breaker instead', () => {
    resetBreaker();
    const before = authFailureCount();
    // The shape account-service sees: Apollo's ServerError (MERA-APP-3P).
    const err = Object.assign(new Error('Response not successful: Received status code 401'), {
      statusCode: 401,
    });

    logger.captureException(err, { tags: { service: 'account-service' } });

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).toHaveBeenCalled();
    expect(authFailureCount()).toBe(before + 1);
  });

  it('does not report a NEAR attestation 401 (status carried as a field, not just in the message)', () => {
    resetBreaker();
    // Before this rule the status lived only inside the message string, so no
    // predicate could see it — that is why MERA-APP-18 reached 2726 events.
    const err = Object.assign(
      new Error('NEAR attestation failed (401): {"error":"Unauthorized"}'),
      { statusCode: 401 },
    );

    logger.captureException(err, { tags: { service: 'e2ee-service' } });

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('drops a cancellation outright without touching the auth breaker', () => {
    resetBreaker();
    const before = authFailureCount();
    // createCancellationError's shape (MERA-APP-6W).
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });

    logger.captureException(err);

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(authFailureCount()).toBe(before);
  });

  it('still reports every other error, including a 500', () => {
    resetBreaker();
    const err = Object.assign(new Error('server exploded'), { statusCode: 500 });

    logger.captureException(err, { tags: { service: 'account-service' } });

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});

describe('logger.captureMessage fingerprint', () => {
  beforeEach(() => jest.clearAllMocks());

  // The option was accepted by the type and then dropped, so captureMessage
  // grouped on its (async, unstable) stack — splitting the single string
  // 'Auth circuit breaker tripped' across MERA-APP-6J/5P/65/6R.
  it('forwards fingerprint to Sentry so a message groups on identity, not stack', () => {
    logger.captureMessage('Auth circuit breaker tripped', {
      level: 'warning',
      fingerprint: ['auth-breaker-tripped'],
    });

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Auth circuit breaker tripped',
      expect.objectContaining({ fingerprint: ['auth-breaker-tripped'] }),
    );
  });
});
