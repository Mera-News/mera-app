// The queue's one promise to its caller: `enqueueFactCheck` returns
// IMMEDIATELY. F1 calls it from a chat proposal tap, so anything that awaits
// the run here is a frozen tap; and anything that REJECTS here surfaces as a
// broken button rather than as a failed check, which is what the row's own
// status column is for.

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), info: jest.fn(),
  },
}));

const mockRun = jest.fn();
jest.mock('../fact-check-runner', () => ({
  runFactCheck: (...a: any[]) => mockRun(...a),
  MAX_FACT_CHECK_ATTEMPTS: 3,
}));

let mockRows: any[] = [];
const mockUpsert = jest.fn(async (input: any) => { mockRows.push(input); });
jest.mock('@/lib/database/services/fact-check-record-service', () => ({
  upsertFactCheck: (...a: any[]) => mockUpsert(...(a as [any])),
  getFactCheckForClaim: async (articleId: string, claimKey: string) =>
    mockRows.find((r) => r.articleId === articleId && r.claimKey === claimKey) ?? null,
}));

import {
  __resetFactCheckQueueForTests,
  computeClaimKey,
  enqueueFactCheck,
  factCheckIdFor,
  isFactCheckInFlight,
  redriveFactCheck,
} from '../fact-check-queue';

const INPUT = {
  articleId: 'a1',
  articleTitle: 'Trump repeats vaccine schedule claim',
  articleUrl: 'https://example.test/x',
  publicationName: 'France 24',
  claim: 'Children receive 80 different vaccines.',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRows = [];
  __resetFactCheckQueueForTests();
  mockRun.mockImplementation(async () => ({ status: 'complete' }));
});

describe('computeClaimKey', () => {
  it('is stable for the same claim', () => {
    expect(computeClaimKey(INPUT.claim)).toBe(computeClaimKey(INPUT.claim));
  });

  it('normalises casing, spacing and trailing punctuation to the SAME key', () => {
    // The same assertion re-picked later must land on the same row, or the user
    // gets two answers to one question.
    expect(computeClaimKey('Children receive 80 different vaccines.'))
      .toBe(computeClaimKey('  children   receive 80 different vaccines  '));
  });

  it('separates claims that differ in substance', () => {
    expect(computeClaimKey('80 vaccines')).not.toBe(computeClaimKey('72 vaccines'));
  });

  it('never returns an empty key', () => {
    expect(computeClaimKey('').length).toBeGreaterThan(0);
  });
});

describe('enqueueFactCheck', () => {
  it('returns the contract shape and does NOT await the run', async () => {
    let settle: (() => void) | undefined;
    mockRun.mockImplementation(() => new Promise<void>((res) => { settle = () => res(); }));

    const out = await enqueueFactCheck(INPUT);

    expect(out).toEqual({
      factCheckId: factCheckIdFor('a1', computeClaimKey(INPUT.claim)),
      claimKey: computeClaimKey(INPUT.claim),
    });
    // Resolved while the run is still pending — that is the whole point.
    expect(settle).toBeDefined();
    expect(isFactCheckInFlight('a1', out.claimKey)).toBe(true);
    settle!();
  });

  it('writes the row `processing` BEFORE the run starts', async () => {
    await enqueueFactCheck(INPUT);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const written = mockUpsert.mock.calls[0][0];
    expect(written.status).toBe('processing');
    expect(written.verdict).toBeNull();
    expect(written.claimKey).toBe(computeClaimKey(INPUT.claim));
    expect(written.claim).toBe(INPUT.claim);
    expect(written.payload.checkedBy).toEqual([]);
    expect(written.payload.verdict).toBeNull();
  });

  it('still resolves with usable ids when the row write throws', async () => {
    // A chat proposal handler already told the user "checking this". A rejected
    // promise there reads as a broken tap.
    mockUpsert.mockRejectedValueOnce(new Error('db gone'));
    await expect(enqueueFactCheck(INPUT)).resolves.toMatchObject({
      claimKey: computeClaimKey(INPUT.claim),
    });
  });

  it('deduplicates a second tap while the first run is in flight', async () => {
    mockRun.mockImplementation(() => new Promise<void>(() => { /* never settles */ }));
    await enqueueFactCheck(INPUT);
    await enqueueFactCheck(INPUT);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('is a no-op once the claim has a COMPLETE row', async () => {
    mockRows = [{ articleId: 'a1', claimKey: computeClaimKey(INPUT.claim), status: 'complete' }];
    await enqueueFactCheck(INPUT);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('RE-DRIVES a `blocked` row — its causes are transient and the tap is a human', async () => {
    // A gateway 503 or a 429 must not silently retire the claim forever.
    // Terminal means "stop the automation", not "refuse the user".
    mockRows = [{
      articleId: 'a1', claimKey: computeClaimKey(INPUT.claim),
      status: 'blocked', payload: { attempts: 3, blockedReason: 'claim-review:search-unavailable' },
    }];
    await enqueueFactCheck(INPUT);
    expect(mockRun).toHaveBeenCalledTimes(1);
    // …and the attempt budget starts over: the cap bounds the recovery task,
    // not a person asking again. Carrying 3 forward would re-block instantly.
    expect(mockRun.mock.calls[0][0].attempts).toBe(0);
  });

  it('re-drives a `failed` row — "tap again" has to be a working retry', async () => {
    mockRows = [{ articleId: 'a1', claimKey: computeClaimKey(INPUT.claim), status: 'failed', payload: { attempts: 1 } }];
    await enqueueFactCheck(INPUT);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0][0].attempts).toBe(1);
  });

  it('ignores a missing article or an empty claim rather than staging a job', async () => {
    await enqueueFactCheck({ ...INPUT, articleId: '' });
    await enqueueFactCheck({ ...INPUT, claim: '   ' });
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('a run that rejects does not become an unhandled rejection', async () => {
    mockRun.mockRejectedValue(new Error('boom'));
    await enqueueFactCheck(INPUT);
    await Promise.resolve();
    await Promise.resolve();
    // Also releases the in-flight slot, so the next tap is a real retry.
    await new Promise((r) => setTimeout(r, 0));
    expect(isFactCheckInFlight('a1', computeClaimKey(INPUT.claim))).toBe(false);
  });

  it('two DIFFERENT claims on one article both run', async () => {
    mockRun.mockImplementation(() => new Promise<void>(() => { /* pending */ }));
    await enqueueFactCheck(INPUT);
    await enqueueFactCheck({ ...INPUT, claim: 'A different assertion entirely.' });
    expect(mockRun).toHaveBeenCalledTimes(2);
  });
});

describe('redriveFactCheck', () => {
  it('reconstructs the job from the stored payload', () => {
    expect(redriveFactCheck({
      articleId: 'a1',
      claim: 'a claim',
      claimKey: 'k1',
      factCheckId: 'fc1',
      articleTitle: 'T',
      payload: { articleUrl: 'https://u', publicationName: 'P', attempts: 2 },
    })).toBe(true);
    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({
      articleId: 'a1', claim: 'a claim', claimKey: 'k1',
      articleUrl: 'https://u', publicationName: 'P', attempts: 2,
    }));
  });

  it('refuses a LEGACY (v51) row — there is no claim to check', () => {
    expect(redriveFactCheck({
      articleId: 'a1', claim: null, claimKey: null,
      factCheckId: 'fc1', articleTitle: 'T', payload: {},
    })).toBe(false);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('refuses a row already in flight', async () => {
    mockRun.mockImplementation(() => new Promise<void>(() => { /* pending */ }));
    await enqueueFactCheck(INPUT);
    expect(redriveFactCheck({
      articleId: 'a1', claim: INPUT.claim, claimKey: computeClaimKey(INPUT.claim),
      factCheckId: 'fc1', articleTitle: 'T', payload: {},
    })).toBe(false);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });
});
