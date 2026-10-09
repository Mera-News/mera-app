// What counts as "try again later" rather than a failure, against the REAL network store (the
// original mocked it). Replaces lib/inference/__tests__/job-defer.test.ts (all 7 `it`).
import { deferDelayMs, isDeferrableError, DEFER_BASE_MS, DEFER_MAX_MS } from '@/lib/inference/job-defer';
import { useNetworkStore } from '@/lib/stores/network-store';

const setConnected = (v: boolean | null) => useNetworkStore.getState().setIsConnected(v as boolean);

beforeEach(() => setConnected(true));
afterEach(() => setConnected(true));

describe('isDeferrableError', () => {
  it('defers a missing local credential', () => {
    const err = Object.assign(new Error('no session'), { name: 'NoCredentialError' });
    expect(isDeferrableError(err)).toBe(true);
  });

  it('defers a gateway 503 carried as a statusCode field', () => {
    expect(isDeferrableError(Object.assign(new Error('x'), { statusCode: 503 }))).toBe(true);
  });

  it('defers a batch 503 that only carries its status in the message', () => {
    // cloudBatchComplete throws `E2EE batch failed: 503 ...` with no statusCode.
    expect(isDeferrableError(new Error('E2EE batch failed: 503 Service Unavailable — busy'))).toBe(true);
  });

  it('defers a 429 throttle', () => {
    expect(isDeferrableError(Object.assign(new Error('throttled'), { statusCode: 429 }))).toBe(true);
    expect(isDeferrableError(new Error('E2EE batch failed: 429 Too Many Requests'))).toBe(true);
  });

  it('defers a network failure only while the device is CONFIRMED offline', () => {
    const err = new Error('Network request failed');
    setConnected(false);
    expect(isDeferrableError(err)).toBe(true);
    // A reading that is not known yet falls on the FAIL side.
    setConnected(null);
    expect(isDeferrableError(err)).toBe(false);
    setConnected(true);
    expect(isDeferrableError(err)).toBe(false);
  });

  it('offline defers only a transport-shaped failure, not any error', () => {
    setConnected(false);
    expect(isDeferrableError(new Error('parse error'))).toBe(false);
    expect(isDeferrableError(new Error('The request timed out.'))).toBe(true);
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
