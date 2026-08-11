// The honesty contract, and the guards that make it structural.
//
// THE TEST THAT MUST BE ABLE TO FAIL. A fact-checker that cannot say "I could
// not look" is not a fact-checker — it is a machine that prints an all-clear
// whenever the search provider is down, and that output is byte-identical to a
// real one. So the assertions below are not "status === 'blocked'": a row can
// be blocked AND carry a verdict, which would be worse than either. Every
// blocked case asserts all three of
//   • the row's `verdict` column is null,
//   • the stored payload's `verdict` is null,
//   • the MODEL WAS NEVER CALLED,
// and the last one is the discriminator that cannot be satisfied by accident.
//
// Verified red-then-green: making the blocked path write
// `verdict: 'supported'` turns `blocks and writes no verdict when the
// ClaimReview lookup is unavailable` red on both verdict assertions, and
// moving the tier-1 bail to AFTER synthesis turns the "never called" assertion
// red. Both were reverted.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

// The two transports and the model are injected per-call, but the module still
// imports them for its defaults — stubbed so no suite ever opens a socket.
jest.mock('@/lib/llm/cloudComplete', () => ({
  __esModule: true,
  cloudChatStream: jest.fn(),
}));
jest.mock('@/lib/web-search/web-search-client', () => ({
  __esModule: true,
  searchWeb: jest.fn(),
  MIN_QUERY_CHARS: 2,
  MAX_QUERY_CHARS: 200,
}));
jest.mock('../claim-review-client', () => ({
  __esModule: true,
  searchClaimReviews: jest.fn(),
  MIN_CLAIM_QUERY_CHARS: 2,
  MAX_CLAIM_QUERY_CHARS: 300,
  SEARCH_UNAVAILABLE: 'search-unavailable',
}));

import {
  buildSearchQueries,
  clampVerdictToEvidence,
  coerceVerdict,
  parseSynthesis,
  resolveCitations,
  runFactCheck,
  type FactCheckPayload,
} from '../fact-check-runner';

// ── Harness ────────────────────────────────────────────────────────────────

const JOB = {
  factCheckId: 'local:a1:k1',
  articleId: 'a1',
  claim: 'The vaccine schedule requires children to receive 80 different vaccines.',
  claimKey: 'k1',
  articleTitle: 'Trump repeats vaccine schedule claim',
  publicationName: 'France 24',
  languageCode: 'en',
};

interface Written {
  status: string;
  verdict: string | null;
  payload: FactCheckPayload;
}

function harness(options: {
  claimReview?: any[];
  claimReviewOutcome?: any;
  search?: any;
  answer?: string;
  throwOnSynthesis?: boolean;
}) {
  const writes: Written[] = [];
  const chatStream = jest.fn(async function* () {
    if (options.throwOnSynthesis) throw new Error('stream died');
    yield { type: 'text-delta' as const, delta: options.answer ?? '{}' };
    yield { type: 'finish' as const, reason: 'stop' as const };
  });
  const deps = {
    searchClaimReviews: jest.fn(async (_req: any) =>
      options.claimReviewOutcome ?? { ok: true, entries: options.claimReview ?? [] }),
    searchWeb: jest.fn(async () =>
      options.search ?? { ok: true, results: [] }),
    chatStream: chatStream as any,
    persist: jest.fn(async (input: any) => {
      writes.push({ status: input.status, verdict: input.verdict ?? null, payload: input.payload });
    }),
    now: () => 1_700_000_000_000,
  };
  return { deps, writes, chatStream, terminal: () => writes[writes.length - 1] };
}

const RESULTS = [
  { title: 'PolitiFact: no, children do not get 80 vaccines', url: 'https://politifact.com/a', snippet: 'The schedule lists 36 doses.' },
  { title: 'FactCheck.org on the vaccine schedule', url: 'https://factcheck.org/b', snippet: 'Claim overstates the count.' },
];

// ── 1. Either lookup unavailable ⇒ blocked, and NEVER a verdict ────────────

describe('the honesty contract: unavailable search can never produce a verdict', () => {
  it('blocks and writes no verdict when the ClaimReview lookup is unavailable', async () => {
    const h = harness({ claimReviewOutcome: { ok: false, error: 'off', code: 'search-unavailable', status: 503 } });
    const result = await runFactCheck(JOB, h.deps);

    expect(result.status).toBe('blocked');
    expect(h.terminal().status).toBe('blocked');
    // All three, deliberately — 'blocked' alone would pass on a row that
    // carried an answer anyway.
    expect(h.terminal().verdict).toBeNull();
    expect(h.terminal().payload.verdict).toBeNull();
    expect(h.chatStream).not.toHaveBeenCalled();
    // And it never even reached the web search, so nothing was spent.
    expect(h.deps.searchWeb).not.toHaveBeenCalled();
  });

  it('blocks and writes no verdict when EVERY web-search round is unavailable', async () => {
    const h = harness({
      claimReview: [],
      search: { ok: false, error: 'off', code: 'search-unavailable', status: 503 },
    });
    const result = await runFactCheck(JOB, h.deps);

    expect(result.status).toBe('blocked');
    expect(h.terminal().verdict).toBeNull();
    expect(h.terminal().payload.verdict).toBeNull();
    expect(h.chatStream).not.toHaveBeenCalled();
  });

  it('treats a 429 as unavailable, not as "nobody checked this"', async () => {
    const h = harness({ claimReviewOutcome: { ok: false, error: 'rate-limited', code: 'search-unavailable', status: 429 } });
    const result = await runFactCheck(JOB, h.deps);

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toContain('claim-review');
    expect(h.terminal().payload.checkedBy).toEqual([]);
    expect(h.terminal().payload.verdict).toBeNull();
    expect(h.chatStream).not.toHaveBeenCalled();
  });

  it('a blocked row is terminal and says WHY, without implying anything about the claim', async () => {
    const h = harness({ claimReviewOutcome: { ok: false, error: 'unreachable', code: 'search-unavailable' } });
    await runFactCheck(JOB, h.deps);
    const payload = h.terminal().payload;
    expect(payload.status).toBe('blocked');
    expect(payload.blockedReason).toBe('claim-review:search-unavailable');
    expect(payload.claims).toEqual([]);
    expect(payload.citations).toEqual([]);
    expect(payload.summary).toBeNull();
  });
});

// ── 2. Nobody published ⇒ complete + empty checkedBy ───────────────────────

describe('the normal case: nobody has fact-checked this', () => {
  it('completes with an empty checkedBy and a Tier 2 narrative', async () => {
    const h = harness({
      claimReview: [],
      search: { ok: true, results: RESULTS },
      answer: JSON.stringify({
        verdict: 'unsupported',
        summary: 'Reporting puts the number far lower.',
        claims: [{ claim: '80 vaccines', assessment: 'unsupported', note: 'see [1]' }],
        citations: [1, 2],
      }),
    });
    const result = await runFactCheck(JOB, h.deps);

    expect(result.status).toBe('complete');
    expect(h.terminal().payload.checkedBy).toEqual([]);
    expect(h.terminal().payload.verdict).toBe('unsupported');
    expect(h.terminal().payload.citations).toHaveLength(2);
    expect(h.chatStream).toHaveBeenCalledTimes(1);
  });

  it('a search that reached the provider and found NOTHING never reaches the model', async () => {
    // Structural, not prompt discipline: with zero evidence there is nothing a
    // verdict could be derived from, so the model is not asked for one.
    const h = harness({ claimReview: [], search: { ok: true, results: [] } });
    const result = await runFactCheck(JOB, h.deps);

    expect(result.status).toBe('complete');
    expect(result.verdict).toBe('unverifiable');
    expect(h.chatStream).not.toHaveBeenCalled();
    expect(h.terminal().payload.citations).toEqual([]);
  });
});

// ── 3. A fact-checker published ⇒ checkedBy straight from ClaimReview ──────

describe('Tier 1: checkedBy comes from ClaimReview, verbatim', () => {
  it('carries the organisation and its own rating through untouched', async () => {
    const h = harness({
      claimReview: [
        {
          organisation: 'PolitiFact',
          url: 'https://politifact.com/x',
          verdict: 'Pants on Fire!',
          summary: 'No, small children do not receive 80 vaccines',
        },
      ],
      search: { ok: true, results: RESULTS },
      answer: JSON.stringify({ verdict: 'unsupported', summary: 'ok', claims: [], citations: [1] }),
    });
    await runFactCheck(JOB, h.deps);

    // "Pants on Fire!" is NOT in our five-token vocabulary and must not be
    // normalised into it — that is the whole value of the list.
    expect(h.terminal().payload.checkedBy).toEqual([
      {
        organisation: 'PolitiFact',
        url: 'https://politifact.com/x',
        verdict: 'Pants on Fire!',
        summary: 'No, small children do not receive 80 vaccines',
      },
    ]);
  });

  it('stops asking once an organisation is found, and retries language-unset when none is', async () => {
    const h = harness({ claimReview: [], search: { ok: true, results: RESULTS }, answer: '{}' });
    await runFactCheck(JOB, h.deps);
    // full claim (en) → shortened (en) → full claim, language dropped
    expect(h.deps.searchClaimReviews).toHaveBeenCalledTimes(3);
    expect((h.deps.searchClaimReviews.mock.calls[2] as any[])[0])
      .toMatchObject({ languageCode: undefined });
  });
});

// ── 4. Failure handling ────────────────────────────────────────────────────

describe('a model failure is not a fact about the claim', () => {
  it('records `failed` (non-terminal, no verdict) below the attempt cap', async () => {
    const h = harness({ claimReview: [], search: { ok: true, results: RESULTS }, throwOnSynthesis: true });
    const result = await runFactCheck({ ...JOB, attempts: 0 }, h.deps);
    expect(result.status).toBe('failed');
    expect(h.terminal().verdict).toBeNull();
    expect(h.terminal().payload.verdict).toBeNull();
  });

  it('becomes `blocked` at the attempt cap rather than looping forever', async () => {
    const h = harness({ claimReview: [], search: { ok: true, results: RESULTS }, throwOnSynthesis: true });
    const result = await runFactCheck({ ...JOB, attempts: 2 }, h.deps);
    expect(result.status).toBe('blocked');
    expect(h.terminal().payload.verdict).toBeNull();
  });
});

// ── 5. The structural guards ───────────────────────────────────────────────

describe('clampVerdictToEvidence', () => {
  it('makes `supported` unreachable with an empty evidence set', () => {
    expect(clampVerdictToEvidence('supported', 0)).toBe('unverifiable');
    expect(clampVerdictToEvidence('disputed', 0)).toBe('unverifiable');
  });
  it('leaves a verdict alone once there is evidence', () => {
    expect(clampVerdictToEvidence('supported', 1)).toBe('supported');
  });
});

describe('resolveCitations', () => {
  it('drops indices the evidence cannot resolve — a model cannot invent a source', () => {
    const out = resolveCitations([1, 99, -3], RESULTS);
    expect(out.map((c) => c.uri)).toEqual(['https://politifact.com/a']);
  });
  it('uses `uri`, not `url` — the render layer reads `uri`', () => {
    expect(Object.keys(resolveCitations([1], RESULTS)[0])).toContain('uri');
  });
  it('falls back to the gathered evidence when the model cites nothing', () => {
    expect(resolveCitations([], RESULTS)).toHaveLength(2);
  });
});

describe('coerceVerdict — the negation guard, reproduced from the server', () => {
  it('takes a bare verdict word out of a justified answer', () => {
    expect(coerceVerdict('mixed — two of four claims hold')).toBe('mixed');
  });
  it('refuses to print the opposite of what the answer said', () => {
    expect(coerceVerdict('not supported by any source')).toBe('unverifiable');
    expect(coerceVerdict('no claims are disputed')).toBe('unverifiable');
  });
  it('does not over-fire on a negation AFTER the verdict', () => {
    expect(coerceVerdict('mixed - two claims are not corroborated')).toBe('mixed');
  });
  it('falls to unverifiable on anything unrecognised or absent', () => {
    expect(coerceVerdict('probably fine')).toBe('unverifiable');
    expect(coerceVerdict(null)).toBe('unverifiable');
  });
});

describe('parseSynthesis', () => {
  it('reads the JSON contract', () => {
    const p = parseSynthesis(
      'Here you go:\n{"verdict":"disputed","summary":"S","claims":[{"claim":"C","assessment":"unsupported"}],"citations":[1,2]}',
      2,
    );
    expect(p.verdict).toBe('disputed');
    expect(p.summary).toBe('S');
    expect(p.claims).toEqual([{ claim: 'C', assessment: 'unsupported', note: undefined }]);
    expect(p.citationIndices).toEqual([1, 2]);
  });
  it('degrades an unparseable answer to unverifiable, never to a confident one', () => {
    expect(parseSynthesis('I think this is broadly supported, probably', 3).verdict).toBe('supported');
    expect(parseSynthesis('no idea', 3).verdict).toBe('unverifiable');
  });
  it('discards citation indices outside the evidence list', () => {
    expect(parseSynthesis('{"verdict":"mixed","citations":[1,7,"3"]}', 3).citationIndices).toEqual([1, 3]);
  });
});

describe('buildSearchQueries', () => {
  const claim = JOB.claim;
  it('never pastes the claim and never exceeds the gateway cap', () => {
    for (const q of buildSearchQueries(claim, JOB.articleTitle)) {
      expect(q.length).toBeLessThanOrEqual(200);
      expect(q).not.toBe(claim);
    }
  });
  it('produces at most three distinct rounds', () => {
    const qs = buildSearchQueries(claim, JOB.articleTitle);
    expect(qs.length).toBeLessThanOrEqual(3);
    expect(new Set(qs).size).toBe(qs.length);
  });
  it('drops stopwords but keeps the entities', () => {
    expect(buildSearchQueries('The vaccine schedule requires 80 doses')[0]).toBe('vaccine schedule requires 80 doses');
  });
  it('still produces a usable query for a non-Latin claim', () => {
    const qs = buildSearchQueries('मुख्यमंत्री ने कहा कि बजट दोगुना हुआ');
    expect(qs[0].length).toBeGreaterThan(1);
  });
  it('survives a very long claim by fitting to the cap at a word boundary', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const q = buildSearchQueries(long)[0];
    expect(q.length).toBeLessThanOrEqual(200);
    expect(q.endsWith(' ')).toBe(false);
  });
});
