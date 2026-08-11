// The one rule this transport exists to hold: UNAVAILABLE IS NOT EMPTY.
//
// `{ ok: true, entries: [] }` means "no IFCN signatory has published on this
// claim" — a fact, and the normal outcome for ~96% of Mera's corpus. A disabled
// flag, a missing key, a 429, an undeployed route or a dead network must never
// produce that same value, because the runner would then complete a check with
// a verdict it had no basis for. Every one of those is asserted below to come
// back `{ ok: false }`.

jest.mock('@/lib/auth-client', () => ({ getJwtToken: jest.fn(async () => 'jwt') }));
jest.mock('@/lib/config/endpoints', () => ({ INFERENCE_ENDPOINT: 'https://gw.test' }));
jest.mock('@/lib/llm/gateway-rate-limiter', () => ({ acquire: jest.fn(async () => undefined) }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn(), captureException: jest.fn() },
}));

import { getJwtToken } from '@/lib/auth-client';
import { acquire } from '@/lib/llm/gateway-rate-limiter';
import { searchClaimReviews, SEARCH_UNAVAILABLE } from '../claim-review-client';

const CLAIM = 'Children receive 80 different vaccines';

function respond(body: unknown, ok = true, status = 200) {
  (global as any).fetch = jest.fn(async () => ({
    ok, status, json: async () => body,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  (getJwtToken as jest.Mock).mockResolvedValue('jwt');
});

describe('unavailable is never empty', () => {
  it.each([[404, 'route not deployed'], [429, 'throttled'], [503, 'flag off'], [500, 'provider died']])(
    'HTTP %i (%s) → ok:false, not an empty list',
    async (status) => {
      respond({}, false, status as number);
      const out = await searchClaimReviews({ query: CLAIM });
      expect(out.ok).toBe(false);
      expect(out).toMatchObject({ error: SEARCH_UNAVAILABLE, status });
    },
  );

  it('an in-band `available: false` is unavailable even on a 200', async () => {
    respond({ results: [], available: false });
    expect(await searchClaimReviews({ query: CLAIM })).toMatchObject({ ok: false });
  });

  it('no session token is unavailable, and never reaches the network', async () => {
    (getJwtToken as jest.Mock).mockResolvedValue(null);
    (global as any).fetch = jest.fn();
    expect(await searchClaimReviews({ query: CLAIM })).toMatchObject({ ok: false, status: 401 });
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('a network failure is unavailable, and never throws', async () => {
    (global as any).fetch = jest.fn(async () => { throw new Error('offline'); });
    expect(await searchClaimReviews({ query: CLAIM })).toMatchObject({ ok: false });
  });

  it('a genuine zero-result answer stays a SUCCESS', async () => {
    respond({ results: [] });
    expect(await searchClaimReviews({ query: CLAIM })).toEqual({ ok: true, entries: [] });
  });
});

describe('mapping ClaimReview onto checkedBy', () => {
  it('maps the flattened shape field-for-field', async () => {
    respond({
      results: [{
        publisher: { name: 'PolitiFact', site: 'politifact.com' },
        url: 'https://politifact.com/x',
        title: 'No, small children do not receive 80 vaccines',
        textualRating: 'Pants on Fire!',
      }],
    });
    expect(await searchClaimReviews({ query: CLAIM })).toEqual({
      ok: true,
      entries: [{
        organisation: 'PolitiFact',
        url: 'https://politifact.com/x',
        verdict: 'Pants on Fire!',
        summary: 'No, small children do not receive 80 vaccines',
      }],
    });
  });

  it('also reads the raw nested `claims[].claimReview[]` shape', async () => {
    respond({ claims: [{ text: 'c', claimReview: [{ publisher: { name: 'Full Fact' }, textualRating: 'False' }] }] });
    const out = await searchClaimReviews({ query: CLAIM });
    expect(out).toMatchObject({ ok: true });
    expect((out as any).entries[0]).toMatchObject({ organisation: 'Full Fact', verdict: 'False' });
  });

  it('drops an entry with no masthead — an unattributed rating is worse than none', async () => {
    respond({ results: [{ url: 'https://x', textualRating: 'False' }, { organisation: 'Alt News' }] });
    const out = await searchClaimReviews({ query: CLAIM });
    expect((out as any).entries).toEqual([{ organisation: 'Alt News', url: undefined, verdict: undefined, summary: undefined }]);
  });

  it('collapses the same review returned twice', async () => {
    respond({
      results: [
        { organisation: 'Snopes', url: 'https://s/1' },
        { organisation: 'Snopes', url: 'https://s/1' },
        { organisation: 'Snopes', url: 'https://s/2' },
      ],
    });
    expect((await searchClaimReviews({ query: CLAIM }) as any).entries).toHaveLength(2);
  });
});

describe('transport', () => {
  it('refuses a query outside the gateway bounds without a round trip', async () => {
    (global as any).fetch = jest.fn();
    expect(await searchClaimReviews({ query: 'a' })).toMatchObject({ ok: false, status: 400 });
    expect(await searchClaimReviews({ query: 'x'.repeat(201) })).toMatchObject({ ok: false, status: 400 });
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('goes through the shared gateway rate limiter', async () => {
    respond({ results: [] });
    await searchClaimReviews({ query: CLAIM });
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('sends only the query, the language and the bearer token', async () => {
    respond({ results: [] });
    await searchClaimReviews({ query: CLAIM, languageCode: 'en' });
    const [, init] = ((global as any).fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ query: CLAIM, languageCode: 'en' });
    expect(init.headers.Authorization).toBe('Bearer jwt');
  });

  it('omits languageCode entirely when unset — the retry path', async () => {
    respond({ results: [] });
    await searchClaimReviews({ query: CLAIM });
    const [, init] = ((global as any).fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ query: CLAIM });
  });
});
