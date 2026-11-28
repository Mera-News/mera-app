// A Feed card that has shown keeps its article for the session when its story
// merges with another one, and saved state stays keyed by that article.

import { newFeedRowSession, resolveFeedRowDisplay } from '@/components/custom/feed/feed-row-display';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { buildFeedList, type FeedListItem } from '@/lib/stores/feed-list-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { __resetSavedStateForTests, getSavedOverride, publishSavedState } from '@/lib/saved-state';

const NOW = Date.parse('2026-11-28T10:00:00.000Z');
const H = 3_600_000;

function sugg(id: string, o: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  return {
    _id: id,
    articleId: id,
    clusters: [],
    relevance: 0.6,
    reason: 'note',
    status: ArticleSuggestionStatus.Complete,
    country_code: null,
    language_code: 'en',
    publication_name: `Pub ${id}`,
    title_en: o.title_en ?? null,
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: new Date(NOW - H).toISOString(),
    firstPubDate: new Date(NOW - (o.rawScore ? 2 : 1) * H).toISOString(),
    rawScore: o.rawScore ?? 0.5,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
    factIds: [],
    scoredAt: null,
    storyKey: o.storyKey ?? null,
  };
}

const A = sugg('a', { title_en: 'alpha bravo charlie delta', storyKey: 'k1' });
const B = sugg('b', { title_en: 'echo foxtrot golf hotel' });
// Shares A's story key and B's title words, and would front the merged story.
const C = sugg('c', { title_en: 'echo foxtrot golf india', storyKey: 'k1', rawScore: 0.9 });

const live = (...rows: ForYouSuggestion[]) => new Map(rows.map((r) => [r._id, r]));
/** What ingest stores for a claimed row: the row id stays, the representative moves. */
const underRow = (id: string, it: FeedListItem): FeedListItem => ({ ...it, id });

afterEach(() => __resetSavedStateForTests());

describe('a merge during the session', () => {
  it('the shown card keeps its article; the other card keeps its own until the next session', () => {
    const session = newFeedRowSession();
    const [first, second] = buildFeedList([A, B], new Set(), NOW);
    const byId = { [first.id]: first, [second.id]: second };
    resolveFeedRowDisplay(byId.a, live(A, B), session);
    resolveFeedRowDisplay(byId.b, live(A, B), session);

    const merged = buildFeedList([A, B, C], new Set(), NOW);
    expect(merged).toHaveLength(1);
    // The merge elects another article, so the card holding 'a' is really tested.
    expect(merged[0].suggestion._id).not.toBe('a');
    const pool = live(A, B, C);
    expect(resolveFeedRowDisplay(underRow('a', merged[0]), pool, session).suggestion._id).toBe('a');
    expect(resolveFeedRowDisplay(byId.b, pool, session).suggestion._id).toBe('b');
  });

  it('a new session shows the story through the article the merge elected', () => {
    const merged = buildFeedList([A, B, C], new Set(), NOW)[0];
    const fresh = newFeedRowSession();
    expect(resolveFeedRowDisplay(merged, live(A, B, C), fresh).suggestion._id).toBe(merged.suggestion._id);
  });

  it('saved state follows the article the card shows, never the story', () => {
    const session = newFeedRowSession();
    const [a] = buildFeedList([A], new Set(), NOW);
    resolveFeedRowDisplay(a, live(A), session);
    publishSavedState('a', true);

    const merged = buildFeedList([A, B, C], new Set(), NOW)[0];
    const shown = resolveFeedRowDisplay(underRow('a', merged), live(A, B, C), session).suggestion;
    expect(getSavedOverride(shown._id)).toBe(true);
    expect(getSavedOverride('c')).toBeUndefined();
  });
});
