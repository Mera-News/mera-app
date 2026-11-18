// Interests, the fact feed and the fact page all show `buildFactRows(...).rows` and nothing else.
// An emergency story (rawScore over the cutoff) is moved out of `.rows` into `.breaking`, which no
// screen has rendered since the Dashboard's breaking strip went, so on those pages it disappears.
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { buildFactRows, type FactRowsSnapshots } from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

const NOW = 1_000_000_000_000;
const H = 3_600_000;

const story = (rawScore: number): ForYouSuggestion =>
    ({
        _id: 'quake',
        articleId: 'art-quake',
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
        createdAt: new Date(NOW - H).toISOString(),
        firstPubDate: new Date(NOW - H).toISOString(),
        rawScore,
        eventType: null,
        headlineScope: null,
        matchedTopics: [{ topicId: 't1', text: 'earthquakes' }],
        factIds: [],
        scoredAt: null,
        scoredWithV3: null,
    }) as ForYouSuggestion;

const snapshots: FactRowsSnapshots = {
    topics: new Map([['t1', { factId: 'f1', weight: 0.8, highPriority: false, status: 'active' }]]),
    facts: new Map([['f1', { weight: 1, createdAtMs: 100, statement: 'I live in Utrecht' }]]),
    locations: new Map(),
    factStatements: new Map([['f1', 'I live in Utrecht']]),
} as FactRowsSnapshots;

/** What every fact screen reads: the stories in the fact's row. */
const shownUnderFact = (rawScore: number) =>
    buildFactRows([story(rawScore)], snapshots, new Set(), NOW, DEFAULT_HARNESS_CONFIG)
        .rows.find((r) => r.factId === 'f1')
        ?.groups.map((g) => g.data._id) ?? [];

it('shows a story under its fact on the fact pages', () => {
    expect(DEFAULT_HARNESS_CONFIG.articlePipeline.emergencyPriorityCutoff).toBeLessThan(2);
    expect(shownUnderFact(0.5)).toEqual(['quake']);
});

// Known gap: buildFactRows moves an emergency story to `.breaking`, which no screen renders. No fix yet.
it.failing('still shows an emergency story under its fact on the fact pages', () => {
    expect(shownUnderFact(2)).toEqual(['quake']);
});
