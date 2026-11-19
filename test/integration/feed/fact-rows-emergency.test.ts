// Interests, the fact feed and the fact page all show `buildFactRows(...).rows`. An emergency story
// (rawScore over the cutoff) stays in its fact's row, first; the main Feed's list is not touched.
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { buildFactRows, type FactRowsSnapshots } from '@/lib/stores/fact-rows-selector';
import { buildFeedList } from '@/lib/stores/feed-list-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

const NOW = 1_000_000_000_000;
const H = 3_600_000;

const story = (id: string, rawScore: number, ageH: number): ForYouSuggestion =>
    ({
        _id: id,
        articleId: `art-${id}`,
        clusters: [],
        relevance: 0.9,
        reason: 'because',
        status: ArticleSuggestionStatus.Complete,
        country_code: null,
        language_code: 'en',
        publication_name: 'Harbour Daily',
        title_en: null,
        title_original: null,
        description_en: null,
        article_url: null,
        image_url: null,
        userTopicIds: [],
        createdAt: new Date(NOW - ageH * H).toISOString(),
        firstPubDate: new Date(NOW - ageH * H).toISOString(),
        rawScore,
        eventType: null,
        headlineScope: null,
        matchedTopics: [{ topicId: 't1', text: 'earthquakes' }],
    }) as ForYouSuggestion;

const snapshots = {
    topics: new Map([['t1', { factId: 'f1', weight: 0.8, highPriority: false, status: 'active' }]]),
    facts: new Map([['f1', { weight: 1, createdAtMs: 100, statement: 'I live in Utrecht' }]]),
    locations: new Map(),
    factStatements: new Map([['f1', 'I live in Utrecht']]),
} as unknown as FactRowsSnapshots;

// The emergency story is the OLDER one, so freshness alone would put it second.
const quake = story('quake', 2, 3);
const market = story('market', 0.5, 1);

/** What every fact screen reads: the stories in the fact's row, in order. */
const shownUnderFact = (suggestions: ForYouSuggestion[]) =>
    buildFactRows(suggestions, snapshots, new Set(), NOW, DEFAULT_HARNESS_CONFIG)
        .rows.find((r) => r.factId === 'f1')
        ?.groups.map((g) => g.data._id) ?? [];

it('shows an emergency story under its fact, first, next to the fact\'s other stories', () => {
    expect(DEFAULT_HARNESS_CONFIG.articlePipeline.emergencyPriorityCutoff).toBeLessThan(2);
    expect(shownUnderFact([market, quake])).toEqual(['quake', 'market']);
});

it('keeps a fact\'s row when its only story is an emergency', () => {
    expect(shownUnderFact([quake])).toEqual(['quake']);
});

it('leaves the main Feed list for the same stories as it was', () => {
    expect(buildFeedList([market, quake], new Set(), NOW).map((item) => item.suggestion._id)).toEqual(['quake', 'market']);
});
