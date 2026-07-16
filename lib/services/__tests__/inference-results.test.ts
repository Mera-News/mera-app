// inference-results.test.ts — unit tests for the shared fetch/decode/persist
// primitives that survived the async-job-reconciler removal. Ported from the
// deleted async-job-reconciler.test.ts's helper coverage (auth header + status
// handling in fetchResults, reconstructLookups slicing, discardLowRelevance
// threshold semantics, toBatchResult decode branches).

const mockExpoFetch = jest.fn();
jest.mock('expo/fetch', () => ({
  fetch: (...args: any[]) => mockExpoFetch(...args),
}));

const mockGetJwtToken = jest.fn();
jest.mock('@/lib/auth-client', () => ({
  getJwtToken: (...args: any[]) => mockGetJwtToken(...args),
}));

const mockDecryptContent = jest.fn();
jest.mock('@/lib/e2ee/e2ee-service', () => ({
  decryptContent: (...args: any[]) => mockDecryptContent(...args),
}));

const mockDeleteSuggestionsByServerIds = jest.fn();
const mockBatchMarkReasonSkipped = jest.fn();
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  deleteSuggestionsByServerIds: (...args: any[]) =>
    mockDeleteSuggestionsByServerIds(...args),
  batchMarkReasonSkipped: (...args: any[]) =>
    mockBatchMarkReasonSkipped(...args),
}));

jest.mock('@/lib/mera-protocol/scoring-service', () => ({
  CLOUD_SCORE_CHUNK_SIZE: 5,
}));

const mockAddBreadcrumb = jest.fn();
jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: (...args: any[]) => mockAddBreadcrumb(...args),
}));

const mockWarn = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    warn: (...args: any[]) => mockWarn(...args),
    info: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
  },
}));

jest.mock('@/lib/config/endpoints', () => ({
  INFERENCE_ENDPOINT: 'https://inference.test',
}));

import {
  discardLowRelevance,
  fetchResults,
  hexToBytes,
  isRecordNotFoundError,
  reconstructLookups,
  toBatchResult,
  REASON_RELEVANCE_THRESHOLD,
  type ServerResults,
} from '../inference-results';

function makeFetchResponse(body: any, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetJwtToken.mockResolvedValue('jwt-token');
});

// ---------------------------------------------------------------------------
// fetchResults — auth header
// ---------------------------------------------------------------------------

describe('fetchResults — auth header', () => {
  it('uses the JWT bearer token in foreground context', async () => {
    mockExpoFetch.mockResolvedValue(makeFetchResponse({ pending: true }));
    mockGetJwtToken.mockResolvedValue('my-jwt');

    await fetchResults('req-1', 'foreground');

    expect(mockExpoFetch).toHaveBeenCalledWith(
      expect.stringContaining('req-1'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer my-jwt' },
      }),
    );
  });

  it('falls back to the per-batch capability token when JWT is null in foreground', async () => {
    mockExpoFetch.mockResolvedValue(makeFetchResponse({ pending: true }));
    mockGetJwtToken.mockResolvedValue(null);

    await fetchResults('req-1', 'foreground', 'batch-cap');

    expect(mockExpoFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: 'Bearer batch-cap' },
      }),
    );
  });

  it('falls back to the per-batch capability token when JWT throws in foreground', async () => {
    mockExpoFetch.mockResolvedValue(makeFetchResponse({ pending: true }));
    mockGetJwtToken.mockRejectedValue(new Error('keychain locked'));

    const res = await fetchResults('req-1', 'foreground', 'batch-cap');

    expect(res).toBe('pending');
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('getJwtToken threw'));
    expect(mockExpoFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: 'Bearer batch-cap' },
      }),
    );
  });

  it('throws when foreground has no JWT and no capability token', async () => {
    mockGetJwtToken.mockResolvedValue(null);

    await expect(fetchResults('req-1', 'foreground')).rejects.toThrow(
      'no auth available (foreground)',
    );
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('no JWT and no capability token'),
      }),
    );
    expect(mockExpoFetch).not.toHaveBeenCalled();
  });

  it('uses the per-batch capability token only in background context', async () => {
    mockExpoFetch.mockResolvedValue(makeFetchResponse({ pending: true }));

    await fetchResults('req-1', 'background', 'bg-cap');

    expect(mockExpoFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: 'Bearer bg-cap' },
      }),
    );
    expect(mockGetJwtToken).not.toHaveBeenCalled();
  });

  it('throws when background has no capability token', async () => {
    await expect(fetchResults('req-1', 'background')).rejects.toThrow(
      'no capability token available (background)',
    );
    expect(mockExpoFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// fetchResults — status handling
// ---------------------------------------------------------------------------

describe('fetchResults — status handling', () => {
  it('returns "pending" when the server responds with pending:true', async () => {
    mockExpoFetch.mockResolvedValue(makeFetchResponse({ pending: true }));
    const res = await fetchResults('req-1', 'foreground');
    expect(res).toBe('pending');
  });

  it('returns "not-found" on 404', async () => {
    mockExpoFetch.mockResolvedValue({ status: 404, ok: false, text: jest.fn() });
    const res = await fetchResults('req-1', 'foreground');
    expect(res).toBe('not-found');
  });

  it('returns "unauthorized" on 401', async () => {
    mockExpoFetch.mockResolvedValue({ status: 401, ok: false, text: jest.fn() });
    const res = await fetchResults('req-1', 'foreground');
    expect(res).toBe('unauthorized');
  });

  it('returns "unauthorized" on 403', async () => {
    mockExpoFetch.mockResolvedValue({ status: 403, ok: false, text: jest.fn() });
    const res = await fetchResults('req-1', 'foreground');
    expect(res).toBe('unauthorized');
  });

  it('returns the parsed ServerResults on a completed job', async () => {
    const body = {
      requestId: 'req-1',
      results: [{ id: 'score:0', ok: true }],
    };
    mockExpoFetch.mockResolvedValue(makeFetchResponse(body));
    const res = await fetchResults('req-1', 'foreground');
    expect(res).toEqual(body);
  });

  it('throws on a non-404/401/403 HTTP error', async () => {
    mockExpoFetch.mockResolvedValue({
      status: 500,
      ok: false,
      text: jest.fn().mockResolvedValue(JSON.stringify({ error: 'server down' })),
    });
    await expect(fetchResults('req-1', 'foreground')).rejects.toThrow('results fetch 500');
  });

  it('handles an unreadable error body without crashing the error message', async () => {
    mockExpoFetch.mockResolvedValue({
      status: 503,
      ok: false,
      text: jest.fn().mockRejectedValue(new Error('body read error')),
    });
    await expect(fetchResults('req-1', 'foreground')).rejects.toThrow('results fetch 503');
  });
});

// ---------------------------------------------------------------------------
// toBatchResult
// ---------------------------------------------------------------------------

describe('toBatchResult', () => {
  const privKey = new Uint8Array([1, 2, 3, 4]);

  it('decrypts the choice content on an ok row', () => {
    mockDecryptContent.mockReturnValue('  decrypted output  ');
    const row: ServerResults['results'][number] = {
      id: 'reason:c1',
      ok: true,
      response: { choices: [{ message: { content: 'enc' } }] },
    };
    const out = toBatchResult(row, privKey, 'ed25519');
    expect(out).toEqual({ id: 'reason:c1', output: 'decrypted output' });
    expect(mockDecryptContent).toHaveBeenCalledWith('enc', privKey, 'ed25519');
  });

  it('falls back to reasoning_content when content is absent', () => {
    mockDecryptContent.mockReturnValue('reasoned');
    const row: ServerResults['results'][number] = {
      id: 'reason:c1',
      ok: true,
      response: { choices: [{ message: { reasoning_content: 'enc-reason' } }] },
    };
    const out = toBatchResult(row, privKey, 'ed25519');
    expect(out.output).toBe('reasoned');
    expect(mockDecryptContent).toHaveBeenCalledWith('enc-reason', privKey, 'ed25519');
  });

  it('returns an error output for an ok=false row', () => {
    const row: ServerResults['results'][number] = {
      id: 'reason:c1',
      ok: false,
      error: 'upstream error',
    };
    const out = toBatchResult(row, privKey, 'ed25519');
    expect(out).toEqual({ id: 'reason:c1', output: '', error: 'upstream error' });
    expect(mockDecryptContent).not.toHaveBeenCalled();
  });

  it('returns empty output (no decrypt) when there is no encrypted content', () => {
    const row: ServerResults['results'][number] = {
      id: 'reason:c1',
      ok: true,
      response: { choices: [{ message: {} }] },
    };
    const out = toBatchResult(row, privKey, 'ed25519');
    expect(out).toEqual({ id: 'reason:c1', output: '' });
    expect(mockDecryptContent).not.toHaveBeenCalled();
  });

  it('captures decrypt failures into the error field without throwing', () => {
    mockDecryptContent.mockImplementation(() => {
      throw new Error('decrypt failed');
    });
    const row: ServerResults['results'][number] = {
      id: 'reason:c1',
      ok: true,
      response: { choices: [{ message: { content: 'enc' } }] },
    };
    const out = toBatchResult(row, privKey, 'ed25519');
    expect(out).toEqual({ id: 'reason:c1', output: '', error: 'decrypt failed' });
  });
});

// ---------------------------------------------------------------------------
// reconstructLookups
// ---------------------------------------------------------------------------

describe('reconstructLookups', () => {
  it('slices candidateIds into per-chunk candidate arrays keyed by score:N', () => {
    // CLOUD_SCORE_CHUNK_SIZE mocked to 5
    const candidateIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const { chunkIdToCandidates } = reconstructLookups(
      ['score:0', 'score:1'],
      candidateIds,
    );

    expect(chunkIdToCandidates.get('score:0')!.map((c) => c.id)).toEqual([
      'a', 'b', 'c', 'd', 'e',
    ]);
    expect(chunkIdToCandidates.get('score:1')!.map((c) => c.id)).toEqual(['f', 'g']);
  });

  it('ignores non-score call ids', () => {
    const { chunkIdToCandidates } = reconstructLookups(
      ['reason:x', 'reason:y'],
      ['a', 'b'],
    );
    expect(chunkIdToCandidates.size).toBe(0);
  });

  it('produces stub candidates with null metadata fields', () => {
    const { chunkIdToCandidates } = reconstructLookups(['score:0'], ['a']);
    expect(chunkIdToCandidates.get('score:0')![0]).toEqual({
      id: 'a',
      titleEn: null,
      descriptionEn: null,
      countryCode: null,
      userTopicIds: [],
      relatedFacts: [],
    });
  });
});

// ---------------------------------------------------------------------------
// discardLowRelevance
// ---------------------------------------------------------------------------

describe('discardLowRelevance', () => {
  it('finalizes only rows at or below the 0.3 keep threshold via batchMarkReasonSkipped, never deletes', async () => {
    mockBatchMarkReasonSkipped.mockResolvedValue(undefined);
    const n = await discardLowRelevance(
      ['a', 'b', 'c', 'd'],
      { a: 0.1, b: 0.3, c: 0.31, d: 0.9 },
    );
    // a (0.1) and b (0.3) are <= threshold; c and d are kept (not passed at all).
    expect(mockBatchMarkReasonSkipped).toHaveBeenCalledWith(['a', 'b']);
    expect(mockBatchMarkReasonSkipped).toHaveBeenCalledTimes(1);
    expect(mockDeleteSuggestionsByServerIds).not.toHaveBeenCalled();
    expect(n).toBe(2);
  });

  it('skips ids with no relevance entry', async () => {
    mockBatchMarkReasonSkipped.mockResolvedValue(undefined);
    await discardLowRelevance(['a', 'b'], { a: 0.1 });
    expect(mockBatchMarkReasonSkipped).toHaveBeenCalledWith(['a']);
    expect(mockDeleteSuggestionsByServerIds).not.toHaveBeenCalled();
  });

  it('returns 0 without touching the DB when nothing is below threshold', async () => {
    const n = await discardLowRelevance(['a'], { a: 0.9 });
    expect(n).toBe(0);
    expect(mockBatchMarkReasonSkipped).not.toHaveBeenCalled();
    expect(mockDeleteSuggestionsByServerIds).not.toHaveBeenCalled();
  });

  it('rows above 0.3 are left untouched (not included in the mark-skipped call)', async () => {
    mockBatchMarkReasonSkipped.mockResolvedValue(undefined);
    await discardLowRelevance(['a', 'b', 'c'], { a: 0.9, b: 0.5, c: 0.1 });
    expect(mockBatchMarkReasonSkipped).toHaveBeenCalledWith(['c']);
    expect(mockBatchMarkReasonSkipped).not.toHaveBeenCalledWith(
      expect.arrayContaining(['a']),
    );
    expect(mockBatchMarkReasonSkipped).not.toHaveBeenCalledWith(
      expect.arrayContaining(['b']),
    );
    expect(mockDeleteSuggestionsByServerIds).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isRecordNotFoundError / hexToBytes / constant
// ---------------------------------------------------------------------------

describe('isRecordNotFoundError', () => {
  it('matches Watermelon "Record ... not found" messages', () => {
    expect(
      isRecordNotFoundError(new Error('Record article_suggestions#c1 not found')),
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isRecordNotFoundError(new Error('some other db error'))).toBe(false);
  });
});

describe('hexToBytes', () => {
  it('decodes a hex string to a Uint8Array', () => {
    expect(Array.from(hexToBytes('000fff'))).toEqual([0, 15, 255]);
  });

  it('handles an empty string', () => {
    expect(hexToBytes('').length).toBe(0);
  });
});

describe('REASON_RELEVANCE_THRESHOLD', () => {
  it('is the documented 0.3 gate', () => {
    expect(REASON_RELEVANCE_THRESHOLD).toBe(0.3);
  });
});
