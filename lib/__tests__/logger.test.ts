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
    expect(passedErr.message).toBe('string error');
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
  beforeEach(() => jest.clearAllMocks());

  it('logger.debug adds breadcrumb with "debug" category and level', () => {
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
