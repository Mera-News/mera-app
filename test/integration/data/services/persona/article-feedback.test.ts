// article-feedback-service: the local log of verdict taps (like / dislike), on the real in-memory DB.
// D15: a BARE verdict is provisional and born processed (reaped at write); a verdict the user explained
// and committed is handed to the digest; `processed_at IS NULL` is the digest's whole filter, so the
// real WHERE clause is under test. Un-voting reverts exactly what the verdict's leaf applied.
// Replaces the mocked article-feedback-service / -committed / -revert suites.
import { applyPersonaAction } from '@/lib/database/services/persona-action-executor';
import {
  countUnprocessedFeedback,
  getArticleVerdict,
  getUnprocessedFeedback,
  hasLiked,
  markFeedbackProcessed,
  markFeedbackProcessedFor,
  recordArticleFeedback,
  recordFeedbackChangeLogIds,
  recordVerdictFeedback,
  removeArticleFeedback,
  updateFeedbackContextPath,
  type ArticleFeedbackSentiment,
} from '@/lib/database/services/article-feedback-service';
import { getAll as allSuppressions } from '@/lib/database/services/suppression-service';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import {
  MIN,
  NOON,
  freezeClock,
  failTableQuery,
  logRow,
  logsOf,
  quietLogger,
  resetPersonaMemory,
  restoreFaults,
  rowById,
  rowsOf,
  seedArticles,
  seedInterest,
  settleWrites,
  statuses,
} from './support';

const A = ACTION_NAMES;

let logs: ReturnType<typeof quietLogger>;
beforeEach(() => {
  logs = quietLogger();
  resetPersonaMemory();
  freezeClock(NOON);
});
afterEach(async () => {
  restoreFaults();
  await settleWrites();
  logs.restore();
});

const feedback = () => rowsOf('article_feedback');
const feedbackFor = async (articleId: string, sentiment?: string) =>
  (await feedback()).filter((r) => r.articleId === articleId && (sentiment == null || r.sentiment === sentiment));
const tap = (articleId: string, sentiment: ArticleFeedbackSentiment, contextJson?: string | null) =>
  recordArticleFeedback({ articleId, sentiment, title: `Title ${articleId}`, contextJson });
const COMMITTED_CTX = '{"treePath":["suggestion","wrong_topic"]}';
const ctxOf = async (articleId: string, sentiment: string) => JSON.parse((await feedbackFor(articleId, sentiment))[0].contextJson);
const unprocessedIds = async () => (await getUnprocessedFeedback()).map((r) => r.articleId);

// ---------------------------------------------------------------------------
// recordArticleFeedback
// ---------------------------------------------------------------------------

describe('recordArticleFeedback', () => {
  it('stores the tap with its origin, surface and context snapshot (schema v38)', async () => {
    await recordArticleFeedback({
      articleId: ' a1 ',
      suggestionId: 's1',
      sentiment: 'dislike',
      title: 'Great Article',
      origin: 'article',
      surface: 'explore',
      contextJson: '{"scopeKey":"city:IND:mumbai"}',
    });

    const [row] = await feedback();
    expect(row).toMatchObject({
      articleId: 'a1',
      suggestionId: 's1',
      sentiment: 'dislike',
      title: 'Great Article',
      origin: 'article',
      surface: 'explore',
      contextJson: '{"scopeKey":"city:IND:mumbai"}',
    });
    expect(row.createdAt.getTime()).toBe(NOON);
  });

  it('legacy callers: suggestionId, origin, surface and context default to null', async () => {
    await tap('a1', 'like');

    expect((await feedback())[0]).toMatchObject({ suggestionId: null, origin: null, surface: null, contextJson: null });
  });

  it('a blank articleId writes nothing', async () => {
    await tap('', 'like');
    await tap('   ', 'like');

    expect(await feedback()).toEqual([]);
  });

  it('is idempotent per (articleId, sentiment) but allows the other sentiment alongside', async () => {
    await tap('a1', 'like');
    await tap('a1', 'like');
    await tap('a1', 'dislike');

    expect((await feedback()).map((r) => r.sentiment).sort()).toEqual(['dislike', 'like']);
  });

  it("the deprecated 'improve' sentiment still round-trips, but is invisible to the digest queries", async () => {
    await tap('a1', 'improve', COMMITTED_CTX);

    expect(await feedbackFor('a1', 'improve')).toHaveLength(1);
    expect((await feedbackFor('a1', 'improve'))[0].processedAt).toBeNull();
    expect(await unprocessedIds()).toEqual([]);
    expect(await countUnprocessedFeedback()).toBe(0);
  });

  it('captures and swallows a storage failure', async () => {
    failTableQuery('article_feedback');

    await expect(tap('a1', 'like')).resolves.toBeUndefined();

    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { service: 'article-feedback', method: 'record' } });
  });
});

describe('D15: a bare verdict is reaped at write', () => {
  it('stamps processed_at NOW when the verdict carries no tree path', async () => {
    await tap('a1', 'dislike', '{"publication":"The Hindu","category":"Politics"}');

    expect((await feedback())[0].processedAt).toBe(NOON);
    expect(await unprocessedIds()).toEqual([]);
  });

  it('leaves processed_at NULL when the verdict already carries a tree path', async () => {
    await tap('a1', 'like', '{"treePath":["more_about_topic","a_lot_more"]}');

    expect((await feedback())[0].processedAt).toBeNull();
    expect(await unprocessedIds()).toEqual(['a1']);
  });

  it.each([['{"treePath":[]}'], ['not json'], [null], ['{"treePath":"x"}'], ['[]']])('context %j counts as no context', async (ctx) => {
    await tap('a1', 'like', ctx);

    expect((await feedback())[0].processedAt).toBe(NOON);
  });
});

// ---------------------------------------------------------------------------
// removeArticleFeedback / hasLiked
// ---------------------------------------------------------------------------

describe('removeArticleFeedback / hasLiked', () => {
  it('destroys exactly the (articleId, sentiment) row, leaving the other sentiment and other articles', async () => {
    await tap('a1', 'like');
    await tap('a1', 'dislike');
    await tap('a2', 'like');

    await removeArticleFeedback('a1', 'like');

    expect((await feedback()).map((r) => `${r.articleId}:${r.sentiment}`).sort()).toEqual(['a1:dislike', 'a2:like']);
  });

  it('is a no-op for a blank id or when nothing matches', async () => {
    await tap('a1', 'like');

    await removeArticleFeedback('', 'like');
    await removeArticleFeedback('   ', 'like');
    await removeArticleFeedback('a1', 'dislike');
    await removeArticleFeedback('nope', 'like');

    expect(await feedback()).toHaveLength(1);
    expect(await logsOf('revert_change')).toEqual([]);
  });

  it('captures and swallows a storage failure', async () => {
    failTableQuery('article_feedback');

    await expect(removeArticleFeedback('a1', 'like')).resolves.toBeUndefined();

    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { service: 'article-feedback', method: 'remove' } });
  });

  it('hasLiked is true only for a like on that article', async () => {
    await tap('a1', 'dislike');
    expect(await hasLiked('a1')).toBe(false);
    expect(await hasLiked('')).toBe(false);
    expect(await hasLiked('   ')).toBe(false);

    await tap('a1', 'like');

    expect(await hasLiked('a1')).toBe(true);
    expect(await hasLiked(' a1 ')).toBe(true);
    expect(await hasLiked('a2')).toBe(false);
  });

  it('hasLiked returns false and captures on a storage failure', async () => {
    failTableQuery('article_feedback');

    expect(await hasLiked('a1')).toBe(false);
    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { service: 'article-feedback', method: 'hasLiked' } });
  });
});

// ---------------------------------------------------------------------------
// recordVerdictFeedback: latest wins
// ---------------------------------------------------------------------------

describe('recordVerdictFeedback', () => {
  it('records a fresh verdict', async () => {
    await recordVerdictFeedback({ articleId: 'a1', suggestionId: 's1', sentiment: 'like', title: 'T', origin: 'suggestion', surface: 'swipe' });

    expect((await feedback())[0]).toMatchObject({ articleId: 'a1', sentiment: 'like', origin: 'suggestion', surface: 'swipe' });
  });

  it('removes the OPPOSITE sentiment first, so a card is never both liked and disliked', async () => {
    await recordVerdictFeedback({ articleId: 'a1', sentiment: 'dislike', title: 'T' });

    await recordVerdictFeedback({ articleId: 'a1', sentiment: 'like', title: 'T' });

    expect((await feedback()).map((r) => r.sentiment)).toEqual(['like']);
    expect(await hasLiked('a1')).toBe(true);
  });

  it('re-recording the same verdict is idempotent; a blank id is ignored', async () => {
    await recordVerdictFeedback({ articleId: 'a1', sentiment: 'like', title: 'T' });
    await recordVerdictFeedback({ articleId: 'a1', sentiment: 'like', title: 'T' });
    await recordVerdictFeedback({ articleId: '  ', sentiment: 'like', title: 'T' });

    expect(await feedback()).toHaveLength(1);
  });

  it('flipping the verdict reverts what the old verdict applied', async () => {
    const { topics } = await seedInterest('I follow F1', [{ text: 'formula 1', weight: 0.5 }]);
    await recordVerdictFeedback({ articleId: 'a1', sentiment: 'dislike', title: 'T' });
    const leaf = await applyPersonaAction({ action_type: A.SET_TOPIC_WEIGHT, topicId: topics[0].id, delta: -0.2 }, 'feedback');
    await recordFeedbackChangeLogIds('a1', 'dislike', [leaf.changeLogId!]);
    expect((await rowById('topics', topics[0].id)).weight).toBeCloseTo(0.3);

    await recordVerdictFeedback({ articleId: 'a1', sentiment: 'like', title: 'T' });

    expect((await rowById('topics', topics[0].id)).weight).toBeCloseTo(0.5);
    expect((await feedback()).map((r) => r.sentiment)).toEqual(['like']);
  });
});

// ---------------------------------------------------------------------------
// updateFeedbackContextPath and the committed flag
// ---------------------------------------------------------------------------

describe('updateFeedbackContextPath', () => {
  it('merges treePath into the existing snapshot, or builds one from NULL', async () => {
    await tap('a1', 'dislike', '{"relevance":0.5}');
    await tap('a2', 'like');

    await updateFeedbackContextPath('a1', 'dislike', ['n1', 'n2']);
    await updateFeedbackContextPath('a2', 'like', ['x']);

    expect(await ctxOf('a1', 'dislike')).toEqual({ relevance: 0.5, treePath: ['n1', 'n2'] });
    expect(await ctxOf('a2', 'like')).toEqual({ treePath: ['x'] });
  });

  it('overwrites a corrupt snapshot with a fresh one', async () => {
    await tap('a1', 'dislike', '{broken');

    await updateFeedbackContextPath('a1', 'dislike', ['x']);

    expect(await ctxOf('a1', 'dislike')).toEqual({ treePath: ['x'] });
  });

  it('is a no-op for a blank id or when no matching row exists', async () => {
    await tap('a1', 'like');

    await updateFeedbackContextPath('', 'like', ['x']);
    await updateFeedbackContextPath('a1', 'dislike', ['x']);

    expect((await feedback())[0].contextJson).toBeNull();
  });

  it('does NOT mark a branch descent committed (navigating is not voting)', async () => {
    await tap('a1', 'dislike', '{"publication":"The Hindu"}');

    await updateFeedbackContextPath('a1', 'dislike', ['not_important_to_me']);

    expect((await ctxOf('a1', 'dislike')).committed).toBeUndefined();
    expect(await getArticleVerdict('a1')).toEqual({ verdict: 'dislike', path: ['not_important_to_me'], committed: false });
  });

  it('keeps an abandoned descent REAPED: the digest never sees it', async () => {
    await tap('a1', 'dislike');

    await updateFeedbackContextPath('a1', 'dislike', ['suggestion', 'seen_already']);

    expect((await feedback())[0].processedAt).toBe(NOON);
    expect(await unprocessedIds()).toEqual([]);
  });

  it('a COMMITTED terminal leaf re-opens the row for the digest and flags it', async () => {
    await tap('a1', 'dislike');

    await updateFeedbackContextPath('a1', 'dislike', ['suggestion', 'wrong_topic'], true);

    expect((await feedback())[0].processedAt).toBeNull();
    expect((await ctxOf('a1', 'dislike')).committed).toBe(true);
    expect(await unprocessedIds()).toEqual(['a1']);
    expect((await getArticleVerdict('a1')).committed).toBe(true);
  });

  it('committed is STICKY: walking back up the breadcrumb neither un-fills the thumb nor re-reaps the row', async () => {
    await tap('a1', 'dislike');
    await updateFeedbackContextPath('a1', 'dislike', ['x', 'y'], true);

    await updateFeedbackContextPath('a1', 'dislike', ['publication_content']);
    expect(await ctxOf('a1', 'dislike')).toEqual({ treePath: ['publication_content'], committed: true });
    expect((await feedback())[0].processedAt).toBeNull();

    await updateFeedbackContextPath('a1', 'dislike', []);
    expect((await ctxOf('a1', 'dislike')).committed).toBe(true);
    expect(await unprocessedIds()).toEqual(['a1']);
  });

  it('never writes committed:false: an uncommitted snapshot keeps its old shape', async () => {
    await tap('a1', 'dislike', '{"relevance":0.5}');

    await updateFeedbackContextPath('a1', 'dislike', ['n1'], false);

    expect(await ctxOf('a1', 'dislike')).toEqual({ relevance: 0.5, treePath: ['n1'] });
  });

  it('puts an UNCOMMITTED row back to provisional when its path is cleared', async () => {
    await tap('a1', 'dislike', '{"treePath":["suggestion"]}');
    expect((await feedback())[0].processedAt).toBeNull();

    await updateFeedbackContextPath('a1', 'dislike', []);

    expect((await feedback())[0].processedAt).toBe(NOON);
  });

  it('captures and swallows a storage failure', async () => {
    failTableQuery('article_feedback');

    await expect(updateFeedbackContextPath('a1', 'like', ['x'])).resolves.toBeUndefined();

    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { service: 'article-feedback', method: 'updateContextPath' } });
  });
});

// ---------------------------------------------------------------------------
// getArticleVerdict
// ---------------------------------------------------------------------------

describe('getArticleVerdict', () => {
  it('reports no verdict for a blank id, an unknown article, or a deprecated sentiment', async () => {
    await tap('a1', 'improve');

    expect(await getArticleVerdict('')).toEqual({ verdict: null, path: [] });
    expect(await getArticleVerdict('nope')).toEqual({ verdict: null, path: [] });
    expect(await getArticleVerdict('a1')).toEqual({ verdict: null, path: [] });
  });

  it('a bare verdict is committed:false with an empty path; corrupt json does not throw', async () => {
    await tap('a1', 'dislike');
    await tap('a2', 'dislike', '{not json');

    expect(await getArticleVerdict('a1')).toEqual({ verdict: 'dislike', path: [], committed: false });
    expect(await getArticleVerdict('a2')).toEqual({ verdict: 'dislike', path: [], committed: false });
  });

  it('restores the stored path, dropping non-strings', async () => {
    await tap('a1', 'like', '{"treePath":["a",3,null,"b"]}');

    expect((await getArticleVerdict('a1')).path).toEqual(['a', 'b']);
  });

  it('a stray both-present state prefers like', async () => {
    await tap('a1', 'dislike');
    await tap('a1', 'like');

    expect((await getArticleVerdict('a1')).verdict).toBe('like');
  });

  it('returns no verdict and captures on a storage failure', async () => {
    failTableQuery('article_feedback');

    expect(await getArticleVerdict('a1')).toEqual({ verdict: null, path: [] });
    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { service: 'article-feedback', method: 'getArticleVerdict' } });
  });
});

// ---------------------------------------------------------------------------
// The digest's queries: processed_at IS NULL, like|dislike, newest first
// ---------------------------------------------------------------------------

describe('getUnprocessedFeedback / countUnprocessedFeedback', () => {
  async function seedMixed() {
    await tap('old-open', 'dislike', COMMITTED_CTX); // unprocessed
    jest.setSystemTime(NOON + MIN);
    await tap('bare', 'dislike'); // reaped at write
    jest.setSystemTime(NOON + 2 * MIN);
    await tap('new-open', 'like', COMMITTED_CTX); // unprocessed
    jest.setSystemTime(NOON + 3 * MIN);
    await tap('done', 'like', COMMITTED_CTX);
    await markFeedbackProcessedFor('done', 'like'); // folded in by the digest or chat
    jest.setSystemTime(NOON + 4 * MIN);
    await tap('legacy', 'improve', COMMITTED_CTX); // unprocessed, but not a verdict
  }

  it('lists only unprocessed like|dislike rows, newest first', async () => {
    await seedMixed();

    expect(await unprocessedIds()).toEqual(['new-open', 'old-open']);
  });

  it('counts exactly the rows it lists', async () => {
    await seedMixed();

    expect(await countUnprocessedFeedback()).toBe(2);
  });

  it('is empty / zero with no rows', async () => {
    expect(await unprocessedIds()).toEqual([]);
    expect(await countUnprocessedFeedback()).toBe(0);
  });

  it('returns empty / zero and captures on a storage failure', async () => {
    failTableQuery('article_feedback');

    expect(await unprocessedIds()).toEqual([]);
    expect(await countUnprocessedFeedback()).toBe(0);
    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { service: 'article-feedback', method: 'getUnprocessed' } });
    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { service: 'article-feedback', method: 'countUnprocessed' } });
  });
});

describe('markFeedbackProcessed / markFeedbackProcessedFor', () => {
  it('markFeedbackProcessed stamps exactly the given rows, which then leave the digest queue', async () => {
    await tap('a1', 'like', COMMITTED_CTX);
    await tap('a2', 'dislike', COMMITTED_CTX);
    await tap('a3', 'like', COMMITTED_CTX);
    const [a1, a2] = [(await feedbackFor('a1'))[0], (await feedbackFor('a2'))[0]];
    jest.setSystemTime(NOON + MIN);

    await markFeedbackProcessed([a1.id, '', a2.id, 'ghost']);

    expect((await feedbackFor('a1'))[0].processedAt).toBe(NOON + MIN);
    expect((await feedbackFor('a2'))[0].processedAt).toBe(NOON + MIN);
    expect((await feedbackFor('a3'))[0].processedAt).toBeNull();
    expect(await unprocessedIds()).toEqual(['a3']);
  });

  it('markFeedbackProcessed is a no-op for an empty / blank / unknown list', async () => {
    await tap('a1', 'like', COMMITTED_CTX);

    await markFeedbackProcessed([]);
    await markFeedbackProcessed(['', '']);
    await markFeedbackProcessed(['ghost']);

    expect(await unprocessedIds()).toEqual(['a1']);
  });

  it('markFeedbackProcessedFor stamps only the matching (articleId, sentiment) row', async () => {
    await tap('a1', 'like', COMMITTED_CTX);
    await tap('a1', 'dislike', COMMITTED_CTX);
    await tap('a2', 'like', COMMITTED_CTX);

    await markFeedbackProcessedFor('a1', 'like');

    expect((await feedbackFor('a1', 'like'))[0].processedAt).toBe(NOON);
    expect((await feedbackFor('a1', 'dislike'))[0].processedAt).toBeNull();
    expect((await feedbackFor('a2', 'like'))[0].processedAt).toBeNull();
  });

  it('markFeedbackProcessedFor is a no-op for a blank id or no match, and swallows a storage failure', async () => {
    await tap('a1', 'like', COMMITTED_CTX);

    await markFeedbackProcessedFor('  ', 'like');
    await markFeedbackProcessedFor('a1', 'dislike');
    expect(await unprocessedIds()).toEqual(['a1']);

    failTableQuery('article_feedback');
    await expect(markFeedbackProcessedFor('a1', 'like')).resolves.toBeUndefined();
    await expect(markFeedbackProcessed(['x'])).resolves.toBeUndefined();
    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { service: 'article-feedback', method: 'markProcessedFor' } });
    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { service: 'article-feedback', method: 'markProcessed' } });
  });
});

// ---------------------------------------------------------------------------
// recordFeedbackChangeLogIds and the un-vote revert
// ---------------------------------------------------------------------------

describe('recordFeedbackChangeLogIds', () => {
  it('merges the ids into the same snapshot as treePath', async () => {
    await tap('a1', 'dislike', '{"treePath":["suggestion","not_important"]}');

    await recordFeedbackChangeLogIds('a1', 'dislike', ['cl-1', 'cl-2']);

    expect(await ctxOf('a1', 'dislike')).toEqual({ treePath: ['suggestion', 'not_important'], changeLogIds: ['cl-1', 'cl-2'] });
  });

  it('ACCUMULATES across leaves, de-duplicating, and ignores blank ids', async () => {
    await tap('a1', 'dislike', '{"changeLogIds":["cl-1"],"treePath":["x"]}');

    await recordFeedbackChangeLogIds('a1', 'dislike', ['cl-1', '', 'cl-2']);

    expect((await ctxOf('a1', 'dislike')).changeLogIds).toEqual(['cl-1', 'cl-2']);
  });

  it('builds a snapshot from NULL or corrupt json', async () => {
    await tap('a1', 'dislike');
    await tap('a2', 'dislike', '{broken');

    await recordFeedbackChangeLogIds('a1', 'dislike', ['cl-1']);
    await recordFeedbackChangeLogIds('a2', 'dislike', ['cl-2']);

    expect(await ctxOf('a1', 'dislike')).toEqual({ changeLogIds: ['cl-1'] });
    expect(await ctxOf('a2', 'dislike')).toEqual({ changeLogIds: ['cl-2'] });
  });

  it('is a no-op for an empty list, a blank id, a missing row, and swallows a storage failure', async () => {
    await tap('a1', 'dislike');

    await recordFeedbackChangeLogIds('a1', 'dislike', []);
    await recordFeedbackChangeLogIds('  ', 'dislike', ['cl-1']);
    await recordFeedbackChangeLogIds('a1', 'like', ['cl-1']);
    expect((await feedback())[0].contextJson).toBeNull();

    failTableQuery('article_feedback');
    await expect(recordFeedbackChangeLogIds('a1', 'dislike', ['cl-1'])).resolves.toBeUndefined();
    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { service: 'article-feedback', method: 'recordChangeLogIds' } });
  });
});

describe('un-vote reverts the applied change', () => {
  it('reverts every stored change-log id and still deletes the row', async () => {
    const { topics } = await seedInterest('I follow F1', [{ text: 'formula 1', weight: 0.5 }]);
    await tap('a1', 'dislike', '{"treePath":["suggestion","not_important"]}');
    const nudge = await applyPersonaAction({ action_type: A.SET_TOPIC_WEIGHT, topicId: topics[0].id, delta: -0.15 }, 'feedback');
    const pin = await applyPersonaAction({ action_type: A.SET_HIGH_PRIORITY, topicId: topics[0].id, highPriority: true }, 'feedback');
    await recordFeedbackChangeLogIds('a1', 'dislike', [nudge.changeLogId!, pin.changeLogId!]);

    await removeArticleFeedback('a1', 'dislike');

    expect(await feedbackFor('a1')).toEqual([]);
    expect(await rowById('topics', topics[0].id)).toMatchObject({ highPriority: false });
    expect((await rowById('topics', topics[0].id)).weight).toBeCloseTo(0.5);
    expect((await logRow(nudge.changeLogId!)).reverted).toBe(true);
    expect((await logRow(pin.changeLogId!)).reverted).toBe(true);
    expect(await logsOf('revert_change')).toHaveLength(2);
  });

  it('reverts nothing for a verdict that never committed (no ids)', async () => {
    await tap('a1', 'dislike', '{"treePath":[]}');

    await removeArticleFeedback('a1', 'dislike');

    expect(await feedbackFor('a1')).toEqual([]);
    expect(await logsOf('revert_change')).toEqual([]);
  });

  it('PARTIAL failure: reverts what it can, never throws, deletes the row and logs the shortfall', async () => {
    const { topics } = await seedInterest('I follow F1', [{ text: 'formula 1', weight: 0.5 }]);
    await tap('a1', 'dislike', '{"treePath":["x"]}');
    const nudge = await applyPersonaAction({ action_type: A.SET_TOPIC_WEIGHT, topicId: topics[0].id, delta: -0.15 }, 'feedback');
    await recordFeedbackChangeLogIds('a1', 'dislike', ['no-such-change', nudge.changeLogId!]);

    await expect(removeArticleFeedback('a1', 'dislike')).resolves.toBeUndefined();

    expect(await feedbackFor('a1')).toEqual([]);
    expect((await rowById('topics', topics[0].id)).weight).toBeCloseTo(0.5); // the good id still reverted
    expect(logs.captureException).toHaveBeenCalledTimes(1);
    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'article-feedback', method: 'revertOnUnvote' },
      extra: { changeLogId: 'no-such-change', articleId: 'a1', sentiment: 'dislike' },
    });
    expect(logs.addBreadcrumb).toHaveBeenCalledWith(
      expect.stringContaining('reverted only part'),
      'article-feedback',
      { articleId: 'a1', sentiment: 'dislike', reverted: 1, total: 2 },
      'warning',
    );
  });

  it('a change that cannot be inverted (discard_fact) is the shortfall, not a crash', async () => {
    const { fact } = await seedInterest('Lives in Amsterdam', ['amsterdam']);
    await tap('a1', 'dislike', '{"treePath":["x"]}');
    const discard = await applyPersonaAction({ action_type: A.DISCARD_FACT, factId: fact.id }, 'feedback');
    await recordFeedbackChangeLogIds('a1', 'dislike', [discard.changeLogId!]);

    await removeArticleFeedback('a1', 'dislike');

    expect(await feedbackFor('a1')).toEqual([]);
    expect(await rowsOf('facts')).toEqual([]);
    expect((await logRow(discard.changeLogId!)).reverted).toBe(false);
    expect(logs.addBreadcrumb).toHaveBeenCalledWith(expect.any(String), 'article-feedback', expect.objectContaining({ reverted: 0, total: 1 }), 'warning');
  });

  it('un-voting a leaf that minted a hard filter retires it and releases the rows it had excluded', async () => {
    await seedArticles([
      { id: 'x1', title: 'Blether on the budget', publication: 'Daily Blether' },
      { id: 'x2', title: 'Budget day', publication: 'The Times' },
    ]);
    await tap('a1', 'dislike', '{"treePath":["publication_content"]}');
    const added = await applyPersonaAction(
      {
        action_type: A.ADD_SUPPRESSION,
        suppressionPattern: 'Daily Blether',
        suppressionKind: 'publication',
        suppressionValue: 'Daily Blether',
        suppressionStrength: 0.9,
      },
      'feedback',
    );
    expect(await statuses()).toEqual({ x1: 'excluded', x2: 'unscored' });
    await recordFeedbackChangeLogIds('a1', 'dislike', [added.changeLogId!]);
    expect((await ctxOf('a1', 'dislike')).changeLogIds).toEqual([added.changeLogId]);

    await removeArticleFeedback('a1', 'dislike');

    expect(await feedbackFor('a1')).toEqual([]);
    expect((await allSuppressions())[0].status).toBe('retired');
    expect(await statuses()).toEqual({ x1: 'unscored', x2: 'unscored' });
  });
});
