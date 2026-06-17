import { isTransientNetworkError } from '../transient-error';

describe('isTransientNetworkError', () => {
  it('matches the production "request timed out" string', () => {
    expect(isTransientNetworkError(new Error('Unknown error: The request timed out.'))).toBe(true);
  });

  it('matches the production "network connection was lost" string', () => {
    expect(
      isTransientNetworkError(new Error('Unknown error: The network connection was lost.')),
    ).toBe(true);
  });

  it('matches an AbortError by name', () => {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('matches a generic "Aborted" message', () => {
    expect(isTransientNetworkError(new Error('Aborted'))).toBe(true);
  });

  it('matches "Network request failed"', () => {
    expect(isTransientNetworkError(new Error('Network request failed'))).toBe(true);
  });

  it('matches offline / ECONNRESET style errors', () => {
    expect(isTransientNetworkError(new Error('Device is offline'))).toBe(true);
    expect(isTransientNetworkError(new Error('read ECONNRESET'))).toBe(true);
  });

  it('returns false for a genuine non-network error', () => {
    expect(isTransientNetworkError(new Error('Cannot read property of undefined'))).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError(new Error(''))).toBe(false);
  });

  it('accepts non-Error values via String() coercion', () => {
    expect(isTransientNetworkError('The request timed out')).toBe(true);
    expect(isTransientNetworkError('just a string')).toBe(false);
  });
});
