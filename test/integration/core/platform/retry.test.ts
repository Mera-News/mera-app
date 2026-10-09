// withRetry backs off with setTimeout (100ms, doubling). A strict fake clock (time moves only when
// the test drives it) makes the delays observable without a spy on setTimeout.
import { advanceUntilDone, useStrictClock } from '@/test/helpers';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn() },
}));

import logger from '@/lib/logger';
import { isNonRetryableError, NonRetryableError, withRetry } from '@/lib/utils/retry';

const mockLoggerWarn = logger.warn as jest.Mock;

describe('withRetry', () => {
  beforeEach(() => useStrictClock('2026-01-01T00:00:00Z'));

  it('returns immediately on first-try success', async () => {
    const op = jest.fn().mockResolvedValue('ok');
    const result = await advanceUntilDone(withRetry(op));
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('succeeds after 2 failures with exponential backoff', async () => {
    const op = jest.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValueOnce('success');

    const result = await advanceUntilDone(withRetry(op, undefined, 3, '[test]'));
    expect(result).toBe('success');
    expect(op).toHaveBeenCalledTimes(3);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenCalledWith('[test] retry 1/3');
    expect(mockLoggerWarn).toHaveBeenCalledWith('[test] retry 2/3');
  });

  it('throws the last error when all retries are exhausted', async () => {
    const err = new Error('persistent failure');
    const op = jest.fn().mockRejectedValue(err);

    await expect(advanceUntilDone(withRetry(op, undefined, 2, '[tag]'))).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('throws "aborted" when signal is already aborted before the first call', async () => {
    const controller = new AbortController();
    controller.abort();
    const op = jest.fn().mockResolvedValue('never');

    await expect(advanceUntilDone(withRetry(op, controller.signal))).rejects.toThrow('aborted');
    expect(op).not.toHaveBeenCalled();
  });

  it('throws "aborted" when signal is aborted between retries', async () => {
    const controller = new AbortController();
    // Fail once, abort during the backoff wait, and the second attempt never runs.
    const op = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('ok');

    const result = withRetry(op, controller.signal, 3);
    await jest.advanceTimersByTimeAsync(50);
    expect(op).toHaveBeenCalledTimes(1);
    controller.abort();

    const error = await advanceUntilDone(result).catch((e) => e);
    expect(error).toMatchObject({ name: 'AbortError', message: 'aborted' });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('uses default maxRetries=3 — calls op up to 4 times total', async () => {
    const err = new Error('err');
    const op = jest.fn().mockRejectedValue(err);
    await expect(advanceUntilDone(withRetry(op))).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(4); // 1 + 3 retries
  });

  it('uses [retry] as default tag for logger.warn', async () => {
    const op = jest.fn()
      .mockRejectedValueOnce(new Error('err'))
      .mockResolvedValueOnce('ok');

    await advanceUntilDone(withRetry(op));
    expect(mockLoggerWarn).toHaveBeenCalledWith('[retry] retry 1/3');
  });

  it('zero retries: throws on first failure, no warn logged', async () => {
    const err = new Error('immediate fail');
    const op = jest.fn().mockRejectedValue(err);

    await expect(advanceUntilDone(withRetry(op, undefined, 0))).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('exponential backoff: delays double per retry (100, 200, 400ms)', async () => {
    const op = jest.fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockRejectedValueOnce(new Error('3'))
      .mockResolvedValueOnce('ok');

    const result = withRetry(op, undefined, 3);
    // Each retry runs exactly when its delay ends: one ms short, still waiting; then it fires.
    for (const [delay, callsBefore] of [[100, 1], [200, 2], [400, 3]] as const) {
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(op).toHaveBeenCalledTimes(callsBefore);
      await jest.advanceTimersByTimeAsync(1);
      expect(op).toHaveBeenCalledTimes(callsBefore + 1);
    }
    await expect(result).resolves.toBe('ok');
  });

  // ── Non-retryable errors must fail fast — no backoff loop, no wasted attempts.
  it('does NOT retry a BAD_USER_INPUT GraphQL error (rethrows on first failure)', async () => {
    const err = { errors: [{ extensions: { code: 'BAD_USER_INPUT' } }] };
    const op = jest.fn().mockRejectedValue(err);

    await expect(advanceUntilDone(withRetry(op, undefined, 3))).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('does NOT retry a 4xx network error', async () => {
    const err = { statusCode: 400, message: 'Bad Request' };
    const op = jest.fn().mockRejectedValue(err);

    await expect(advanceUntilDone(withRetry(op, undefined, 3))).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('still retries a generic/network error (5xx-ish) until exhausted', async () => {
    const err = { statusCode: 503, message: 'Service Unavailable' };
    const op = jest.fn().mockRejectedValue(err);

    await expect(advanceUntilDone(withRetry(op, undefined, 2))).rejects.toBe(err);
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
