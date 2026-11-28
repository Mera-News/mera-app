// The counts card's "N stories for you, and you've read R": stories as the
// Continuous Feed lists them, over the Feed's window, on the real stores.
import { render, renderHook, screen } from '@testing-library/react-native';
import React from 'react';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { resetFeedCountsMemoForTest } from '@/lib/hooks/use-feed-counts';
import { useForYouStore, type ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { resetStoryCountsMemoForTest, useStoryCounts } from '@/components/custom/for-you/use-story-counts';
import FeedStatsSentence from '@/components/custom/for-you/FeedStatsSentence';
import { useStrictClock } from '@/test/helpers';
import i18n from '@/lib/i18n';
import en from '@/lib/locales/en.json';

const NOW = Date.parse('2026-11-28T12:00:00Z');
const H = 3_600_000;

function sugg(id: string, o: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  return {
    _id: id,
    articleId: id,
    clusters: [],
    relevance: o.relevance ?? 0.6,
    reason: o.reason ?? 'note',
    status: o.status ?? ArticleSuggestionStatus.Complete,
    country_code: null,
    language_code: 'en',
    publication_name: `Pub ${id}`,
    title_en: `${id}story ${id}alpha ${id}bravo`,
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: new Date(NOW - H).toISOString(),
    firstPubDate: o.firstPubDate ?? new Date(NOW - H).toISOString(),
    rawScore: 0.5,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
    factIds: [],
    scoredAt: null,
    storyKey: o.storyKey ?? null,
  };
}

function seed(suggestions: ForYouSuggestion[], opened: string[] = [], articleCount = 50) {
  useForYouStore.setState({ suggestions, articleCount });
  useOpenedStoriesStore.setState({ ids: new Set(opened), articleIds: new Set(opened), hydrated: true });
}

beforeEach(() => {
  useStrictClock(NOW);
  resetFeedCountsMemoForTest();
  resetStoryCountsMemoForTest();
});
afterEach(() => seed([], [], 0));

describe('useStoryCounts', () => {
  it('counts stories, not copies: two copies of one story are one', async () => {
    seed([sugg('a', { storyKey: 'k' }), sugg('b', { storyKey: 'k' }), sugg('c')]);
    const { result } = await renderHook(() => useStoryCounts());
    expect(result.current.storyCount).toBe(2);
  });

  it("covers the Feed's 48 hours, where the article counts stop at 24", async () => {
    seed([sugg('old', { firstPubDate: new Date(NOW - 30 * H).toISOString() })]);
    const { result } = await renderHook(() => useStoryCounts());
    expect(result.current.storyCount).toBe(1);
  });

  it('counts a story waiting for its note, never one below the gate or not read yet', async () => {
    seed([
      sugg('pending', { status: ArticleSuggestionStatus.ReasonPending, reason: '' }),
      sugg('low', { relevance: 0.2, reason: '' }),
      sugg('unread', { status: ArticleSuggestionStatus.Unscored, relevance: 0, reason: '' }),
    ]);
    const { result } = await renderHook(() => useStoryCounts());
    expect(result.current.storyCount).toBe(1);
  });

  it('a story is read when the reader opened any of its copies', async () => {
    seed([sugg('a', { storyKey: 'k' }), sugg('b', { storyKey: 'k' }), sugg('c')], ['b']);
    const { result } = await renderHook(() => useStoryCounts());
    expect(result.current.storyReadCount).toBe(1);
  });
});

describe('FeedStatsSentence', () => {
  // The exact en.json clauses, so the joined sentence is read as shipped.
  beforeEach(() => {
    i18n.addResourceBundle('en', 'translation', { feed: en.feed }, true, true);
  });

  it('names the stories and the stories read', async () => {
    seed([sugg('a', { storyKey: 'k' }), sugg('b', { storyKey: 'k' }), sugg('c')], ['a']);
    await render(<FeedStatsSentence testID="sentence" />);
    expect(screen.getByTestId('sentence')).toHaveTextContent(/2 stories for you, and you've read 1\./);
  });

  it('says so when no story is there yet', async () => {
    seed([sugg('low', { relevance: 0.2, reason: '' })]);
    await render(<FeedStatsSentence testID="sentence" />);
    expect(screen.getByTestId('sentence')).toHaveTextContent(/no stories for you yet,/);
  });
});
