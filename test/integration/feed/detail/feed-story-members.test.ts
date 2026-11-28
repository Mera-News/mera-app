// The article page opened from a Feed card lists the copies the card counts.

import { feedStoryMembersOf } from '@/components/custom/news-detail/feed-story-members';
import { newFeedRowSession, resolveFeedRowDisplay } from '@/components/custom/feed/feed-row-display';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { buildFeedList, type FeedListItem } from '@/lib/stores/feed-list-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

const NOW = Date.parse('2026-11-28T10:00:00.000Z');

function sugg(id: string, storyKey: string | null): ForYouSuggestion {
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
    title_en: `${id}story ${id}alpha ${id}bravo`,
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    firstPubDate: new Date(NOW - 3_600_000).toISOString(),
    rawScore: 0.5,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
    factIds: [],
    scoredAt: null,
    storyKey,
  };
}

const rowsOf = (items: FeedListItem[]) => ({
  order: items.map((it) => it.id),
  itemsById: Object.fromEntries(items.map((it) => [it.id, it])),
});

describe('feedStoryMembersOf', () => {
  it('the card count and the article page list agree for every member of the story', () => {
    const items = buildFeedList([sugg('a', 'k'), sugg('b', 'k'), sugg('c', 'k'), sugg('d', null)], new Set(), NOW);
    const story = items.find((it) => it.memberIds.length === 3)!;
    const count = resolveFeedRowDisplay(story, new Map(), newFeedRowSession()).similar?.count;
    for (const id of story.memberIds) {
      const listed = feedStoryMembersOf(id, rowsOf(items))!.filter((m) => m !== id);
      expect(listed).toHaveLength(count!);
    }
  });

  it('a story the Feed does not hold gives null, so the page keeps its own grouping', () => {
    expect(feedStoryMembersOf('zzz', rowsOf(buildFeedList([sugg('a', null)], new Set(), NOW)))).toBeNull();
  });

  it('the row the article fronts wins over a stale row that still lists it', () => {
    const own = { id: 'b', memberIds: ['b'] } as FeedListItem;
    const stale = { id: 'a', memberIds: ['a', 'b'] } as FeedListItem;
    expect(feedStoryMembersOf('b', { order: ['a', 'b'], itemsById: { a: stale, b: own } })).toEqual(['b']);
  });
});
