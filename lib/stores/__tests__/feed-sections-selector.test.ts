// feed-sections-selector — pure adapter tests (Wave 7c N2).
// The DB module is mocked so importing the adapter (which transitively pulls in
// the topics/facts/locations services) doesn't touch a real WatermelonDB.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import {
  buildSelectSectionsInput,
  buildSectionedFeed,
  type SectionSnapshots,
} from '../feed-sections-selector';
import type { ForYouSuggestion, MatchedTopicRef } from '../for-you-store';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type {
  TopicSnapshot,
  FactSnapshot,
  LocationSnapshot,
} from '@/lib/news-harness/feed-select';

const NOW = 1_700_000_000_000;

function sugg(o: Partial<ForYouSuggestion> & { _id: string }): ForYouSuggestion {
  return {
    articleId: o._id,
    clusters: [],
    relevance: 0.6,
    reason: '',
    status: ArticleSuggestionStatus.Complete,
    country_code: null,
    language_code: null,
    publication_name: null,
    // Token-disjoint per id (just the id, no shared word) so the story-grouper
    // doesn't collapse distinct rows via the title-Jaccard edge — these tests
    // exercise sectioning, not grouping.
    title_en: o._id,
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: new Date(NOW).toISOString(),
    firstPubDate: new Date(NOW - 1000).toISOString(),
    rawScore: 0.6,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
    ...o,
  };
}

function mt(topicId: string, text = 'x'): MatchedTopicRef {
  return { topicId, text };
}

function snapshots(over: Partial<SectionSnapshots> = {}): SectionSnapshots {
  return {
    topics: over.topics ?? new Map<string, TopicSnapshot>(),
    facts: over.facts ?? new Map<string, FactSnapshot>(),
    locations: over.locations ?? new Map<string, LocationSnapshot>(),
    factStatements: over.factStatements ?? new Map<string, string>(),
    hasTopics: over.hasTopics ?? true,
  };
}

describe('buildSelectSectionsInput', () => {
  it('drops stale (>24h) and scored sub-0.3 rows, keeps unscored', () => {
    const rows = [
      sugg({ _id: 'fresh', relevance: 0.6, firstPubDate: new Date(NOW - 1000).toISOString() }),
      sugg({ _id: 'stale', relevance: 0.6, firstPubDate: new Date(NOW - 48 * 3600_000).toISOString() }),
      sugg({ _id: 'low', relevance: 0.2 }),
      sugg({ _id: 'unscored', status: ArticleSuggestionStatus.Unscored, relevance: 0, rawScore: null }),
    ];
    const input = buildSelectSectionsInput(rows, snapshots(), NOW);
    const ids = input.suggestions.map((s) => s.id).sort();
    expect(ids).toEqual(['fresh', 'unscored']);
    // unscored → relevance null, rawScore null.
    const u = input.suggestions.find((s) => s.id === 'unscored')!;
    expect(u.relevance).toBeNull();
    expect(u.rawScore).toBeNull();
  });

  it('falls back to relevance when rawScore is absent on a scored row', () => {
    const rows = [sugg({ _id: 'a', relevance: 0.7, rawScore: null })];
    const input = buildSelectSectionsInput(rows, snapshots(), NOW);
    expect(input.suggestions[0].rawScore).toBe(0.7);
  });
});

describe('buildSectionedFeed', () => {
  const topics = new Map<string, TopicSnapshot>([
    ['t1', { factId: 'f1', weight: 0.8, highPriority: false, status: 'active' }],
  ]);
  const facts = new Map<string, FactSnapshot>([
    ['f1', { weight: 1, createdAtMs: 100, statement: 'Berlin housing' }],
  ]);
  const factStatements = new Map([['f1', 'Berlin housing']]);

  it('emits a fact-header then top-5 cards + a show-more row for a big section', () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      sugg({
        _id: `s${i}`,
        rawScore: 0.9 - i * 0.05,
        relevance: 0.6,
        matchedTopics: [mt('t1')],
      }),
    );
    const { items } = buildSectionedFeed(rows, snapshots({ topics, facts, factStatements }), new Set(), NOW);

    const header = items.find((it) => it.type === 'fact-header');
    expect(header).toBeDefined();
    if (header?.type === 'fact-header') {
      expect(header.section.factId).toBe('f1');
      expect(header.factStatement).toBe('Berlin housing');
    }
    const cards = items.filter((it) => it.type === 'suggestion-card');
    expect(cards).toHaveLength(5); // top-N
    const showMore = items.find((it) => it.type === 'show-more');
    expect(showMore).toBeDefined();
    if (showMore?.type === 'show-more') expect(showMore.remaining).toBe(2);
  });

  it('expanding a section renders all its cards and drops show-more', () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      sugg({ _id: `s${i}`, rawScore: 0.9 - i * 0.05, matchedTopics: [mt('t1')] }),
    );
    const { items } = buildSectionedFeed(
      rows,
      snapshots({ topics, facts, factStatements }),
      new Set(['fact:f1']),
      NOW,
    );
    expect(items.filter((it) => it.type === 'suggestion-card')).toHaveLength(7);
    expect(items.some((it) => it.type === 'show-more')).toBe(false);
  });

  it('pulls breaking items into a single leading breaking-strip row', () => {
    const rows = [
      sugg({ _id: 'emg', rawScore: 1.05, relevance: 1.1, matchedTopics: [mt('t1')] }),
      sugg({ _id: 'a', rawScore: 0.6, matchedTopics: [mt('t1')] }),
      sugg({ _id: 'b', rawScore: 0.5, matchedTopics: [mt('t1')] }),
    ];
    const { items } = buildSectionedFeed(rows, snapshots({ topics, facts, factStatements }), new Set(), NOW);
    const strip = items[0];
    expect(strip.type).toBe('breaking-strip');
    if (strip.type === 'breaking-strip') {
      expect(strip.items.map((b) => b.data._id)).toEqual(['emg']);
    }
    // The emergency item is not also rendered as a section card.
    expect(items.some((it) => it.type === 'suggestion-card' && it.data._id === 'emg')).toBe(false);
  });
});
