// THE MUST-FAIL TEST: an unavailable search can never produce a found-nothing
// answer.
//
// The two states are byte-identical in the data — both end with zero evidence —
// and they mean opposite things. "We searched and the index had nothing" is a
// real answer about the world. "We could not search" is an admission, and
// printing the first for the second is a fabricated all-clear on the one axis
// this feature is supposed to be honest about.
//
// WHY THE ASSERTIONS GO ALL THE WAY TO THE COPY KEY. Asserting only that the
// handler returns `outcome: 'search-unavailable'` is a check that cannot fail in
// the way that matters: the reader never sees the outcome, they see a sentence,
// and if a model (or a careless switch) wrote that sentence the handler could be
// perfectly right while the user read the opposite. `quickFactCheckCopyKey` is
// the ONLY thing that turns an outcome into text, so the property is asserted
// there — and asserted as an INJECTIVITY property, so a future edit that points
// both outcomes at one key fails here rather than in front of a reader.
//
// Verified red-then-green, three ways:
//   1. making the all-rounds-failed branch return 'searched-empty' turns
//      "reports search-unavailable, never searched-empty" red;
//   2. pointing `search-unavailable` at 'factCheck.quickNothingFound' in
//      `quickFactCheckCopyKey` turns the copy-key tests red while the handler
//      assertions stay green — which is exactly the gap that motivated them;
//   3. dropping the `okRounds === 0` guard so an unavailable search fell through
//      to the empty-evidence branch turns both red.
// All three were reverted.

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));
jest.mock('@/lib/llm/cloudComplete', () => ({ __esModule: true, cloudComplete: jest.fn() }));
jest.mock('@/lib/web-search/web-search-client', () => ({
  __esModule: true,
  searchWeb: jest.fn(),
  searchWebBatch: jest.fn(),
  MIN_QUERY_CHARS: 2,
  MAX_QUERY_CHARS: 200,
}));
jest.mock('@/lib/database/services/fact-check-record-service', () => ({
  __esModule: true,
  upsertFactCheck: jest.fn(),
}));

import {
  handleQuickFactCheck,
  quickFactCheckCopyKey,
  type QuickFactCheckAnswer,
  type QuickFactCheckOutcome,
} from '../quick-fact-check-handler';
import { upsertFactCheck } from '@/lib/database/services/fact-check-record-service';

const CLAIM = 'Children in the United States receive 80 different vaccines by the age of 18.';
const TITLE = 'RFK Jr. repeats vaccine schedule claim';

const RESULTS = [
  { title: 'PolitiFact on the vaccine schedule', url: 'https://politifact.com/a', snippet: '36 doses.' },
  { title: 'FactCheck.org', url: 'https://factcheck.org/b', snippet: 'The claim overstates it.' },
];

/** The gateway's "we did not search" shape: 503 + the machine-readable code. */
const UNAVAILABLE = { ok: false as const, error: 'Search is switched off…', status: 503, code: 'search-unavailable' as const };
/** The gateway's "we searched, nothing there" shape: 200 with an empty list. */
const SEARCHED_EMPTY = { ok: true as const, results: [] };

/**
 * Turns one single-query outcome into the batch equivalent, so a test can keep
 * describing "what the provider does" once. A whole-batch `ok:false` is the
 * client's "we never looked at ANY of these"; an `ok:true` batch answers each
 * query with the same outcome.
 */
function batchFrom(search: any) {
  return jest.fn(async (queries: string[]) =>
    search.ok
      ? { ok: true, searches: queries.map((query) => ({ query, results: search.results })) }
      : search,
  );
}

function deps(options: { search: any; answer?: string; throwOnSynthesis?: boolean }) {
  const complete = jest.fn(async () => {
    if (options.throwOnSynthesis) throw new Error('model died');
    return options.answer ?? '{}';
  });
  return {
    searchWeb: jest.fn(async () => options.search),
    searchWebBatch: batchFrom(options.search),
    complete,
    now: () => 1_700_000_000_000,
  };
}

// ---------------------------------------------------------------------------
// 1. THE PAIR THAT MUST NOT COLLAPSE
// ---------------------------------------------------------------------------

describe('a search that never happened is not a search that found nothing', () => {
  it('reports search-unavailable, never searched-empty, when no round succeeded', async () => {
    const d = deps({ search: UNAVAILABLE });
    const answer = await handleQuickFactCheck({ claim: CLAIM, articleTitle: TITLE }, d);

    expect(answer.outcome).toBe('search-unavailable');
    expect(answer.outcome).not.toBe('searched-empty');
    // No verdict, no summary, no citations: there is nothing behind them.
    expect(answer.verdict).toBeNull();
    expect(answer.summary).toBeNull();
    expect(answer.citations).toEqual([]);
    // THE DISCRIMINATOR THAT CANNOT BE SATISFIED BY ACCIDENT: the model is never
    // called, so no path exists on which an un-searched claim carries an answer.
    expect(d.complete).not.toHaveBeenCalled();
  });

  it('reports searched-empty — a real answer — when the index came back empty', async () => {
    const d = deps({ search: SEARCHED_EMPTY });
    const answer = await handleQuickFactCheck({ claim: CLAIM }, d);

    expect(answer.outcome).toBe('searched-empty');
    expect(answer.verdict).toBeNull();
    expect(d.complete).not.toHaveBeenCalled();
  });

  // The whole point of `quickFactCheckCopyKey`: the reader sees a SENTENCE, and
  // this is the only thing that chooses it.
  it('renders the two through DIFFERENT copy keys', async () => {
    const unavailable = await handleQuickFactCheck({ claim: CLAIM }, deps({ search: UNAVAILABLE }));
    const empty = await handleQuickFactCheck({ claim: CLAIM }, deps({ search: SEARCHED_EMPTY }));

    expect(quickFactCheckCopyKey(unavailable)).not.toBe(quickFactCheckCopyKey(empty));
    expect(quickFactCheckCopyKey(unavailable)).toBe('factCheck.quickCouldNotSearch');
    expect(quickFactCheckCopyKey(empty)).toBe('factCheck.quickNothingFound');
  });

  // Injectivity, asserted over the whole union: two outcomes sharing a key is
  // precisely how these two would silently re-merge in a later edit.
  it('maps every outcome to its own key', () => {
    const outcomes: QuickFactCheckOutcome[] = [
      'answered',
      'searched-empty',
      'search-unavailable',
      'synthesis-failed',
    ];
    const keys = outcomes.map((outcome) =>
      quickFactCheckCopyKey({ outcome } as QuickFactCheckAnswer),
    );
    expect(new Set(keys).size).toBe(outcomes.length);
  });

  // One entry unavailable, one with hits, inside the SAME batch. The batch as a
  // whole is `ok`, so the per-entry split is the only thing that can tell them
  // apart — counting entries instead of successes would call this two rounds.
  it('treats a MIXED run as searched — one good round is a search that happened', async () => {
    const searchWebBatch = jest.fn(async (queries: string[]) => ({
      ok: true as const,
      searches: [
        { query: queries[0], error: 'NOTHING was searched', code: 'search-unavailable' as const },
        { query: queries[1], results: RESULTS },
      ],
    }));
    const answer = await handleQuickFactCheck(
      { claim: CLAIM, articleTitle: TITLE },
      { ...deps({ search: SEARCHED_EMPTY, answer: '{"verdict":"disputed","summary":"S","citations":[1]}' }), searchWebBatch },
    );

    expect(answer.outcome).toBe('answered');
    expect(answer.verdict).toBe('disputed');
  });

  it('an empty claim is treated as un-searched, never as searched-empty', async () => {
    const d = deps({ search: { ok: true, results: RESULTS } });
    const answer = await handleQuickFactCheck({ claim: '   ' }, d);

    expect(answer.outcome).toBe('search-unavailable');
    expect(d.searchWeb).not.toHaveBeenCalled();
    expect(d.searchWebBatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. The answered path, and the guards it keeps
// ---------------------------------------------------------------------------

describe('the answered path', () => {
  const answerJson =
    '{"verdict":"disputed","summary":"Sources disagree.","claims":[{"claim":"C","assessment":"unsupported"}],"citations":[1,9]}';

  it('answers from the evidence, at temperature 0, without thinking', async () => {
    const d = deps({ search: { ok: true, results: RESULTS }, answer: answerJson });
    const answer = await handleQuickFactCheck({ claim: CLAIM, articleTitle: TITLE }, d);

    expect(answer.outcome).toBe('answered');
    expect(answer.verdict).toBe('disputed');
    expect(answer.summary).toBe('Sources disagree.');
    expect(d.complete).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0 }));
  });

  it('drops a citation index the evidence cannot resolve', async () => {
    const d = deps({ search: { ok: true, results: RESULTS }, answer: answerJson });
    const answer = await handleQuickFactCheck({ claim: CLAIM }, d);

    // [1, 9] over a 2-item shortlist: 9 is a hallucinated source and vanishes.
    expect(answer.citations.map((c) => c.uri)).toEqual(['https://politifact.com/a']);
  });

  // The two mandatory rounds now leave in ONE request. They must still be TWO
  // DIFFERENT queries — round 2 adds the fact-check register and surfaces
  // different documents, which is the entire reason MIN_SEARCH_ROUNDS exists.
  it('runs at least two rounds so the fact-check register query is not dead code', async () => {
    const d = deps({ search: { ok: true, results: RESULTS }, answer: answerJson });
    await handleQuickFactCheck({ claim: CLAIM, articleTitle: TITLE }, d);

    expect(d.searchWebBatch).toHaveBeenCalledTimes(1);
    const sent = d.searchWebBatch.mock.calls[0][0] as string[];
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent).size).toBe(sent.length);
  });

  // Round 3 is conditional by design: two rounds already return ~20 results, so
  // folding it into the batch would turn a search we usually skip into one we
  // always bill.
  it('does not spend the conditional round once the batch found enough', async () => {
    const plenty = Array.from({ length: 10 }, (_, i) => ({
      title: `Source ${i}`,
      url: `https://source.invalid/${i}`,
      snippet: 's',
    }));
    const d = deps({ search: { ok: true, results: plenty }, answer: answerJson });
    await handleQuickFactCheck({ claim: CLAIM, articleTitle: TITLE }, d);

    expect(d.searchWeb).not.toHaveBeenCalled();
  });

  it('never sends the claim verbatim as a query', async () => {
    const d = deps({ search: { ok: true, results: RESULTS }, answer: answerJson });
    await handleQuickFactCheck({ claim: CLAIM, articleTitle: TITLE }, d);

    const sent = [
      ...((d.searchWebBatch.mock.calls[0]?.[0] ?? []) as string[]),
      ...(d.searchWeb.mock.calls as unknown as [string][]).map(([q]) => q),
    ];
    expect(sent.length).toBeGreaterThan(0);
    for (const query of sent) {
      expect(query).not.toBe(CLAIM);
      expect(query.length).toBeLessThanOrEqual(200);
    }
  });

  it('degrades a dead model to synthesis-failed, never to a verdict', async () => {
    const d = deps({ search: { ok: true, results: RESULTS }, throwOnSynthesis: true });
    const answer = await handleQuickFactCheck({ claim: CLAIM }, d);

    expect(answer.outcome).toBe('synthesis-failed');
    expect(answer.verdict).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Ephemeral, and the ClaimReview subtraction
// ---------------------------------------------------------------------------

describe('the two subtractions', () => {
  it('NEVER writes to the fact_checks table — that list is server checks only', async () => {
    const d = deps({
      search: { ok: true, results: RESULTS },
      answer: '{"verdict":"supported","summary":"S","citations":[1]}',
    });
    await handleQuickFactCheck({ claim: CLAIM, articleTitle: TITLE }, d);

    expect(upsertFactCheck).not.toHaveBeenCalled();
  });

  // The quick answer must not be able to say "Alt News rated this False": that
  // attribution comes from an index only the server queries, and there is no
  // field on this shape that could carry it.
  it('carries no checkedBy channel at all', async () => {
    const answer = await handleQuickFactCheck(
      { claim: CLAIM },
      deps({ search: { ok: true, results: RESULTS }, answer: '{"verdict":"supported"}' }),
    );

    expect(answer).not.toHaveProperty('checkedBy');
    expect(answer).not.toHaveProperty('checkedByStatus');
  });
});
