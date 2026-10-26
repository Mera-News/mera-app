// score-propagation: skip gate + same-sync election + post-results sibling propagation, run over
// the real article_suggestions and story_impressions tables. Rows are seeded through the app's own
// persist and scoring paths; the gate's writes are read back off the rows. Only the logger is mocked.
import database from '@/lib/database';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { recordOpen } from '@/lib/database/services/story-impression-service';
import { gateUnscoredForScoring, propagateToUnscoredSiblings } from '@/lib/feed-grouping/score-propagation';
import type { UserGeoLanguageContext } from '@/lib/algorithms/geo-language-priority';
import logger from '@/lib/logger';
import {
  loneClusters,
  scoreOf,
  seedScored,
  seedUnscored,
  suggestionRow,
  type GroupRowSpec,
  seedViewOnlyImpression,
} from './seed';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
  },
}));
const mockCaptureException = logger.captureException as jest.Mock;

afterEach(() => jest.restoreAllMocks());

const articleSuggestions = () => database.get('article_suggestions');

/** Passthrough spy on the table's query(): how many reads the gate made. */
const queryCount = () => jest.spyOn(articleSuggestions(), 'query');

/** The second read the gate makes (the donor lookup) throws; the first (the unscored rows) is real. */
function failDonorRead() {
  const col = articleSuggestions();
  const real = col.query.bind(col);
  let calls = 0;
  jest.spyOn(col, 'query').mockImplementation(((...conditions: unknown[]) => {
    calls += 1;
    if (calls === 2) throw new Error('db down');
    return (real as (...c: unknown[]) => unknown)(...conditions);
  }) as typeof col.query);
}

const lone = (id: string, over: Partial<GroupRowSpec> = {}): GroupRowSpec => ({
  id,
  clusters: loneClusters(id),
  ...over,
});

const UNSCORED = { relevance: 0, reason: '', status: ArticleSuggestionStatus.Unscored };

// ===========================================================================
// gateUnscoredForScoring: donor propagation
// ===========================================================================

describe('gateUnscoredForScoring: donor propagation', () => {
  it('picks the max-relevance donor and copies its relevance + reason to every candidate in one batch', async () => {
    await seedUnscored({ id: 'cand-1' }, { id: 'cand-2' });
    await seedScored({ id: 'donor-lo' }, { relevance: 0.5, reason: 'low reason' });
    await seedScored({ id: 'donor-hi' }, { relevance: 0.8, reason: 'high reason' });

    const result = await gateUnscoredForScoring(new Set());

    const expected = { relevance: 0.8, reason: 'high reason', status: ArticleSuggestionStatus.Complete };
    await expect(scoreOf('cand-1')).resolves.toEqual(expected);
    await expect(scoreOf('cand-2')).resolves.toEqual(expected);
    // The recipient is gated at the cutoff its score was calibrated for: the donor's vintage.
    const donor = await suggestionRow('donor-hi');
    expect((await suggestionRow('cand-1')).scoredWithV3).toBe(donor.scoredWithV3);
    expect(result.propagatedCount).toBe(2);
    expect(result.heldBackCount).toBe(0);
    expect(result.enqueueIds).toEqual([]);
  });

  it('breaks a donor-relevance tie by newest firstPubDateMs', async () => {
    await seedUnscored({ id: 'cand-1' });
    await seedScored({ id: 'donor-old', firstPubDateMs: 1_000 }, { relevance: 0.6, reason: 'old' });
    await seedScored({ id: 'donor-new', firstPubDateMs: 5_000 }, { relevance: 0.6, reason: 'new' });

    await gateUnscoredForScoring(new Set());

    await expect(scoreOf('cand-1')).resolves.toMatchObject({ relevance: 0.6, reason: 'new' });
  });

  test('FD10: a propagated score below the reason gate is finalized, never left owing a note', async () => {
    await seedUnscored({ id: 'cand-1' });
    await seedScored({ id: 'donor-weak' }, { relevance: 0.2, reason: '' });

    const result = await gateUnscoredForScoring(new Set());

    await expect(scoreOf('cand-1')).resolves.toEqual({
      relevance: 0.2,
      reason: '',
      status: ArticleSuggestionStatus.Complete,
    });
    expect(result.propagatedCount).toBe(1);
    expect(result.enqueueIds).toEqual([]);
  });

  // THE assertion that distinguishes the chosen fix from the rejected one.
  // The alternative was to disqualify reason-less rows as DONORS, which would
  // have sent this candidate to `enqueueIds` for a full relevance + reason
  // scoring round. Instead the relevance still propagates (that saving is kept)
  // and only the reason is owed: `batchPropagateScores` parks the row in
  // `reason_pending` for the orphaned-reasons sweep.
  it('still propagates relevance from a reason-less donor rather than enqueueing the candidate', async () => {
    await seedUnscored({ id: 'cand-1' });
    // Scored, above the render gate, reason not back yet.
    await seedScored({ id: 'donor-pending' }, { relevance: 0.72, reason: '', pending: true });

    const result = await gateUnscoredForScoring(new Set());

    await expect(scoreOf('cand-1')).resolves.toEqual({
      relevance: 0.72,
      reason: '',
      status: ArticleSuggestionStatus.ReasonPending,
    });
    expect(result.propagatedCount).toBe(1);
    expect(result.enqueueIds).toEqual([]); // NOT re-scored from scratch
  });

  it('prefers a reason-bearing donor over a higher-relevance reason-less one', async () => {
    await seedUnscored({ id: 'cand-1' });
    await seedScored({ id: 'donor-hi-noreason' }, { relevance: 0.9, reason: '', pending: true });
    await seedScored({ id: 'donor-lo-reason' }, { relevance: 0.5, reason: 'real reason' });

    await gateUnscoredForScoring(new Set());

    // Taking the reason-bearing donor lands the candidate on `complete` for
    // free; taking the 0.9 one would have cost an LLM reason call.
    await expect(scoreOf('cand-1')).resolves.toEqual({
      relevance: 0.5,
      reason: 'real reason',
      status: ArticleSuggestionStatus.Complete,
    });
  });

  it('treats a whitespace-only donor reason as reason-less when picking', async () => {
    await seedUnscored({ id: 'cand-1' });
    await seedScored({ id: 'donor-blank' }, { relevance: 0.9, reason: '   ' });
    await seedScored({ id: 'donor-real' }, { relevance: 0.4, reason: 'real reason' });

    await gateUnscoredForScoring(new Set());

    await expect(scoreOf('cand-1')).resolves.toMatchObject({ relevance: 0.4, reason: 'real reason' });
  });

  // Determinism guard: when every donor carries a reason the new key is inert,
  // so the legacy relevance → pubDate → id ordering must be untouched.
  it('keeps the legacy relevance/pubDate ordering when every donor has a reason', async () => {
    await seedUnscored({ id: 'cand-1' });
    await seedScored({ id: 'd-lo', firstPubDateMs: 9_000 }, { relevance: 0.5, reason: 'lo' });
    await seedScored({ id: 'd-hi-old', firstPubDateMs: 1_000 }, { relevance: 0.8, reason: 'hi-old' });
    await seedScored({ id: 'd-hi-new', firstPubDateMs: 5_000 }, { relevance: 0.8, reason: 'hi-new' });

    await gateUnscoredForScoring(new Set());

    await expect(scoreOf('cand-1')).resolves.toMatchObject({ relevance: 0.8, reason: 'hi-new' });
  });
});

// ===========================================================================
// gateUnscoredForScoring: same-sync election
// ===========================================================================

describe('gateUnscoredForScoring: same-sync election', () => {
  it('elects exactly one representative from a donor-less group of 3 and holds the other 2 back', async () => {
    await seedUnscored(
      { id: 'a', hasDescription: true, firstPubDateMs: 1_000 },
      { id: 'b', hasDescription: true, firstPubDateMs: 9_000 }, // newest → elected
      { id: 'c', hasDescription: true, firstPubDateMs: 2_000 },
    );

    const result = await gateUnscoredForScoring(new Set());

    expect(result.enqueueIds).toEqual(['b']);
    expect(result.heldBackCount).toBe(2);
    expect(result.propagatedCount).toBe(0);
    for (const id of ['a', 'b', 'c']) await expect(scoreOf(id)).resolves.toEqual(UNSCORED);
  });

  it('reports the elected rep as covering its whole group (rep + held-back siblings)', async () => {
    await seedUnscored(
      { id: 'a', hasDescription: true, firstPubDateMs: 1_000 },
      { id: 'b', hasDescription: true, firstPubDateMs: 9_000 }, // elected
      { id: 'c', hasDescription: true, firstPubDateMs: 2_000 },
    );

    const result = await gateUnscoredForScoring(new Set());

    expect(Object.keys(result.coveredIdsByRep)).toEqual(['b']);
    expect(result.coveredIdsByRep.b.slice().sort()).toEqual(['a', 'b', 'c']);
  });

  it('omits donor groups from the coverage map: they are propagated, never enqueued', async () => {
    await seedUnscored({ id: 'cand' });
    await seedScored({ id: 'donor' }, { relevance: 0.7, reason: 'why' });

    const result = await gateUnscoredForScoring(new Set());

    expect(result.enqueueIds).toEqual([]);
    expect(result.coveredIdsByRep).toEqual({});
  });

  it('prefers a candidate with a description when electing the representative', async () => {
    await seedUnscored(
      { id: 'a', hasDescription: false, firstPubDateMs: 9_000 },
      { id: 'b', hasDescription: true, firstPubDateMs: 1_000 }, // has description → elected
    );

    const result = await gateUnscoredForScoring(new Set());

    expect(result.enqueueIds).toEqual(['b']);
    expect(result.heldBackCount).toBe(1);
  });

  it('elects the described candidate whichever side of the comparison it lands on', async () => {
    // Mirror of the test above: the described row now has the smaller id and the older date, so
    // it is the "a" of the comparator in one order and the "b" in the other. Election must not
    // depend on which.
    await seedUnscored(
      { id: 'a', hasDescription: true, firstPubDateMs: 1_000 }, // has description → elected
      { id: 'b', hasDescription: false, firstPubDateMs: 9_000 },
    );

    const result = await gateUnscoredForScoring(new Set());

    expect(result.enqueueIds).toEqual(['a']);
    expect(result.heldBackCount).toBe(1);
  });

  it('enqueues donor-less singletons directly', async () => {
    await seedUnscored(lone('solo-1'), lone('solo-2'));

    const result = await gateUnscoredForScoring(new Set());

    expect(result.enqueueIds).toEqual(expect.arrayContaining(['solo-1', 'solo-2']));
    expect(result.enqueueIds).toHaveLength(2);
    expect(result.coveredIdsByRep).toEqual({
      'solo-1': ['solo-1'],
      'solo-2': ['solo-2'],
    });
    expect(result.heldBackCount).toBe(0);
    expect(result.propagatedCount).toBe(0);
    for (const id of ['solo-1', 'solo-2']) await expect(scoreOf(id)).resolves.toEqual(UNSCORED);
  });
});

// ===========================================================================
// gateUnscoredForScoring: country/language priority election (userCtx)
// ===========================================================================

describe('gateUnscoredForScoring: geo/language priority election', () => {
  // Home = USA (tier 0), one other country GBR (tier 1), app language fr (tier 2).
  const ctx: UserGeoLanguageContext = {
    homeCountryAlpha3: 'USA',
    otherCountriesAlpha3: ['GBR'],
    appLanguageBase: 'fr',
  };

  it('elects the HOME-country row over a has-description, newer sibling', async () => {
    await seedUnscored(
      { id: 'home', countryCode: 'USA', hasDescription: false, firstPubDateMs: 1_000 },
      { id: 'other', countryCode: null, languageCode: null, hasDescription: true, firstPubDateMs: 9_000 },
    );

    const result = await gateUnscoredForScoring(new Set(), ctx);

    expect(result.enqueueIds).toEqual(['home']); // tier 0 beats has-description + newest
    expect(result.heldBackCount).toBe(1);
  });

  it('elects an OTHER-user-country row over an app-language row', async () => {
    await seedUnscored(
      { id: 'other-country', countryCode: 'GBR', languageCode: 'de' },
      { id: 'app-lang', countryCode: null, languageCode: 'fr' },
    );

    const result = await gateUnscoredForScoring(new Set(), ctx);

    expect(result.enqueueIds).toEqual(['other-country']); // tier 1 beats tier 2
    expect(result.heldBackCount).toBe(1);
  });

  it('elects an APP-language row over a newer, tier-3 sibling', async () => {
    await seedUnscored(
      { id: 'app-lang', countryCode: null, languageCode: 'fr', firstPubDateMs: 1_000 },
      { id: 'rest', countryCode: null, languageCode: 'en', firstPubDateMs: 9_000 },
    );

    const result = await gateUnscoredForScoring(new Set(), ctx);

    expect(result.enqueueIds).toEqual(['app-lang']); // tier 2 beats tier 3 despite newer sibling
    expect(result.heldBackCount).toBe(1);
  });

  it('preserves legacy election (description → newest) when userCtx is null', async () => {
    await seedUnscored(
      { id: 'home', countryCode: 'USA', hasDescription: false, firstPubDateMs: 9_000 },
      { id: 'described', countryCode: null, hasDescription: true, firstPubDateMs: 1_000 },
    );

    // No userCtx → every tier collapses to 3 → legacy tiebreaks decide.
    const result = await gateUnscoredForScoring(new Set());

    expect(result.enqueueIds).toEqual(['described']); // has-description wins, geo ignored
    expect(result.heldBackCount).toBe(1);
  });
});

// ===========================================================================
// gateUnscoredForScoring: in-flight exclusion + empties + fail-open
// ===========================================================================

describe('gateUnscoredForScoring: in-flight + edge cases', () => {
  it('excludes in-flight ids from the candidate set', async () => {
    await seedUnscored(lone('in-flight'), lone('fresh'));

    const result = await gateUnscoredForScoring(new Set(['in-flight']));

    expect(result.enqueueIds).toEqual(['fresh']);
    await expect(scoreOf('in-flight')).resolves.toEqual(UNSCORED);
  });

  it('returns empty result and never queries donors when there are no candidates', async () => {
    const queries = queryCount();

    const result = await gateUnscoredForScoring(new Set());

    expect(result).toEqual({
      enqueueIds: [],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: {},
      readCount: 0,
    });
    // One read of the table (the unscored rows); the donor lookup never ran.
    expect(queries).toHaveBeenCalledTimes(1);
  });

  it('fails open: on a DB throw, enqueues all candidate ids and propagates nothing', async () => {
    await seedUnscored(lone('x'), lone('y'));
    failDonorRead();

    const result = await gateUnscoredForScoring(new Set());

    expect(result.propagatedCount).toBe(0);
    expect(result.heldBackCount).toBe(0);
    // Row order out of the table is not a contract, so compare sorted.
    expect([...result.enqueueIds].sort()).toEqual(['x', 'y']);
    // No election happened, so every id covers exactly itself.
    expect(result.coveredIdsByRep).toEqual({ x: ['x'], y: ['y'] });
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      { tags: { module: 'score-propagation' } },
    );
  });

  it('mixes propagation, election, and singletons across disjoint groups in one gate pass', async () => {
    const cA = [{ clusterId: 'cA', confidence: 0.9 }];
    const cB = [{ clusterId: 'cB', confidence: 0.9 }];
    // Group A (cluster cA): 1 candidate that will inherit a donor's score.
    await seedUnscored({ id: 'a-cand', clusters: cA });
    // Group B (cluster cB): 2 candidates, no donor → elect one.
    await seedUnscored(
      { id: 'b1', clusters: cB, hasDescription: true, firstPubDateMs: 5_000 },
      { id: 'b2', clusters: cB, hasDescription: true, firstPubDateMs: 1_000 },
    );
    // Group C: donor-less singleton.
    await seedUnscored(lone('c-solo'));
    await seedScored({ id: 'a-donor', clusters: cA }, { relevance: 0.7, reason: 'why' });

    const result = await gateUnscoredForScoring(new Set());

    await expect(scoreOf('a-cand')).resolves.toEqual({
      relevance: 0.7,
      reason: 'why',
      status: ArticleSuggestionStatus.Complete,
    });
    expect(result.propagatedCount).toBe(1);
    expect(result.heldBackCount).toBe(1); // b2 held back
    expect(result.enqueueIds).toEqual(expect.arrayContaining(['b1', 'c-solo']));
    expect(result.enqueueIds).toHaveLength(2);
  });
});

// ===========================================================================
// propagateToUnscoredSiblings: propagation only, no election
// ===========================================================================

// Titles share no token and every row has its own cluster: only the story key can join them.
describe('story key: a propagation-grade edge', () => {
  const copy = (id: string, title: string, storyKey: string | null) =>
    lone(id, { title, storyKey });

  it('copies relevance AND note across a shared key (grounding is one shared token, not a guard)', async () => {
    await seedScored(copy('donor', 'Koningin Maxima bezoekt Utrecht', 'K1'), {
      relevance: 0.8,
      reason: 'old reason',
    });
    await seedUnscored(copy('c1', 'Royal visit draws crowds', 'K1'), copy('c2', 'Monarch tours city hall', 'K1'));

    const result = await gateUnscoredForScoring(new Set());

    const expected = { relevance: 0.8, reason: 'old reason', status: ArticleSuggestionStatus.Complete };
    await expect(scoreOf('c1')).resolves.toEqual(expected);
    await expect(scoreOf('c2')).resolves.toEqual(expected);
    expect(result.enqueueIds).toEqual([]);
  });

  it('never joins null or empty keys', async () => {
    await seedScored(copy('donor', 'Koningin Maxima bezoekt Utrecht', null), {
      relevance: 0.8,
      reason: 'old reason',
    });
    await seedUnscored(copy('c1', 'Royal visit draws crowds', null), copy('c2', 'Monarch tours city hall', ''));

    const result = await gateUnscoredForScoring(new Set());

    await expect(scoreOf('c1')).resolves.toEqual(UNSCORED);
    await expect(scoreOf('c2')).resolves.toEqual(UNSCORED);
    expect([...result.enqueueIds].sort()).toEqual(['c1', 'c2']);
  });
});

describe('propagateToUnscoredSiblings', () => {
  it('copies a fresh donor score onto unscored siblings and returns the count', async () => {
    await seedUnscored({ id: 'cand-1' }, { id: 'cand-2' });
    await seedScored({ id: 'donor' }, { relevance: 0.9, reason: 'r' });

    const n = await propagateToUnscoredSiblings(new Set());

    expect(n).toBe(2);
    const expected = { relevance: 0.9, reason: 'r', status: ArticleSuggestionStatus.Complete };
    await expect(scoreOf('cand-1')).resolves.toEqual(expected);
    await expect(scoreOf('cand-2')).resolves.toEqual(expected);
  });

  it('does NOT elect or enqueue anything for donor-less groups (returns 0, no write)', async () => {
    await seedUnscored({ id: 'a' }, { id: 'b' }); // no donors

    const n = await propagateToUnscoredSiblings(new Set());

    expect(n).toBe(0);
    await expect(scoreOf('a')).resolves.toEqual(UNSCORED);
    await expect(scoreOf('b')).resolves.toEqual(UNSCORED);
  });

  it('excludes in-flight ids and short-circuits when no candidates remain', async () => {
    await seedUnscored({ id: 'busy' });
    const queries = queryCount();

    const n = await propagateToUnscoredSiblings(new Set(['busy']));

    expect(n).toBe(0);
    // One read of the table (the unscored rows); the donor lookup never ran.
    expect(queries).toHaveBeenCalledTimes(1);
    await expect(scoreOf('busy')).resolves.toEqual(UNSCORED);
  });

  it('fails open to 0 on a DB throw', async () => {
    await seedUnscored({ id: 'a' });
    failDonorRead();

    const n = await propagateToUnscoredSiblings(new Set());

    expect(n).toBe(0);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      { tags: { module: 'score-propagation' } },
    );
  });
});

// ===========================================================================
// gateUnscoredForScoring: already-read exclusion (relevance v3 §3)
// ===========================================================================

describe('gateUnscoredForScoring: already-read exclusion', () => {
  const open = (articleId: string, over: { stableClusterId?: string | null; titleNorm?: string | null } = {}) =>
    recordOpen({ articleId, surface: 'feed', ...over });

  it('drops a candidate whose article id was already opened, and marks it already_read', async () => {
    await seedUnscored(
      lone('read-1', { title: 'Something the user opened' }),
      lone('fresh-1', { title: 'A wholly different item' }),
    );
    await open('read-1');

    const result = await gateUnscoredForScoring(new Set());

    expect(result.readCount).toBe(1);
    expect(result.enqueueIds).toEqual(['fresh-1']);
    expect(result.coveredIdsByRep).toEqual({ 'fresh-1': ['fresh-1'] });
    expect((await suggestionRow('read-1')).status).toBe(ArticleSuggestionStatus.AlreadyRead);
  });

  it('drops a re-serve matched only by title, while a new development still enqueues', async () => {
    await seedUnscored(
      // Same story, new article id + new cluster generation: only the title gives it away.
      lone('reserve', { title: 'Anthropic launches Claude Opus for enterprise customers today' }),
      lone('development', { title: 'Anthropic faces EU antitrust probe model pricing' }),
    );
    await open('some-other-id', { titleNorm: 'anthropic launches claude opus for enterprise customers' });

    const result = await gateUnscoredForScoring(new Set());

    expect(result.readCount).toBe(1);
    expect(result.enqueueIds).toEqual(['development']);
  });

  it('does not match on stable_cluster_id alone: a new headline in a read story stays', async () => {
    await seedUnscored({
      id: 'fringe',
      title: 'Unrelated headline text',
      clusters: [{ clusterId: 'c-fringe', confidence: 1e-38, stableClusterId: 'story-7' }],
    });
    await open('other', { stableClusterId: 'story-7' });

    const result = await gateUnscoredForScoring(new Set());

    expect(result.readCount).toBe(0);
    expect(result.enqueueIds).toEqual(['fringe']);
  });

  it('never lets an already-read row donate to or represent its siblings', async () => {
    // Both rows share `c1` (the default) so they form ONE group; the read one
    // must be gone BEFORE election, leaving the sibling to be scored on its
    // own merits rather than inheriting a read story's fate.
    await seedUnscored(
      { id: 'read-rep', title: 'Shared story headline' },
      { id: 'sibling', title: 'Shared story headline' },
    );
    await open('read-rep');

    const result = await gateUnscoredForScoring(new Set());

    expect(result.readCount).toBe(1);
    expect(result.enqueueIds).toEqual(['sibling']);
    expect(result.heldBackCount).toBe(0);
  });

  it('returns early (no donor query) when every candidate was already read', async () => {
    await seedUnscored(lone('read-1'));
    await open('read-1');
    const queries = queryCount();

    const result = await gateUnscoredForScoring(new Set());

    expect(result).toEqual({
      enqueueIds: [],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: {},
      readCount: 1,
    });
    // One read of the table (the unscored rows); the donor lookup never ran.
    expect(queries).toHaveBeenCalledTimes(1);
  });

  it('ignores impressions that were never opened', async () => {
    await seedUnscored(lone('cand'));
    await seedViewOnlyImpression('cand');

    const result = await gateUnscoredForScoring(new Set());

    expect(result.readCount).toBe(0);
    expect(result.enqueueIds).toEqual(['cand']);
  });

  it('fail-open after the read gate never re-enqueues a row it just wrote terminal', async () => {
    await seedUnscored(lone('read-1'), lone('fresh-1'));
    await open('read-1');
    failDonorRead();

    const result = await gateUnscoredForScoring(new Set());

    expect(result.enqueueIds).toEqual(['fresh-1']);
    expect(result.coveredIdsByRep).toEqual({ 'fresh-1': ['fresh-1'] });
    expect((await suggestionRow('read-1')).status).toBe(ArticleSuggestionStatus.AlreadyRead);
  });
});
