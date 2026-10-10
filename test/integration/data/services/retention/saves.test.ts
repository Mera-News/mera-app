// Saves and the Saved-screen reads of saved-article-suggestion-service, on the in-memory DB with the
// real services. Suggestions land the way feed-sync lands them (persistAndLinkV2Suggestions); the rows
// a service can no longer write (a pre-v38 NULL origin, a corrupt JSON column) go in through the real
// restore path, the only code that writes a row verbatim.
//
// Replaces, from lib/database/services/__tests__/saved-article-suggestion-service.test.ts: saveSuggestion
// (3), saveStandaloneArticle (3), loadSavedItems (3), isSuggestionSaved (2 + 2), getSavedSuggestionByServerId
// (5), loadSavedSuggestions (3), date parsing on save (2), the Saved-screen reads (3) and the
// getSavedSuggestionWithKind pair. Retention is in retention.test.ts.
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { deleteSuggestionsByServerIds } from '@/lib/database/services/article-suggestion-lifecycle';
import { getSuggestionByArticleId } from '@/lib/database/services/article-suggestion-reads';
import {
  getSavedSuggestionByServerId,
  getSavedSuggestionWithKind,
  isSuggestionSaved,
  keepArticleForFactCheck,
  keepArticleForTrackedStory,
  loadSavedItems,
  loadSavedSuggestions,
  saveStandaloneArticle,
  saveSuggestion,
} from '@/lib/database/services/saved-article-suggestion-service';
import { getSavedOverride } from '@/lib/saved-state';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { useFakeClock } from '@/test/helpers';
import {
  freshId,
  landSuggestion,
  rawSaved,
  resetRetentionMemory,
  restoreRows,
  savedRow,
  savedRows,
} from './support';

beforeEach(resetRetentionMemory);

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const MIN = 60_000;

function standalone(id: string, over: Partial<NewsArticle> = {}): NewsArticle {
  return {
    _id: id,
    article_url: `https://example.com/${id}`,
    source_uri: `https://example.com/${id}`,
    title: 'Standalone Überschrift',
    title_en: 'Public English title',
    title_en_internal_only: 'Standalone headline',
    description: 'desc',
    description_en: 'desc en',
    image_url: 'https://example.com/s.jpg',
    original_language_code: 'de',
    pubDate: new Date(T0 - 5000).toISOString(),
    publicationSource: { _id: 'pub-1', publication_name: 'Die Zeit', country_code: 'DE' },
    ...over,
  } as NewsArticle;
}

describe('saveSuggestion', () => {
  it('keys the row by the suggestion _id, stamps origin suggestion and reads every card field back', async () => {
    const s = {
      ...(await landSuggestion(freshId())),
      status: ArticleSuggestionStatus.Complete,
      relevance: 0.8,
      reason: 'Because you follow Berlin',
    };

    await saveSuggestion(s);

    const row = await savedRow(s._id);
    expect(row).toMatchObject({ id: s._id, articleId: s.articleId, origin: 'suggestion' });
    expect(await getSavedSuggestionByServerId(s._id)).toEqual({
      _id: s._id,
      articleId: s.articleId,
      clusters: s.clusters,
      relevance: 0.8,
      reason: 'Because you follow Berlin',
      status: ArticleSuggestionStatus.Complete,
      country_code: s.country_code,
      language_code: s.language_code,
      publication_name: s.publication_name,
      title_en: s.title_en,
      title_original: s.title_original,
      description_en: s.description_en,
      article_url: s.article_url,
      image_url: s.image_url,
      userTopicIds: s.userTopicIds,
      createdAt: new Date(s.createdAt).toISOString(),
      firstPubDate: new Date(s.firstPubDate).toISOString(),
      // The saved table has no column for the persona-v3 sectioning fields.
      rawScore: null,
      eventType: null,
      headlineScope: null,
      matchedTopics: [],
    });
    expect(await isSuggestionSaved(s._id)).toBe(true);
    // The bookmark flips on the same frame: the write path announces it.
    expect(getSavedOverride(s._id)).toBe(true);
  });

  it.each([
    [ArticleSuggestionStatus.Unscored, ArticleSuggestionStatus.Unscored],
    [ArticleSuggestionStatus.ReasonPending, ArticleSuggestionStatus.ReasonPending],
    [ArticleSuggestionStatus.Complete, ArticleSuggestionStatus.Complete],
  ])('maps status %s onto the table\'s two booleans and back to %s', async (status, back) => {
    const s = { ...(await landSuggestion(freshId())), status };
    await saveSuggestion(s);
    expect((await getSavedSuggestionByServerId(s._id))!.status).toBe(back);
  });

  it('a re-save keeps one row, refreshes the snapshot and stamps saved_at = now', async () => {
    useFakeClock(T0);
    const s = await landSuggestion(freshId());
    await saveSuggestion(s);
    expect((await savedRow(s._id))!.savedAt).toBe(T0);

    jest.setSystemTime(T0 + 5 * MIN);
    await saveSuggestion({ ...s, title_en: 'Updated headline', relevance: 0.95 });

    const rows = await savedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].savedAt).toBe(T0 + 5 * MIN);
    const back = (await getSavedSuggestionByServerId(s._id))!;
    expect(back.title_en).toBe('Updated headline');
    expect(back.relevance).toBe(0.95);
  });

  it('serialises missing clusters and topics as empty lists', async () => {
    const s = { ...(await landSuggestion(freshId())), clusters: undefined as never, userTopicIds: undefined as never };
    await saveSuggestion(s);
    const back = (await getSavedSuggestionByServerId(s._id))!;
    expect(back.clusters).toEqual([]);
    expect(back.userTopicIds).toEqual([]);
  });

  it('falls back to now for an unparseable createdAt / firstPubDate and accepts epoch milliseconds', async () => {
    useFakeClock(T0);
    const bad = { ...(await landSuggestion(freshId())), createdAt: 'not-a-date' as never, firstPubDate: 'also-bad' as never };
    await saveSuggestion(bad);
    const fromBad = (await getSavedSuggestionByServerId(bad._id))!;
    expect(new Date(fromBad.createdAt).getTime()).toBeGreaterThanOrEqual(T0);
    expect(new Date(fromBad.firstPubDate).getTime()).toBeGreaterThanOrEqual(T0);
    expect(Number.isNaN(new Date(fromBad.createdAt).getTime())).toBe(false);

    const numeric = { ...(await landSuggestion(freshId())), createdAt: T0 - 123_000 as never };
    await saveSuggestion(numeric);
    expect((await getSavedSuggestionByServerId(numeric._id))!.createdAt).toBe(new Date(T0 - 123_000).toISOString());
  });

  it('a saved row is a snapshot: it outlives the feed row it was taken from', async () => {
    const s = await landSuggestion(freshId());
    await saveSuggestion(s);
    await deleteSuggestionsByServerIds([s._id]);
    expect(await getSuggestionByArticleId(s.articleId)).toBeNull();

    const back = (await getSavedSuggestionByServerId(s._id))!;
    expect(back.article_url).toBe(s.article_url);
    expect(back.title_en).toBe(s.title_en);
  });
});

describe('saveStandaloneArticle', () => {
  it('keys the row by the article _id, stamps origin article and leaves the personalisation empty', async () => {
    const id = freshId();
    await saveStandaloneArticle(standalone(id), { surface: 'explore' });

    expect(await savedRow(id)).toMatchObject({ id, articleId: id, origin: 'article' });
    expect(getSavedOverride(id)).toBe(true);
    const items = await loadSavedItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      origin: 'article',
      savedId: id,
      savedAt: expect.any(Number),
      article: expect.objectContaining({
        _id: id,
        article_url: `https://example.com/${id}`,
        title: 'Standalone Überschrift',
        // the internal English title wins over the public one
        title_en: 'Standalone headline',
        description_en: 'desc en',
        image_url: 'https://example.com/s.jpg',
        original_language_code: 'de',
        pubDate: new Date(T0 - 5000).toISOString(),
        publicationSource: expect.objectContaining({ publication_name: 'Die Zeit', country_code: 'DE' }),
      }),
    });
    // as a suggestion it reads back unscored, with no clusters or topics
    expect(await getSavedSuggestionByServerId(id)).toMatchObject({
      relevance: 0,
      reason: '',
      status: ArticleSuggestionStatus.Unscored,
      clusters: [],
      userTopicIds: [],
    });
  });

  it('falls back to the public English title, and to no publication, when the article carries neither', async () => {
    const id = freshId();
    await saveStandaloneArticle(
      standalone(id, { title_en_internal_only: undefined, publicationSource: undefined, article_url: undefined } as never),
    );
    const [item] = await loadSavedItems();
    expect(item).toMatchObject({ origin: 'article' });
    if (item.origin !== 'article') throw new Error('unreachable');
    expect(item.article.title_en).toBe('Public English title');
    expect(item.article.publicationSource).toBeUndefined();
    // source_uri stands in for the missing article_url
    expect(item.article.article_url).toBe(`https://example.com/${id}`);
  });

  it('does nothing for an article with no _id', async () => {
    await saveStandaloneArticle(standalone(''));
    await saveStandaloneArticle(standalone('   '));
    await saveStandaloneArticle(undefined as never);
    expect(await savedRows()).toEqual([]);
    expect(getSavedOverride('')).toBeUndefined();
  });

  it('a re-save updates the one row and stamps saved_at = now', async () => {
    useFakeClock(T0);
    const id = freshId();
    await saveStandaloneArticle(standalone(id));
    jest.setSystemTime(T0 + 2 * MIN);

    await saveStandaloneArticle(standalone(id, { title_en_internal_only: 'Rewritten' } as never));

    const rows = await savedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: 'article', savedAt: T0 + 2 * MIN });
    const [item] = await loadSavedItems();
    expect(item).toMatchObject({ origin: 'article', savedAt: T0 + 2 * MIN });
  });
});

describe('isSuggestionSaved', () => {
  it('is false for an absent id and true for a user save', async () => {
    const s = await landSuggestion(freshId());
    expect(await isSuggestionSaved(s._id)).toBe(false);
    await saveSuggestion(s);
    expect(await isSuggestionSaved(s._id)).toBe(true);
  });

  it('means the USER saved it: false for a row that only retention holds', async () => {
    const a = freshId();
    const b = freshId();
    await keepArticleForFactCheck({ articleId: a, title: 'Checked' });
    await keepArticleForTrackedStory({ articleId: b, title: 'Followed' });

    expect(await savedRow(a)).toMatchObject({ origin: 'fact_check' });
    expect(await savedRow(b)).toMatchObject({ origin: 'tracked_story' });
    expect(await isSuggestionSaved(a)).toBe(false);
    expect(await isSuggestionSaved(b)).toBe(false);
  });

  it('counts a pre-v38 row with a NULL origin as saved', async () => {
    await restoreRows({ saved_article_suggestions: [rawSaved('legacy-1', { origin: null })] });
    expect((await savedRow('legacy-1'))!.origin).toBeNull();
    expect(await isSuggestionSaved('legacy-1')).toBe(true);
  });
});

describe('loadSavedItems / loadSavedSuggestions', () => {
  it('are empty when nothing is saved', async () => {
    expect(await loadSavedItems()).toEqual([]);
    expect(await loadSavedSuggestions()).toEqual([]);
  });

  it('return only the user\'s saves, newest saved first, with savedAt on the wrapper', async () => {
    useFakeClock(T0);
    const sug = await landSuggestion(freshId());
    const art = freshId();
    const retained = freshId();
    await saveSuggestion(sug);
    jest.setSystemTime(T0 + MIN);
    await saveStandaloneArticle(standalone(art));
    jest.setSystemTime(T0 + 2 * MIN);
    // retention rows saved LAST: if they leaked they would head the list
    await keepArticleForFactCheck({ articleId: retained, title: 'Checked' });
    await keepArticleForTrackedStory({ articleId: freshId(), title: 'Followed' });

    const items = await loadSavedItems();
    expect(items.map((i) => [i.origin, i.savedAt])).toEqual([
      ['article', T0 + MIN],
      ['suggestion', T0],
    ]);
    expect(items[0]).toMatchObject({ savedId: art });
    expect(items[1]).toMatchObject({ suggestion: { _id: sug._id } });
    expect((await loadSavedSuggestions()).map((s) => s._id)).toEqual([art, sug._id]);
    // the table holds all four; only the screen's reads hide the retention pair
    expect(await savedRows()).toHaveLength(4);
  });

  it('keep a pre-v38 NULL-origin row as a suggestion card, beside the retention filter', async () => {
    await restoreRows({
      saved_article_suggestions: [
        rawSaved('legacy-old', { origin: null, saved_at: T0 - 10 * MIN }),
        rawSaved('modern', { origin: 'suggestion', saved_at: T0 - MIN }),
      ],
    });
    await keepArticleForFactCheck({ articleId: freshId(), title: 'Checked' });

    const items = await loadSavedItems();
    expect(items.map((i) => [i.origin, i.savedAt])).toEqual([
      ['suggestion', T0 - MIN],
      ['suggestion', T0 - 10 * MIN],
    ]);
    expect((await loadSavedSuggestions()).map((s) => s._id)).toEqual(['modern', 'legacy-old']);
  });

  it('read a restored row\'s JSON columns defensively', async () => {
    await restoreRows({
      saved_article_suggestions: [
        rawSaved('bad-json', { cluster_memberships_json: 'not-json', matched_topic_texts_json: null }),
        rawSaved('mixed', {
          cluster_memberships_json:
            '[{"clusterId":"c1","confidence":0.9},{"clusterId":"","confidence":1},{"confidence":1},"x"]',
          matched_topic_texts_json: '["berlin", 5, "", "munich"]',
        }),
        rawSaved('not-arrays', {
          cluster_memberships_json: '{"clusterId":"c1"}',
          matched_topic_texts_json: '{"a":1}',
        }),
        rawSaved('good'),
      ],
    });

    const read = async (id: string) => (await getSavedSuggestionByServerId(id))!;
    expect(await read('bad-json')).toMatchObject({ clusters: [], userTopicIds: [] });
    expect(await read('mixed')).toMatchObject({
      clusters: [{ clusterId: 'c1', confidence: 0.9 }],
      userTopicIds: ['berlin', 'munich'],
    });
    expect(await read('not-arrays')).toMatchObject({ clusters: [], userTopicIds: [] });
    expect(await read('good')).toMatchObject({
      _id: 'good',
      clusters: [{ clusterId: 'c1', confidence: 0.9 }],
      userTopicIds: ['berlin'],
      title_en: 'Headline good',
      createdAt: new Date(1_700_000_000_000).toISOString(),
      firstPubDate: new Date(1_699_999_000_000).toISOString(),
      status: ArticleSuggestionStatus.Complete,
    });
  });
});

describe('the open path', () => {
  it('getSavedSuggestionByServerId is null for an id nobody holds', async () => {
    expect(await getSavedSuggestionByServerId('missing')).toBeNull();
    expect(await getSavedSuggestionWithKind('missing')).toBeNull();
  });

  it('getSavedSuggestionByServerId resolves a retention row, which is the whole point of retention', async () => {
    const fc = freshId();
    const ts = freshId();
    await keepArticleForFactCheck({ articleId: fc, title: 'Checked', articleUrl: 'https://example.com/fc' });
    await keepArticleForTrackedStory({ articleId: ts, title: 'Followed' });

    expect(await getSavedSuggestionByServerId(fc)).toMatchObject({ articleId: fc, title_en: 'Checked', article_url: 'https://example.com/fc' });
    expect(await getSavedSuggestionByServerId(ts)).toMatchObject({ articleId: ts, title_en: 'Followed' });
  });

  it('getSavedSuggestionWithKind flags a retention row as retained and a user save as not', async () => {
    const fc = freshId();
    const ts = freshId();
    const s = await landSuggestion(freshId());
    await keepArticleForFactCheck({ articleId: fc, title: 'Checked' });
    await keepArticleForTrackedStory({ articleId: ts, title: 'Followed' });
    await saveSuggestion(s);
    const art = freshId();
    await saveStandaloneArticle(standalone(art));

    expect(await getSavedSuggestionWithKind(fc)).toMatchObject({ retained: true, suggestion: { articleId: fc } });
    expect(await getSavedSuggestionWithKind(ts)).toMatchObject({ retained: true });
    // an offline save keeps its "showing cached content" banner
    expect(await getSavedSuggestionWithKind(s._id)).toMatchObject({ retained: false, suggestion: { _id: s._id } });
    expect(await getSavedSuggestionWithKind(art)).toMatchObject({ retained: false });
  });

  it('a retention keep never publishes bookmark state', async () => {
    const fc = freshId();
    const ts = freshId();
    await keepArticleForFactCheck({ articleId: fc, title: 'Checked' });
    await keepArticleForTrackedStory({ articleId: ts, title: 'Followed' });
    expect(getSavedOverride(fc)).toBeUndefined();
    expect(getSavedOverride(ts)).toBeUndefined();
  });
});
