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

  // MERA-APP-9F/9D/9K/97, 9N, 9Q, 9Z: the transport and expo-updates wordings seen in production.
  it.each([
    'fetch failed: The network connection was lost.',
    'fetch failed: Fetch request has been canceled',
    'fetch failed: The Internet connection appears to be offline.',
    'fetch failed: A server with the specified hostname could not be found.',
    'Call to function \'ExpoUpdates.checkForUpdateAsync\' has been rejected.\n→ Caused by: Failed to check for update: Failed to download remote update: Unable to resolve host "u.expo.dev": No address associated with hostname',
    'Failed to download new update: Failed to load all assets',
    'Error performing request.',
  ])('matches %s', (message) => {
    expect(isTransientNetworkError(new Error(message))).toBe(true);
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
