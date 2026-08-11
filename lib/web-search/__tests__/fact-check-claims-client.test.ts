// Tests for web-search/fact-check-claims-client.ts — the ClaimReview transport.
//
// The assertions that matter most are the three-way ones: a populated lookup, a
// TRUE empty ("we looked; nobody has published"), and an unavailable lookup
// ("we never looked"). The second and third are the pair a fact-checker cannot
// afford to confuse, and the ~4% corpus coverage means the second is the
// COMMON case — so an over-eager "treat empty as broken" reading would break
// the feature just as thoroughly as the old "treat disabled as empty" one did.

const mockGetJwtToken = jest.fn();

jest.mock('../../auth-client', () => ({
  getJwtToken: (...args: unknown[]) => mockGetJwtToken(...args),
}));

jest.mock('../../config/endpoints', () => ({
  INFERENCE_ENDPOINT: 'https://gateway.test',
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

const mockAcquire = jest.fn().mockResolvedValue(undefined);
const mockPauseFor = jest.fn();
jest.mock('../../llm/gateway-rate-limiter', () => ({
  acquire: (...args: unknown[]) => mockAcquire(...args),
  pauseFor: (...args: unknown[]) => mockPauseFor(...args),
}));

import { MAX_CLAIM_CHARS, searchClaimReviews } from '../fact-check-claims-client';
import { SEARCH_UNAVAILABLE } from '../web-search-client';

const mockFetch = jest.fn();

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

const REVIEW = {
  claim: 'Small children receive 80 different vaccines',
  claimant: 'A politician',
  claimDate: '2026-08-01T00:00:00Z',
  publisher: { name: 'PolitiFact', site: 'politifact.com' },
  url: 'https://politifact.invalid/1',
  title: "No, small children don't receive '80 different vaccines'",
  reviewDate: '2026-08-02T00:00:00Z',
  textualRating: 'Pants on Fire',
  languageCode: 'en',
};

describe('searchClaimReviews', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetJwtToken.mockResolvedValue('jwt-abc');
    mockAcquire.mockResolvedValue(undefined);
    global.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockResolvedValue(jsonResponse(200, { claimReviews: [] }));
  });

  it('POSTs only the claim, bearing the session JWT', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { claimReviews: [REVIEW] }));

    const outcome = await searchClaimReviews('  a claim  ');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://gateway.test/v1/fact-check-claims');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer jwt-abc');
    // The BODY is the privacy assertion: no article id, no user id, no persona.
    expect(JSON.parse(init.body)).toEqual({ query: 'a claim' });
    expect(outcome).toEqual({ ok: true, claimReviews: [REVIEW] });
  });

  it('omits languageCode entirely when not supplied, and sends it when it is', async () => {
    await searchClaimReviews('a claim');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ query: 'a claim' });

    await searchClaimReviews('a claim', { languageCode: 'pt-BR', maxAgeDays: 30 });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
      query: 'a claim',
      languageCode: 'pt-BR',
      maxAgeDays: 30,
    });
  });

  it('preserves textualRating verbatim — the publisher\'s own wording', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { claimReviews: [REVIEW] }));
    const outcome = await searchClaimReviews('a claim');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.claimReviews[0].textualRating).toBe('Pants on Fire');
  });

  // THE COMMON CASE, and it is a SUCCESS. Roughly 96% of this corpus has never
  // been fact-checked by an IFCN signatory; reporting that honestly is the
  // feature working, not failing.
  it('treats an empty list behind a 200 as SUCCESS — we looked, nobody published', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { claimReviews: [] }));
    expect(await searchClaimReviews('a claim')).toEqual({ ok: true, claimReviews: [] });
  });

  it('tolerates a body with no claimReviews key at all', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, {}));
    expect(await searchClaimReviews('a claim')).toEqual({ ok: true, claimReviews: [] });
  });

  it('drops a review with no url and defaults missing fields', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        claimReviews: [{ ...REVIEW, url: '' }, null, 'nonsense', { url: 'https://ok.invalid' }],
      }),
    );
    const outcome = await searchClaimReviews('a claim');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.claimReviews).toEqual([
        {
          claim: '',
          claimant: '',
          claimDate: '',
          publisher: { name: '', site: '' },
          url: 'https://ok.invalid',
          title: '',
          reviewDate: '',
          textualRating: '',
          languageCode: '',
        },
      ]);
    }
  });

  // THE CONTROL THAT MUST BE ABLE TO FAIL: a disabled lookup must be
  // distinguishable from "nobody checked this", or the fact-checker manufactures
  // a green all-clear out of a missing env var.
  it('maps a 503 search-unavailable to a failure carrying the code', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(503, { code: 'search-unavailable', reason: 'disabled', message: 'off' }),
    );

    const outcome = await searchClaimReviews('a claim');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe(SEARCH_UNAVAILABLE);
      expect(outcome.status).toBe(503);
      expect(outcome.error).toContain('not evidence');
    }
  });

  it('marks a 429 unavailable and backs the shared limiter off', async () => {
    mockFetch.mockResolvedValue(jsonResponse(429, {}));
    const outcome = await searchClaimReviews('a claim');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(SEARCH_UNAVAILABLE);
    expect(mockPauseFor).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 502, 418])('maps a %i response to a non-throwing failure', async (status) => {
    mockFetch.mockResolvedValue(jsonResponse(status, {}));
    const outcome = await searchClaimReviews('a claim');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(status);
  });

  it('rejects a too-short or too-long claim WITHOUT a round trip or a limiter grant', async () => {
    for (const c of ['', ' ', 'a', 'z'.repeat(MAX_CLAIM_CHARS + 1)]) {
      const outcome = await searchClaimReviews(c);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.status).toBe(400);
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('never sends a request without a token', async () => {
    mockGetJwtToken.mockResolvedValue(null);
    const outcome = await searchClaimReviews('a claim');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, error: expect.any(String), status: 401 });
  });

  it('goes through the shared gateway limiter BEFORE fetching', async () => {
    const order: string[] = [];
    mockAcquire.mockImplementation(() => {
      order.push('acquire');
      return Promise.resolve();
    });
    mockFetch.mockImplementation(() => {
      order.push('fetch');
      return Promise.resolve(jsonResponse(200, { claimReviews: [] }));
    });

    await searchClaimReviews('a claim');

    expect(order).toEqual(['acquire', 'fetch']);
  });

  it('returns a failure rather than throwing when the network rejects', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const outcome = await searchClaimReviews('a claim');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(SEARCH_UNAVAILABLE);
  });

  it('returns a failure rather than throwing on a malformed body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('not json')),
    });
    expect((await searchClaimReviews('a claim')).ok).toBe(false);
  });
});
