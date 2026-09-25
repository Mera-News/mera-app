// job-defer.test.ts — what counts as "try again later" rather than a failure.

let mockIsConnected: boolean | null = true;
jest.mock('@/lib/stores/network-store', () => ({
  useNetworkStore: { getState: () => ({ isConnected: mockIsConnected }) },
}));

import { deferDelayMs, isDeferrableError, DEFER_BASE_MS, DEFER_MAX_MS } from '../job-defer';

beforeEach(() => {
  mockIsConnected = true;
});

describe('isDeferrableError', () => {
  it('defers a missing local credential', () => {
    const err = Object.assign(new Error('no session'), { name: 'NoCredentialError' });
    expect(isDeferrableError(err)).toBe(true);
  });

  it('defers a gateway 503 carried as a statusCode field', () => {
    expect(isDeferrableError(Object.assign(new Error('x'), { statusCode: 503 }))).toBe(true);
  });

  it('defers a batch 503 that only carries its status in the message', () => {
    // cloudComplete throws `E2EE batch failed: 503 ...` with no statusCode.
    expect(isDeferrableError(new Error('E2EE batch failed: 503 Service Unavailable — busy'))).toBe(true);
  });

  it('defers a 429 throttle', () => {
    expect(isDeferrableError(Object.assign(new Error('throttled'), { statusCode: 429 }))).toBe(true);
    expect(isDeferrableError(new Error('E2EE batch failed: 429 Too Many Requests'))).toBe(true);
  });

  it('defers a network failure only while the device is CONFIRMED offline', () => {
    const err = new Error('Network request failed');
    mockIsConnected = false;
    expect(isDeferrableError(err)).toBe(true);
    mockIsConnected = null; // not yet known falls on the FAIL side
    expect(isDeferrableError(err)).toBe(false);
    mockIsConnected = true;
    expect(isDeferrableError(err)).toBe(false);
  });

  it('never defers an ordinary failure', () => {
    expect(isDeferrableError(new Error('E2EE batch failed: 500 boom'))).toBe(false);
    expect(isDeferrableError(new Error('parse error'))).toBe(false);
    expect(isDeferrableError(Object.assign(new Error('x'), { statusCode: 401 }))).toBe(false);
    expect(isDeferrableError(undefined)).toBe(false);
    expect(isDeferrableError('503')).toBe(false);
  });
});

describe('deferDelayMs', () => {
  it('starts at the base, doubles, and caps', () => {
    expect(DEFER_BASE_MS).toBeGreaterThanOrEqual(30_000);
    expect(deferDelayMs(0)).toBe(DEFER_BASE_MS);
    expect(deferDelayMs(1)).toBe(DEFER_BASE_MS * 2);
    expect(deferDelayMs(50)).toBe(DEFER_MAX_MS);
    expect(deferDelayMs(-3)).toBe(DEFER_BASE_MS);
  });
});
