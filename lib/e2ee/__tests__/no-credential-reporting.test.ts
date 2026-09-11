// MERA-APP-16 end-to-end: a NoCredentialError raised on the attestation path
// must not reach Sentry, and must not be counted as an auth failure.
//
// Why this lives here and not in logger.test.ts: that file proves the logger's
// rules in isolation, against hand-built error shapes. What actually broke in
// production was the JOIN — the real error, raised by the real
// prepareE2EEContext, arriving at the real classifier. MERA-APP-18 reached 2726
// events precisely because an error whose status lived only in its message text
// satisfied every isolated test and still filed on every launch.
//
// The assertion is on Sentry.captureException NOT having been called. A log line
// or a breadcrumb string would pass for the wrong reason.

import * as Sentry from '@sentry/react-native';

const mockCaptureException = jest
  .spyOn(Sentry, 'captureException')
  .mockReturnValue('event-id' as never);
jest.spyOn(Sentry, 'addBreadcrumb').mockImplementation(() => {});

const mockGetJwtToken = jest.fn<Promise<string | null>, unknown[]>();
jest.mock('@/lib/auth-client', () => ({
  getJwtToken: (...args: unknown[]) => mockGetJwtToken(...args),
  invalidateJwtCache: jest.fn(),
}));

// The attestation fetch now takes a limiter grant before its request (the
// gateway throttles per user, and /api/attestation/report counts). Mocked so
// these specs do not sit through real 3s spacing between grants.
jest.mock('@/lib/llm/gateway-rate-limiter', () => ({
  acquire: jest.fn().mockResolvedValue(undefined),
  pauseFor: jest.fn(),
}));

jest.mock('@/lib/config/endpoints', () => ({
  INFERENCE_ENDPOINT: 'https://inference.example.test',
}));

import logger from '../../logger';
import { NoCredentialError, prepareE2EEContext } from '../e2ee-service';

function breakerFailures(): number {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const breaker = require('../../auth-failure-breaker') as typeof import('../../auth-failure-breaker');
  return breaker._getBreakerState().consecutiveFailures;
}

function resetBreaker(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const breaker = require('../../auth-failure-breaker') as typeof import('../../auth-failure-breaker');
  breaker._resetForTests();
}

describe('NoCredentialError reporting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetBreaker();
  });

  it('is raised by prepareE2EEContext when there is no session token', async () => {
    mockGetJwtToken.mockResolvedValue(null);

    await expect(prepareE2EEContext('Qwen/Qwen3.6-35B-A3B-FP8')).rejects.toBeInstanceOf(
      NoCredentialError,
    );
  });

  it('does NOT reach Sentry when captured the way the audit captures it', async () => {
    mockGetJwtToken.mockResolvedValue(null);

    const err = await prepareE2EEContext('Qwen/Qwen3.6-35B-A3B-FP8').then(
      () => null,
      (e: unknown) => e,
    );

    // Exactly the shape the weekly sanity audit uses for its catch-all.
    logger.captureException(err, {
      tags: { service: 'topic-sanity-service', method: 'runSanityAudit' },
    });

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  // Negative control. Without this, the test above would also pass if the
  // classifier suppressed EVERYTHING, or if Sentry were mocked into silence —
  // it would be green for a reason that has nothing to do with the fix.
  it('still reports an ordinary failure raised from the same call site', async () => {
    logger.captureException(new Error('attestation exploded'), {
      tags: { service: 'topic-sanity-service', method: 'runSanityAudit' },
    });

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('does NOT count as an auth failure — no request was ever sent', async () => {
    mockGetJwtToken.mockResolvedValue(null);
    const before = breakerFailures();

    const err = await prepareE2EEContext('Qwen/Qwen3.6-35B-A3B-FP8').then(
      () => null,
      (e: unknown) => e,
    );
    logger.captureException(err, { tags: { service: 'e2ee-service' } });

    // A 401 feeds the breaker on purpose; a never-sent request must not, or an
    // ordinary cold start would trip a breaker meant to detect a dead session.
    expect(breakerFailures()).toBe(before);
  });
});
