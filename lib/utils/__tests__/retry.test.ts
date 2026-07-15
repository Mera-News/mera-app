// withRetry uses setTimeout for exponential backoff.
// We mock setTimeout directly to make it resolve instantly.

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn() },
}));

// Replace setTimeout with an instant version BEFORE importing withRetry
const originalSetTimeout = global.setTimeout;
const capturedSetTimeoutDelays: number[] = [];

// Make all timeouts resolve immediately so we don't need fake timers
jest.spyOn(global, 'setTimeout').mockImplementation((fn: any, delay?: number) => {
  if (typeof delay === 'number') capturedSetTimeoutDelays.push(delay);
  return originalSetTimeout(fn, 0) as any;
});

import logger from '@/lib/logger';
import { isNonRetryableError, NonRetryableError, withRetry } from '../retry';

const mockLoggerWarn = logger.warn as jest.Mock;

describe('withRetry', () => {
  beforeEach(() => {
    mockLoggerWarn.mockClear();
    capturedSetTimeoutDelays.length = 0;
  });

  afterAll(() => {
    jest.spyOn(global, 'setTimeout').mockRestore();
  });

  it('returns immediately on first-try success', async () => {
    const op = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(op);
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('succeeds after 2 failures with exponential backoff', async () => {
    const op = jest.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValueOnce('success');

    const result = await withRetry(op, undefined, 3, '[test]');
    expect(result).toBe('success');
    expect(op).toHaveBeenCalledTimes(3);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenCalledWith('[test] retry 1/3');
    expect(mockLoggerWarn).toHaveBeenCalledWith('[test] retry 2/3');
  });

  it('throws the last error when all retries are exhausted', async () => {
    const err = new Error('persistent failure');
    const op = jest.fn().mockRejectedValue(err);

    await expect(withRetry(op, undefined, 2, '[tag]')).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('throws "aborted" when signal is already aborted before the first call', async () => {
    const controller = new AbortController();
    controller.abort();
    const op = jest.fn().mockResolvedValue('never');

    await expect(withRetry(op, controller.signal)).rejects.toThrow('aborted');
    expect(op).not.toHaveBeenCalled();
  });

  it('throws "aborted" when signal is aborted between retries', async () => {
    const controller = new AbortController();
    // Fail once, then abort, then succeed (should not reach the success)
    const op = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('ok');

    // Override setTimeout to abort AFTER the delay callback would be queued
    const origSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn: any, delay?: number) => {
      // Abort before the retry fn can run
      controller.abort();
      return originalSetTimeout(fn, 0) as any;
    });

    await expect(withRetry(op, controller.signal, 3)).rejects.toThrow('aborted');
    origSpy.mockRestore();
    // Re-apply the normal instant mock for subsequent tests
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any, delay?: number) => {
      if (typeof delay === 'number') capturedSetTimeoutDelays.push(delay);
      return originalSetTimeout(fn, 0) as any;
    });
  });

  it('uses default maxRetries=3 — calls op up to 4 times total', async () => {
    const err = new Error('err');
    const op = jest.fn().mockRejectedValue(err);
    await expect(withRetry(op)).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(4); // 1 + 3 retries
  });

  it('uses [retry] as default tag for logger.warn', async () => {
    const op = jest.fn()
      .mockRejectedValueOnce(new Error('err'))
      .mockResolvedValueOnce('ok');

    await withRetry(op);
    expect(mockLoggerWarn).toHaveBeenCalledWith('[retry] retry 1/3');
  });

  it('zero retries: throws on first failure, no warn logged', async () => {
    const err = new Error('immediate fail');
    const op = jest.fn().mockRejectedValue(err);

    await expect(withRetry(op, undefined, 0)).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('exponential backoff: delays double per retry (100, 200, 400ms)', async () => {
    capturedSetTimeoutDelays.length = 0;
    const op = jest.fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockRejectedValueOnce(new Error('3'))
      .mockResolvedValueOnce('ok');

    await withRetry(op, undefined, 3);
    expect(capturedSetTimeoutDelays).toEqual([100, 200, 400]);
  });

  // ── Non-retryable errors must fail fast — no backoff loop, no wasted attempts.
  it('does NOT retry a BAD_USER_INPUT GraphQL error (rethrows on first failure)', async () => {
    const err = { errors: [{ extensions: { code: 'BAD_USER_INPUT' } }] };
    const op = jest.fn().mockRejectedValue(err);

    await expect(withRetry(op, undefined, 3)).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('does NOT retry a 4xx network error', async () => {
    const err = { statusCode: 400, message: 'Bad Request' };
    const op = jest.fn().mockRejectedValue(err);

    await expect(withRetry(op, undefined, 3)).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('still retries a generic/network error (5xx-ish) until exhausted', async () => {
    const err = { statusCode: 503, message: 'Service Unavailable' };
    const op = jest.fn().mockRejectedValue(err);

    await expect(withRetry(op, undefined, 2)).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(3); // 1 + 2 retries — treated as transient
  });
});

describe('isNonRetryableError', () => {
  it.each([
    'BAD_USER_INPUT',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'GRAPHQL_VALIDATION_FAILED',
  ])('is true for a bare GraphQL error with code %s', (code) => {
    expect(isNonRetryableError({ extensions: { code } })).toBe(true);
  });

  it('is true for a nested errors[] carrying a non-retryable code', () => {
    expect(
      isNonRetryableError({ errors: [{ extensions: { code: 'FORBIDDEN' } }] }),
    ).toBe(true);
  });

  it.each([400, 401, 403, 404, 422, 499])('is true for 4xx status %s', (status) => {
    expect(isNonRetryableError({ statusCode: status })).toBe(true);
    expect(isNonRetryableError({ response: { status } })).toBe(true);
  });

  it('is true for a NonRetryableError instance', () => {
    expect(isNonRetryableError(new NonRetryableError('nope', new Error('x')))).toBe(true);
  });

  it.each([500, 502, 503, 504])('is false for 5xx status %s (transient)', (status) => {
    expect(isNonRetryableError({ statusCode: status })).toBe(false);
  });

  it('is false for a retryable GraphQL code (e.g. INTERNAL_SERVER_ERROR)', () => {
    expect(isNonRetryableError({ extensions: { code: 'INTERNAL_SERVER_ERROR' } })).toBe(false);
  });

  it('is false for a plain network error with no status', () => {
    expect(isNonRetryableError(new Error('socket hang up'))).toBe(false);
  });

  it('is false for null/undefined/non-object input', () => {
    expect(isNonRetryableError(null)).toBe(false);
    expect(isNonRetryableError(undefined)).toBe(false);
    expect(isNonRetryableError('string error')).toBe(false);
  });
});

describe('NonRetryableError', () => {
  it('carries the originating error as cause and keeps the name', () => {
    const cause = new Error('root');
    const e = new NonRetryableError('wrapped', cause);
    expect(e.name).toBe('NonRetryableError');
    expect(e.message).toBe('wrapped');
    expect(e.cause).toBe(cause);
    expect(e).toBeInstanceOf(Error);
  });
});
