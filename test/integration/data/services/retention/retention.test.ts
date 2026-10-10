// Retention in saved-article-suggestion-service: a fact check and a followed story each keep their
// article openable after the 48h prune, in the same table as a user save. Everything runs on the
// in-memory DB over the real fact-check, tracked-story, topic and suggestion services, so the
// cross-reason checks read real rows instead of mocked answers.
//
// Replaces, from lib/database/services/__tests__/saved-article-suggestion-service.test.ts:
// keepArticleForFactCheck (8), deleteSavedSuggestion with live fact checks (4) and a live followed
// story (3), releaseFactCheckRetention (4), deleteOrphanedRetention (3), retention across two reasons
// (9; the Saved-screen-read and getSavedSuggestionWithKind cases are in saves.test.ts), and the
// delete pair of deleteSavedSuggestion.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

import database from '@/lib/database';
import {
  deleteFactCheck,
  listFactChecksForArticle,
  upsertFactCheck,
} from '@/lib/database/services/fact-check-record-service';
import {
  deleteOrphanedRetention,
  deleteSavedSuggestion,
  getSavedSuggestionByServerId,
  isSuggestionSaved,
  keepArticleForFactCheck,
  keepArticleForTrackedStory,
  loadSavedItems,
  releaseFactCheckRetention,
  releaseTrackedStoryRetention,
  saveStandaloneArticle,
  saveSuggestion,
} from '@/lib/database/services/saved-article-suggestion-service';
import { findActiveTrackedId, removeMemberSnapshot } from '@/lib/database/services/tracked-story-service';
import { getSavedOverride } from '@/lib/saved-state';
import logger from '@/lib/logger';
import { deleteTrackedStoryById, disownStoryMember, trackStoryWithProposal } from '@/lib/tracking/track-actions';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { useFakeClock } from '@/test/helpers';
import {
  failTableQuery,
  freshId,
  holdFirstFind,
  landSuggestion,
  originsById,
  resetRetentionMemory,
  restoreFaults,
  savedRow,
  savedRows,
  waitFor,
} from './support';

beforeEach(resetRetentionMemory);
afterEach(restoreFaults);

const captureException = logger.captureException as jest.Mock;

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const MIN = 60_000;

function newsArticle(id: string, over: Partial<NewsArticle> = {}): NewsArticle {
  return {
    _id: id,
    article_url: `https://example.com/${id}`,
    source_uri: `https://example.com/${id}`,
    title: 'Standalone Überschrift',
    title_en_internal_only: 'Standalone headline',
    description_en: 'desc en',
    image_url: 'https://example.com/s.jpg',
    original_language_code: 'de',
    pubDate: new Date(T0 - 5000).toISOString(),
    publicationSource: { _id: 'pub-1', publication_name: 'Die Zeit', country_code: 'DE' },
    ...over,
  } as NewsArticle;
}

const subject = (articleId: string): FeedbackSubject => ({
  origin: 'suggestion',
  surface: 'for_you',
  articleId,
  title: `Seed ${articleId}`,
  pubDate: new Date(T0 - 3_600_000).toISOString(),
  publicationName: 'Seed Pub',
});

/** A recorded fact check on one claim of the article. */
const factCheck = (articleId: string, claimKey = 'k1') =>
  upsertFactCheck({
    articleId,
    factCheckId: `fc-${articleId}-${claimKey}`,
    status: 'complete',
    verdict: 'supported',
    payload: { checkedBy: [{ organisation: 'Alt News' }] },
    claim: `claim ${claimKey}`,
    claimKey,
  });

/** Deletes every fact check record of an article WITHOUT releasing retention (the store does that). */
async function dropFactChecks(articleId: string): Promise<void> {
  for (const row of await listFactChecksForArticle(articleId)) await deleteFactCheck(row.id);
}

/** Follows a story seeded by `articleId`; the member is retained like a follow does. */
async function follow(articleId: string, searchText = `story ${articleId}`): Promise<string> {
  await trackStoryWithProposal(subject(articleId), { label: `Label ${searchText}`, searchText });
  return (await findActiveTrackedId({ articleId }))!;
}

describe('keepArticleForFactCheck / keepArticleForTrackedStory', () => {
  it('keep an article-keyed fact_check row from a full article, without publishing saved state or a save', async () => {
    useFakeClock(T0);
    const id = freshId();

    await keepArticleForFactCheck({ articleId: id, article: newsArticle(id) });

    expect(await savedRow(id)).toMatchObject({ id, articleId: id, origin: 'fact_check', savedAt: T0 });
    expect(await getSavedSuggestionByServerId(id)).toMatchObject({
      title_en: 'Standalone headline',
      publication_name: 'Die Zeit',
      article_url: `https://example.com/${id}`,
    });
    expect(getSavedOverride(id)).toBeUndefined();
    expect(await isSuggestionSaved(id)).toBe(false);
  });

  it('key a full SUGGESTION by the ARTICLE id, which is what the article-detail fallback looks up', async () => {
    const s = { ...(await landSuggestion(freshId())), _id: freshId('sugg') };

    await keepArticleForFactCheck({ articleId: s.articleId, suggestion: s });

    expect(await originsById()).toEqual({ [s.articleId]: 'fact_check' });
    expect(await getSavedSuggestionByServerId(s.articleId)).toMatchObject({ title_en: s.title_en, description_en: s.description_en });
  });

  it('build a degraded row from the server row fields when no full shape is in hand', async () => {
    const id = freshId();

    await keepArticleForFactCheck({ articleId: id, title: 'Server title', articleUrl: 'https://example.com/srv', publicationName: 'Server Pub' });

    expect(await getSavedSuggestionByServerId(id)).toMatchObject({
      _id: id,
      articleId: id,
      title_en: 'Server title',
      title_original: 'Server title',
      article_url: 'https://example.com/srv',
      publication_name: 'Server Pub',
      description_en: null,
      relevance: 0,
      clusters: [],
    });
    expect((await savedRow(id))!.origin).toBe('fact_check');
  });

  it('write a tracked_story row for the followed-story reason', async () => {
    const id = freshId();
    await keepArticleForTrackedStory({ articleId: id, title: 'Followed' });
    expect((await savedRow(id))!.origin).toBe('tracked_story');
  });

  it('bail only on a USER save: a saved suggestion and a saved article are left exactly as they were', async () => {
    useFakeClock(T0);
    const s = await landSuggestion(freshId());
    const art = freshId();
    await saveSuggestion(s);
    await saveStandaloneArticle(newsArticle(art));
    const before = await savedRows();
    jest.setSystemTime(T0 + MIN);

    await keepArticleForFactCheck({ articleId: s._id, suggestion: { ...s, title_en: 'Other title' } });
    await keepArticleForTrackedStory({ articleId: art, article: newsArticle(art, { title_en_internal_only: 'Other' } as never) });

    expect(await savedRows()).toEqual(before);
    expect((await getSavedSuggestionByServerId(s._id))!.title_en).toBe(s.title_en);
    expect((await originsById())[art]).toBe('article');
  });

  it('never let a degraded input overwrite an existing snapshot', async () => {
    const id = freshId();
    await keepArticleForFactCheck({ articleId: id, article: newsArticle(id) });

    await keepArticleForFactCheck({ articleId: id, title: 'Poorer title' });
    await keepArticleForTrackedStory({ articleId: id, title: 'Bare' });

    expect((await getSavedSuggestionByServerId(id))!.title_en).toBe('Standalone headline');
  });

  it('refresh an existing retention row from a full shape without bumping saved_at', async () => {
    useFakeClock(T0);
    const id = freshId();
    await keepArticleForFactCheck({ articleId: id, article: newsArticle(id, { title_en_internal_only: 'Old title' } as never) });
    jest.setSystemTime(T0 + 5 * MIN);

    await keepArticleForFactCheck({ articleId: id, article: newsArticle(id) });

    expect(await savedRow(id)).toMatchObject({ origin: 'fact_check', savedAt: T0 });
    expect((await getSavedSuggestionByServerId(id))!.title_en).toBe('Standalone headline');
  });

  it('upgrade a row the OTHER reason holds in place, and keep its origin rather than churn it', async () => {
    const s = await landSuggestion(freshId());
    await keepArticleForFactCheck({ articleId: s.articleId, title: 'Bare' });

    await keepArticleForTrackedStory({ articleId: s.articleId, suggestion: { ...s, description_en: 'Richer copy' } });

    expect(await savedRows()).toHaveLength(1);
    expect(await getSavedSuggestionByServerId(s.articleId)).toMatchObject({ description_en: 'Richer copy' });
    expect((await savedRow(s.articleId))!.origin).toBe('fact_check');
  });

  it('do nothing for a blank article id, and never throw when the write fails', async () => {
    await keepArticleForFactCheck({ articleId: '  ', title: 'x' });
    await keepArticleForTrackedStory({ articleId: '', title: 'x' });
    expect(await savedRows()).toEqual([]);

    const spy = jest.spyOn(database, 'write').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(keepArticleForFactCheck({ articleId: freshId(), title: 'x' })).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ method: 'keepArticleForRetention' }) }),
    );
    expect(await savedRows()).toEqual([]);
  });
});

describe('releasing a retention reason', () => {
  it('destroys the row once the last fact check is gone and nothing else holds it', async () => {
    const id = freshId();
    await keepArticleForFactCheck({ articleId: id, title: 'Checked' });
    await factCheck(id);
    await dropFactChecks(id);

    expect(await releaseFactCheckRetention(id)).toBe(true);
    expect(await savedRows()).toEqual([]);
  });

  it('keeps the row while another claim on the article still has a fact check', async () => {
    const id = freshId();
    await keepArticleForFactCheck({ articleId: id, title: 'Checked' });
    await factCheck(id, 'k1');
    await factCheck(id, 'k2');
    const [first] = await listFactChecksForArticle(id);
    await deleteFactCheck(first.id);

    expect(await releaseFactCheckRetention(id)).toBe(false);
    expect((await savedRow(id))!.origin).toBe('fact_check');

    await dropFactChecks(id);
    expect(await releaseFactCheckRetention(id)).toBe(true);
  });

  // THE data-loss guard. `origin` records one reason, so the release has to ask both.
  it('KEEPS the row when the fact check goes but the story still follows the article', async () => {
    const s = await landSuggestion(freshId());
    await keepArticleForFactCheck({ articleId: s.articleId, suggestion: s });
    await factCheck(s.articleId);
    await follow(s.articleId);
    expect(await originsById()).toEqual({ [s.articleId]: 'fact_check' });
    await dropFactChecks(s.articleId);

    expect(await releaseFactCheckRetention(s.articleId)).toBe(false);

    // still there, re-stamped to the reason that is still alive
    expect(await originsById()).toEqual({ [s.articleId]: 'tracked_story' });
    expect(await getSavedSuggestionByServerId(s.articleId)).not.toBeNull();
  });

  it('KEEPS the row when the story lets go but a fact check still holds the article', async () => {
    const s = await landSuggestion(freshId());
    const storyId = await follow(s.articleId);
    await factCheck(s.articleId);
    expect(await originsById()).toEqual({ [s.articleId]: 'tracked_story' });

    expect(await disownStoryMember(storyId, s.articleId)).toBe(true);

    expect(await originsById()).toEqual({ [s.articleId]: 'fact_check' });
  });

  it('destroys the row only once BOTH reasons have let go, in either order', async () => {
    const a = await landSuggestion(freshId());
    const b = await landSuggestion(freshId());
    // a: the fact check goes first. b: the story goes first.
    const storyA = await follow(a.articleId);
    await factCheck(a.articleId);
    const storyB = await follow(b.articleId);
    await factCheck(b.articleId);

    await dropFactChecks(a.articleId);
    expect(await releaseFactCheckRetention(a.articleId)).toBe(false);
    expect(await deleteTrackedStoryById(storyA)).toBe(true);

    expect(await deleteTrackedStoryById(storyB)).toBe(true);
    expect(await originsById()).toEqual({ [b.articleId]: 'fact_check' });
    await dropFactChecks(b.articleId);
    expect(await releaseFactCheckRetention(b.articleId)).toBe(true);

    expect(await savedRows()).toEqual([]);
  });

  it('never destroys a user save, whichever reason lets go', async () => {
    const id = freshId();
    await saveStandaloneArticle(newsArticle(id));
    await factCheck(id);
    await dropFactChecks(id);

    expect(await releaseFactCheckRetention(id)).toBe(false);
    expect(await releaseTrackedStoryRetention(id)).toBe(false);
    expect((await savedRow(id))!.origin).toBe('article');
    expect(await isSuggestionSaved(id)).toBe(true);
  });

  it('returns false for a blank id and for an article that holds no row', async () => {
    expect(await releaseFactCheckRetention('')).toBe(false);
    expect(await releaseTrackedStoryRetention('   ')).toBe(false);
    expect(await releaseFactCheckRetention(freshId())).toBe(false);
  });

  it('never throws when the destroying write fails, and reports that nothing was released', async () => {
    const id = freshId();
    await keepArticleForFactCheck({ articleId: id, title: 'Checked' });
    const spy = jest.spyOn(database, 'write').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(releaseFactCheckRetention(id)).resolves.toBe(false);
    } finally {
      spy.mockRestore();
    }

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ method: 'releaseRetention' }) }),
    );
    expect(await savedRow(id)).toBeDefined();
  });

  // DATA-U9-2. listFactChecksForArticle swallows a failed read and returns [], so on an unreadable
  // fact_checks table the release (and the un-save, and the sweep) read "no fact check holds this"
  // and destroy a row a fact check still needs. isTrackedStoryMember fails closed; this side does not.
  async function checkedRowWithUnreadableChecks() {
    const id = freshId();
    await keepArticleForFactCheck({ articleId: id, title: 'Checked' });
    await factCheck(id);
    failTableQuery('fact_checks');
    return id;
  }

  test('DATA-U9-2: an unreadable fact_checks table keeps the row on release (fails closed)', async () => {
    const id = await checkedRowWithUnreadableChecks();

    await releaseFactCheckRetention(id);

    expect(await savedRow(id)).toBeDefined();
  });
});

describe('un-saving (deleteSavedSuggestion)', () => {
  it('destroys the row and publishes false when nothing retains the article', async () => {
    const art = freshId();
    const s = await landSuggestion(freshId());
    await saveStandaloneArticle(newsArticle(art));
    await saveSuggestion(s);

    expect(await deleteSavedSuggestion(art)).toBe(true);
    expect(await deleteSavedSuggestion(s._id)).toBe(true);

    expect(await savedRows()).toEqual([]);
    expect(getSavedOverride(art)).toBe(false);
    expect(getSavedOverride(s._id)).toBe(false);
  });

  it('reports false for an id nothing holds, and still publishes false so a stale bookmark corrects itself', async () => {
    const id = freshId();
    expect(await deleteSavedSuggestion(id)).toBe(false);
    expect(getSavedOverride(id)).toBe(false);
    expect(await savedRows()).toEqual([]);
  });

  it('downgrades to fact_check instead of destroying while a fact check references the article', async () => {
    const id = freshId();
    await saveStandaloneArticle(newsArticle(id));
    await factCheck(id);

    expect(await deleteSavedSuggestion(id)).toBe(true);

    expect(await originsById()).toEqual({ [id]: 'fact_check' });
    // the un-save "works": off the Saved screen, bookmark cleared, still openable
    expect(await loadSavedItems()).toEqual([]);
    expect(await isSuggestionSaved(id)).toBe(false);
    expect(getSavedOverride(id)).toBe(false);
    expect(await getSavedSuggestionByServerId(id)).toMatchObject({ articleId: id });
  });

  it('downgrades to tracked_story while a followed story holds the article as a member', async () => {
    const s = await landSuggestion(freshId());
    await saveSuggestion({ ...s, _id: s.articleId }); // article-keyed save
    await follow(s.articleId);
    // the follow's keep bailed on the user save, so the row is still the save
    expect(await originsById()).toEqual({ [s.articleId]: 'suggestion' });

    expect(await deleteSavedSuggestion(s.articleId)).toBe(true);

    expect(await originsById()).toEqual({ [s.articleId]: 'tracked_story' });
  });

  it('stamps fact_check when both reasons hold, the precedence a release uses', async () => {
    const s = await landSuggestion(freshId());
    await saveSuggestion({ ...s, _id: s.articleId });
    await follow(s.articleId);
    await factCheck(s.articleId);

    expect(await deleteSavedSuggestion(s.articleId)).toBe(true);

    expect(await originsById()).toEqual({ [s.articleId]: 'fact_check' });
  });

  it('moves a suggestion-keyed save to an article-keyed retention row, snapshot and saved_at intact', async () => {
    useFakeClock(T0);
    const s = { ...(await landSuggestion(freshId())), _id: freshId('sugg') };
    await saveSuggestion(s);
    const savedAt = (await savedRow(s._id))!.savedAt;
    jest.setSystemTime(T0 + 10 * MIN);
    await factCheck(s.articleId);

    expect(await deleteSavedSuggestion(s._id)).toBe(true);

    // the suggestion-keyed row is gone, an article-keyed one carries the snapshot
    expect(await savedRows()).toEqual([{ id: s.articleId, articleId: s.articleId, origin: 'fact_check', savedAt }]);
    expect(await getSavedSuggestionByServerId(s._id)).toBeNull();
    expect(await getSavedSuggestionByServerId(s.articleId)).toMatchObject({
      _id: s.articleId,
      articleId: s.articleId,
      title_en: s.title_en,
      article_url: s.article_url,
      publication_name: s.publication_name,
      clusters: s.clusters,
    });
  });

  it('skips the move when an article-keyed row already exists, and leaves that row alone', async () => {
    const s = { ...(await landSuggestion(freshId())), _id: freshId('sugg') };
    await keepArticleForTrackedStory({ articleId: s.articleId, title: 'Retention copy' });
    await saveSuggestion(s);
    await factCheck(s.articleId);

    expect(await deleteSavedSuggestion(s._id)).toBe(true);

    expect(await savedRows()).toMatchObject([{ id: s.articleId, origin: 'tracked_story' }]);
    expect((await getSavedSuggestionByServerId(s.articleId))!.title_en).toBe('Retention copy');
  });
});

describe('the orphan sweep (deleteOrphanedRetention)', () => {
  it('destroys exactly the retention rows no reason holds, and counts them', async () => {
    const live = await landSuggestion(freshId());
    const story = await landSuggestion(freshId());
    const factOrphan = await landSuggestion(freshId());
    const storyOrphan = await landSuggestion(freshId());
    const userSave = freshId();
    // held by a fact check
    await keepArticleForFactCheck({ articleId: live.articleId, suggestion: live });
    await factCheck(live.articleId);
    // held by a followed story
    await follow(story.articleId);
    // a fact check that went without its release
    await keepArticleForFactCheck({ articleId: factOrphan.articleId, suggestion: factOrphan });
    await factCheck(factOrphan.articleId);
    await dropFactChecks(factOrphan.articleId);
    // a story member that went without its release
    const orphanStory = await follow(storyOrphan.articleId);
    expect(await removeMemberSnapshot(orphanStory, storyOrphan.articleId)).toBe(true);
    // a user save, which the sweep never touches
    await saveStandaloneArticle(newsArticle(userSave));

    expect(await deleteOrphanedRetention()).toBe(2);

    expect(Object.keys(await originsById()).sort()).toEqual([live.articleId, story.articleId, userSave].sort());
  });

  it('checks BOTH reasons per row whatever the row\'s own origin', async () => {
    const s = await landSuggestion(freshId());
    await keepArticleForFactCheck({ articleId: s.articleId, suggestion: s });
    await factCheck(s.articleId);
    await follow(s.articleId);
    await dropFactChecks(s.articleId); // stamped fact_check, but the story still holds it
    expect((await savedRow(s.articleId))!.origin).toBe('fact_check');

    expect(await deleteOrphanedRetention()).toBe(0);
    expect(await savedRows()).toHaveLength(1);

    const t = await landSuggestion(freshId());
    await keepArticleForTrackedStory({ articleId: t.articleId, suggestion: t });
    await factCheck(t.articleId); // stamped tracked_story, held only by a fact check
    expect(await deleteOrphanedRetention()).toBe(0);
  });

  it('returns 0 and changes nothing on an empty table or when every row is held', async () => {
    expect(await deleteOrphanedRetention()).toBe(0);
    const id = freshId();
    await keepArticleForFactCheck({ articleId: id, title: 'Checked' });
    await factCheck(id);
    const before = await savedRows();
    expect(await deleteOrphanedRetention()).toBe(0);
    expect(await savedRows()).toEqual(before);
  });

  it('never throws, and reports 0 when the saved table cannot be read', async () => {
    await keepArticleForFactCheck({ articleId: freshId(), title: 'Checked' });
    failTableQuery('saved_article_suggestions');

    await expect(deleteOrphanedRetention()).resolves.toBe(0);

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ method: 'deleteOrphanedRetention' }) }),
    );
  });

  // DATA-U9-1. listTrackedMemberArticleIds says it fails closed ("destroys nothing this pass") but
  // returns an EMPTY set when tracked_stories cannot be read, so a row only a followed story holds
  // looks orphaned and is destroyed. isTrackedStoryMember beside it does fail closed.
  async function storyHeldRowWithUnreadableStories() {
    const s = await landSuggestion(freshId());
    await follow(s.articleId);
    expect(await originsById()).toEqual({ [s.articleId]: 'tracked_story' });
    failTableQuery('tracked_stories');
    return s;
  }

  test('DATA-U9-1: an unreadable tracked_stories table destroys nothing (fails closed)', async () => {
    const s = await storyHeldRowWithUnreadableStories();

    await deleteOrphanedRetention();

    restoreFaults();
    expect(await originsById()).toEqual({ [s.articleId]: 'tracked_story' });
  });
});

describe('a keep racing a release (MERA-APP-81)', () => {
  it('reads the row inside the write, so a release queued behind it never leaves a deleted record to update', async () => {
    const s = await landSuggestion(freshId());
    await keepArticleForFactCheck({ articleId: s.articleId, suggestion: s });
    await factCheck(s.articleId);
    await dropFactChecks(s.articleId); // nothing holds the row now: a release will destroy it
    const gate = holdFirstFind('saved_article_suggestions');

    // The poll loop re-enters with a refreshed snapshot while the release for the deleted check runs.
    const keep = keepArticleForFactCheck({ articleId: s.articleId, suggestion: { ...s, title_en: 'Refreshed' } });
    await gate.reached;
    const release = releaseFactCheckRetention(s.articleId);
    // With the read inside the write the release waits behind it; read outside, it destroys the row here.
    await waitFor(async () => (await savedRow(s.articleId)) === undefined);
    gate.release();
    await keep;
    const destroyed = await release;

    expect(captureException).not.toHaveBeenCalled();
    expect(destroyed).toBe(true);
    // consistent end state: the release had the last word and nothing is left half-written
    expect(await savedRows()).toEqual([]);
  });

  it('a keep that finds the row already destroyed creates it afresh', async () => {
    const s = await landSuggestion(freshId());
    await keepArticleForFactCheck({ articleId: s.articleId, suggestion: s });
    expect(await releaseFactCheckRetention(s.articleId)).toBe(true);
    expect(await savedRows()).toEqual([]);

    await keepArticleForFactCheck({ articleId: s.articleId, suggestion: s });

    expect(await originsById()).toEqual({ [s.articleId]: 'fact_check' });
    expect(captureException).not.toHaveBeenCalled();
  });
});
