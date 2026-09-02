// feed-sync-steps.test.ts — unit tests for each step function

const mockGetFacts = jest.fn();
const mockGetLocalSuggestionServerIds = jest.fn();
const mockGetUnscoredSuggestionsWithFacts = jest.fn();
const mockBatchMarkAsScoredByIds = jest.fn();
const mockBatchMarkExcluded = jest.fn();
const mockGetCullableLowHeadlineIds = jest.fn();
const mockPersistAndLinkV2Suggestions = jest.fn();
const mockGetFactWeightById = jest.fn();
const mockGetArticleIdsForTopics = jest.fn();
const mockGetArticlesForTopicsByIds = jest.fn();
const mockGetArticlesForStories = jest.fn();
const mockGetArticleIdsForPersona = jest.fn();
const mockWithRetry = jest.fn();
const mockRunScoringPass = jest.fn();
const mockEnqueueCandidates = jest.fn();
const mockGetNonTerminalCandidateIds = jest.fn();
const mockGateUnscoredForScoring = jest.fn();
const mockLoadUserGeoLanguageContext = jest.fn();
const mockLogInfo = jest.fn();
const mockGetActive = jest.fn();
const mockGetAllLocations = jest.fn();
const mockGetHeadlineDepths = jest.fn();
const mockReconcileTrackedStories = jest.fn();
const mockMigrateLegacyTrackedStories = jest.fn();
const mockBackfillTrackedStoryRetention = jest.fn(async () => 0);
const mockCaptureException = jest.fn();
const mockRunPersonaMigrationIfNeeded = jest.fn();
const mockGetFactSectionSnapshots = jest.fn();
const mockResolveAiAccessForFetch = jest.fn();

jest.mock('@/lib/database/services/fact-service', () => ({
  getFacts: (...args: any[]) => mockGetFacts(...args),
  getFactSectionSnapshots: () => mockGetFactSectionSnapshots(),
}));

// Only the ENFORCEMENT reader is stubbed; `deriveFreeTierAccess` runs for REAL
// (it is pure), so these tests exercise the actual two-oldest-facts rule and the
// actual tracked-topic exemption rather than a stand-in that could drift from
// it. The real module loads cleanly here — nothing in its graph needs native.
jest.mock('@/lib/subscription/free-tier-topic-access', () => ({
  ...jest.requireActual('@/lib/subscription/free-tier-topic-access'),
  resolveAiAccessForFetch: () => mockResolveAiAccessForFetch(),
}));

jest.mock('@/lib/database/services/topic-service', () => ({
  getActive: (...args: any[]) => mockGetActive(...args),
  // Real implementation, not a stub: the billing partition compares NORMALIZED
  // texts, so a mock that skipped normalization would make the collision tests
  // below pass for the wrong reason.
  normalizeTopicText: (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' '),
}));

jest.mock('@/lib/services/persona-migration-service', () => ({
  runPersonaMigrationIfNeeded: (...args: any[]) => mockRunPersonaMigrationIfNeeded(...args),
}));

jest.mock('@/lib/database/services/location-service', () => ({
  getAll: (...args: any[]) => mockGetAllLocations(...args),
}));

// Mocked so the real module (settings → database/index → SQLiteAdapter) never
// enters the graph here. Default is `{}` — no overrides — which is exactly the
// path every pre-existing test in this file exercises.
jest.mock('@/lib/database/services/headline-depth-service', () => ({
  getHeadlineDepths: (...args: any[]) => mockGetHeadlineDepths(...args),
}));

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getLocalSuggestionServerIds: (...args: any[]) => mockGetLocalSuggestionServerIds(...args),
  getUnscoredSuggestionsWithFacts: (...args: any[]) => mockGetUnscoredSuggestionsWithFacts(...args),
  batchMarkAsScoredByIds: (...args: any[]) => mockBatchMarkAsScoredByIds(...args),
  batchMarkExcluded: (...args: any[]) => mockBatchMarkExcluded(...args),
  getCullableLowHeadlineIds: (...args: any[]) => mockGetCullableLowHeadlineIds(...args),
  persistAndLinkV2Suggestions: (...args: any[]) => mockPersistAndLinkV2Suggestions(...args),
  getFactWeightById: (...args: any[]) => mockGetFactWeightById(...args),
}));

jest.mock('@/lib/article-service', () => ({
  ArticleService: {
    getArticleIdsForTopics: (...args: any[]) => mockGetArticleIdsForTopics(...args),
    getArticlesForTopicsByIds: (...args: any[]) => mockGetArticlesForTopicsByIds(...args),
    getArticlesForStories: (...args: any[]) => mockGetArticlesForStories(...args),
    getArticleIdsForPersona: (...args: any[]) => mockGetArticleIdsForPersona(...args),
  },
}));

jest.mock('@/lib/utils/retry', () => ({
  withRetry: (fn: any, signal: any) => mockWithRetry(fn, signal),
  // Explicit factory: every export this module CALLS has to be listed here, or
  // it is undefined at the call site and the failure names the mock's shape
  // rather than the missing export.
  createCancellationError: () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    return err;
  },
}));

jest.mock('@/lib/services/SuggestionSyncService', () => ({
  runScoringPass: (...args: any[]) => mockRunScoringPass(...args),
}));

jest.mock('@/lib/services/scoring-pipeline', () => ({
  enqueueCandidates: (...args: any[]) => mockEnqueueCandidates(...args),
  getNonTerminalCandidateIds: (...args: any[]) => mockGetNonTerminalCandidateIds(...args),
}));

jest.mock('@/lib/feed-grouping/score-propagation', () => ({
  gateUnscoredForScoring: (...args: any[]) => mockGateUnscoredForScoring(...args),
}));

// PARTIAL mock: the two DB-touching exports are stubbed, but the pure matcher
// (`buildReadStoryIndex` / `matchesReadStory`) runs for REAL, so these tests
// exercise the actual already-read matching rather than a boolean stand-in.
// `requireActual` is safe here — the module's static graph is deliberately
// database-free (see its lazy-require note).
const mockLoadReadStoryIndex = jest.fn();
const mockBatchMarkAlreadyRead = jest.fn();
jest.mock('@/lib/feed-grouping/read-story-filter', () => ({
  ...jest.requireActual('@/lib/feed-grouping/read-story-filter'),
  loadReadStoryIndex: (...args: any[]) => mockLoadReadStoryIndex(...args),
  batchMarkAlreadyRead: (...args: any[]) => mockBatchMarkAlreadyRead(...args),
}));

jest.mock('@/lib/user-context/user-geo-language-context', () => ({
  loadUserGeoLanguageContext: (...args: any[]) => mockLoadUserGeoLanguageContext(...args),
}));

jest.mock('../tracked-story-reconcile', () => ({
  reconcileTrackedStories: (...args: any[]) => mockReconcileTrackedStories(...args),
}));

jest.mock('@/lib/tracking/track-actions', () => ({
  migrateLegacyTrackedStories: (...args: any[]) => mockMigrateLegacyTrackedStories(...args),
  backfillTrackedStoryRetention: () => mockBackfillTrackedStoryRetention(),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: (...args: any[]) => mockLogInfo(...args),
    info: (...args: any[]) => mockLogInfo(...args),
    warn: jest.fn(),
    captureException: (...args: any[]) => mockCaptureException(...args),
  },
}));

import {
  stepFetchTopicIds,
  stepDiff,
  stepHydratePersistEnqueue,
  stepScore,
  computeFreeTopicTexts,
  partitionStoryIds,
  HYDRATE_CHUNK_SIZE,
  HYDRATE_CONCURRENCY,
  clampTopicDepth,
  FREE_TIER_TOPIC_LIMIT,
} from '../feed-sync-steps';
import type {
  FetchTopicIdsResult,
  DiffResult,
  HydratePersistEnqueueOptions,
} from '../feed-sync-steps';
import { DEFAULT_HEADLINE_LIMIT_PER_SCOPE } from '@/lib/news-harness/scoring-engine/retrieval-profile';
import {
  buildReadStoryIndex,
  EMPTY_READ_STORY_INDEX,
} from '@/lib/feed-grouping/read-story-filter';

function makeCtx(aborted = false) {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    jobId: 'job-steps-1',
    attempt: 1,
    signal: controller.signal,
    reportProgress: jest.fn(),
    log: jest.fn(),
    markNoOp: jest.fn(),
    controller,
  };
}

function makeOpts(
  overrides?: Partial<HydratePersistEnqueueOptions>,
): HydratePersistEnqueueOptions {
  return {
    onProgress: jest.fn(),
    awaitResumeIfPaused: jest.fn().mockResolvedValue(undefined),
    refreshStore: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  // Default: withRetry calls the fn and returns its result
  mockWithRetry.mockImplementation((fn: () => any) => fn());
  mockGetFacts.mockResolvedValue([]);
  mockGetActive.mockResolvedValue([]);
  mockGetAllLocations.mockResolvedValue([]);
  mockGetHeadlineDepths.mockResolvedValue({});
  mockGetFactWeightById.mockResolvedValue(new Map());
  mockGetLocalSuggestionServerIds.mockResolvedValue([]);
  mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([]);
  mockBatchMarkAsScoredByIds.mockResolvedValue(undefined);
  mockBatchMarkExcluded.mockResolvedValue(undefined);
  mockGetCullableLowHeadlineIds.mockResolvedValue([]);
  mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 0, linkedCount: 0 });
  mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });
  mockGetArticlesForTopicsByIds.mockResolvedValue({ articles: [], dailyLimitReached: false });
  // The quota-exempt hydrator returns no cap fields at all — that absence is
  // part of its contract, so the default mock must not invent them.
  mockGetArticlesForStories.mockResolvedValue({ articles: [] });
  mockRunScoringPass.mockResolvedValue(5);
  mockEnqueueCandidates.mockResolvedValue(undefined);
  mockGetNonTerminalCandidateIds.mockResolvedValue(new Set());
  // Default gate: no propagation/election, enqueue nothing. Tests that exercise
  // enqueue configure it to return the ids the gate elected for this sync.
  mockGateUnscoredForScoring.mockResolvedValue({
    enqueueIds: [],
    propagatedCount: 0,
    heldBackCount: 0,
    coveredIdsByRep: {},
    readCount: 0,
  });
  // Default: nothing has been read, so the already-read gate is inert and every
  // pre-existing test in this file keeps its exact prior behaviour.
  mockLoadReadStoryIndex.mockResolvedValue(EMPTY_READ_STORY_INDEX);
  mockBatchMarkAlreadyRead.mockResolvedValue(undefined);
  mockReconcileTrackedStories.mockResolvedValue(undefined);
  mockMigrateLegacyTrackedStories.mockResolvedValue(0);
  mockLoadUserGeoLanguageContext.mockResolvedValue(null);
  // Default: entitled. Every pre-existing test in this file therefore keeps its
  // exact prior behaviour — the free-tier filter is inert for a paid user.
  mockResolveAiAccessForFetch.mockResolvedValue('entitled');
  mockGetFactSectionSnapshots.mockResolvedValue([]);
  mockRunPersonaMigrationIfNeeded.mockResolvedValue({
    ran: false,
    factsMigrated: 0,
    topicsCreated: 0,
    locationsUpserted: 0,
  });
});

// ── stepFetchTopicIds ─────────────────────────────────────────────────────────

describe('stepFetchTopicIds', () => {
  it('throws "aborted" when signal is already aborted', async () => {
    const ctx = makeCtx(true);
    await expect(stepFetchTopicIds('p-1', ctx)).rejects.toThrow('aborted');
    expect(mockGetFacts).not.toHaveBeenCalled();
  });

  it('throws no-topics-configured when no topics found in facts', async () => {
    mockGetFacts.mockResolvedValue([]); // empty facts → no topics
    const ctx = makeCtx();
    await expect(stepFetchTopicIds('p-1', ctx)).rejects.toThrow('no-topics-configured');
    expect(mockGetArticleIdsForTopics).not.toHaveBeenCalled();
  });

  it('throws with code no-topics-configured on the error object', async () => {
    mockGetFacts.mockResolvedValue([]);
    const ctx = makeCtx();
    const err = await stepFetchTopicIds('p-1', ctx).catch((e) => e);
    expect(err.code).toBe('no-topics-configured');
  });

  it('deduplicates topic texts across facts', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: { topics: ['ai', 'tech'] } },
      { metadata: { topics: ['ai', 'sports'] } }, // 'ai' is a duplicate
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });

    const ctx = makeCtx();
    await stepFetchTopicIds('p-1', ctx).catch(() => {});
    // getArticleIdsForTopics called with unique topics: ai, tech, sports
    expect(mockGetArticleIdsForTopics).toHaveBeenCalledWith(
      expect.arrayContaining([
        { topicText: 'ai' },
        { topicText: 'tech' },
        { topicText: 'sports' },
      ]),
      expect.any(Object),
    );
    // Should NOT have duplicated ai
    const call = mockGetArticleIdsForTopics.mock.calls[0][0];
    const aiEntries = call.filter((c: any) => c.topicText === 'ai');
    expect(aiEntries).toHaveLength(1);
  });

  it('skips empty string topics', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: { topics: ['', 'valid-topic'] } },
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });

    const ctx = makeCtx();
    await stepFetchTopicIds('p-1', ctx).catch(() => {});
    const call = mockGetArticleIdsForTopics.mock.calls[0][0];
    expect(call).not.toContainEqual({ topicText: '' });
    expect(call).toContainEqual({ topicText: 'valid-topic' });
  });

  it('handles facts with no metadata.topics (undefined topics)', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: {} }, // no topics array
      { metadata: { topics: ['real-topic'] } },
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });

    const ctx = makeCtx();
    await stepFetchTopicIds('p-1', ctx).catch(() => {});
    const call = mockGetArticleIdsForTopics.mock.calls[0][0];
    expect(call).toContainEqual({ topicText: 'real-topic' });
  });

  it('returns articleToTopicTexts map and serverArticleIds on success', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: { topics: ['topic-a', 'topic-b'] } },
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({
      results: [
        { topicText: 'topic-a', articleIds: ['art-1', 'art-2'] },
        { topicText: 'topic-b', articleIds: ['art-2', 'art-3'] },
      ],
    });

    const ctx = makeCtx();
    const result = await stepFetchTopicIds('p-1', ctx);

    expect(result.serverArticleIds).toEqual(expect.arrayContaining(['art-1', 'art-2', 'art-3']));
    expect(result.serverArticleIds).toHaveLength(3);
    expect(result.articleToTopicTexts.get('art-2')).toEqual(
      expect.arrayContaining(['topic-a', 'topic-b']),
    );
  });

  it('builds multi-topic articleToTopicTexts correctly (an article matching two topics)', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: { topics: ['topic-x'] } },
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({
      results: [
        { topicText: 'topic-x', articleIds: ['art-10'] },
      ],
    });

    const ctx = makeCtx();
    const result = await stepFetchTopicIds('p-1', ctx);

    expect(result.articleToTopicTexts.get('art-10')).toEqual(['topic-x']);
  });

  it('passes signal to withRetry', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: { topics: ['topic-1'] } },
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });

    const ctx = makeCtx();
    await stepFetchTopicIds('p-1', ctx).catch(() => {});
    // withRetry should have been called with the ctx.signal
    expect(mockWithRetry).toHaveBeenCalledWith(
      expect.any(Function),
      ctx.signal,
    );
  });

  it('logs info message with topic count', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: { topics: ['topic-1', 'topic-2'] } },
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });

    const ctx = makeCtx();
    await stepFetchTopicIds('p-1', ctx).catch(() => {});

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringContaining('2 topic texts'),
    );
  });

  it('routes through the persona path when topic-service has active topics, and builds matchedTopics/stableClusterId metadata', async () => {
    mockGetActive.mockResolvedValue([
      { id: 't1', text: 'ai', weight: 0.8, highPriority: false, factId: 'f1', locationId: null },
    ] as any);
    mockGetAllLocations.mockResolvedValue([]);
    mockGetArticleIdsForPersona.mockResolvedValue({
      topicResults: [
        {
          topicText: 'ai',
          articleIds: ['art-1'],
          matchMeta: [{ articleId: 'art-1', vectorScore: 0.9, textScore: null, stableClusterId: 'sc1' }],
          nextCursor: null,
          hasNextPage: false,
        },
      ],
      headlineResults: [],
    });

    const ctx = makeCtx();
    const result = await stepFetchTopicIds('p-1', ctx);

    expect(result.serverArticleIds).toContain('art-1');
    expect(result.articleToTopicTexts.get('art-1')).toContain('ai');
    expect(result.personaMeta?.matchedTopics.get('art-1')?.[0]).toMatchObject({
      topicId: 't1',
      text: 'ai',
    });
    expect(result.personaMeta?.stableClusterId?.get('art-1')).toBe('sc1');
    expect(mockGetArticleIdsForPersona).toHaveBeenCalled();
    expect(mockGetArticleIdsForTopics).not.toHaveBeenCalled();
  });

  // ── P3: the headline scope's COUNTRY survives to the persist metadata ────
  it('records the headline scope COUNTRY (uppercased) alongside the scope label', async () => {
    mockGetActive.mockResolvedValue([
      { id: 't1', text: 'ai', weight: 0.8, highPriority: false, factId: null, locationId: null },
    ] as any);
    mockGetAllLocations.mockResolvedValue([]);
    mockGetArticleIdsForPersona.mockResolvedValue({
      topicResults: [],
      headlineResults: [
        {
          scope: 'COUNTRY',
          countryCode: 'in',
          articleIds: ['art-in'],
          clusterSizes: [3],
          stableClusterIds: [],
        },
        {
          scope: 'GLOBAL',
          countryCode: null,
          articleIds: ['art-global'],
          clusterSizes: [9],
          stableClusterIds: [],
        },
      ],
    });

    const result = await stepFetchTopicIds('p-1', makeCtx());

    expect(result.personaMeta?.headlineScope?.get('art-in')).toBe('COUNTRY');
    expect(result.personaMeta?.headlineCountryCode?.get('art-in')).toBe('IN');
    // A GLOBAL headline belongs to no single country — no code, not an empty one.
    expect(result.personaMeta?.headlineScope?.get('art-global')).toBe('GLOBAL');
    expect(result.personaMeta?.headlineCountryCode?.has('art-global')).toBe(false);
  });

  it('keeps scope label and scope country coherent when an article appears in two scopes', async () => {
    // 'art-both' is carried by GLOBAL first, then by the COUNTRY scope. The
    // first writer wins for BOTH fields together — never GLOBAL + a country.
    mockGetActive.mockResolvedValue([
      { id: 't1', text: 'ai', weight: 0.8, highPriority: false, factId: null, locationId: null },
    ] as any);
    mockGetAllLocations.mockResolvedValue([]);
    mockGetArticleIdsForPersona.mockResolvedValue({
      topicResults: [],
      headlineResults: [
        { scope: 'GLOBAL', countryCode: null, articleIds: ['art-both'], clusterSizes: [], stableClusterIds: [] },
        { scope: 'COUNTRY', countryCode: 'NL', articleIds: ['art-both'], clusterSizes: [], stableClusterIds: [] },
      ],
    });

    const result = await stepFetchTopicIds('p-1', makeCtx());

    expect(result.personaMeta?.headlineScope?.get('art-both')).toBe('GLOBAL');
    expect(result.personaMeta?.headlineCountryCode?.has('art-both')).toBe(false);
  });

  // ── BILLING GUARANTEE: topic ids are ordered BEFORE headline ids ─────────
  //
  // The server truncates a clipped response in pure request order, so the
  // insertion order of `matchedTopics` decides what a capped user's daily
  // allowance is spent on. Nothing else in this suite would catch a refactor
  // that sorted `serverArticleIds`, swapped the two inversion loops, or merged
  // them — the metadata assertions above all pass regardless of order.

  it('orders topic-matched ids BEFORE headline ids (billing guarantee)', async () => {
    mockGetActive.mockResolvedValue([
      { id: 't1', text: 'ai', weight: 0.8, highPriority: false, factId: 'f1', locationId: null },
    ] as any);
    mockGetAllLocations.mockResolvedValue([]);
    mockGetArticleIdsForPersona.mockResolvedValue({
      topicResults: [
        {
          topicText: 'ai',
          articleIds: ['art-topic'],
          matchMeta: [],
          nextCursor: null,
          hasNextPage: false,
        },
      ],
      headlineResults: [
        {
          scope: 'GLOBAL',
          countryCode: null,
          articleIds: ['art-headline'],
          clusterSizes: [],
          stableClusterIds: [],
        },
      ],
    });

    const result = await stepFetchTopicIds('p-1', makeCtx());

    // Exact array equality, not `toContain`: order IS the assertion here.
    expect(result.serverArticleIds).toEqual(['art-topic', 'art-headline']);
  });

  it('keeps an article matched by BOTH a topic and a headline in its topic-loop position', async () => {
    // 'art-both' is returned by the headline scope too. It must keep the slot
    // the topic loop gave it — otherwise a headline could displace an interest
    // article later into the request and change what the cap clips.
    mockGetActive.mockResolvedValue([
      { id: 't1', text: 'ai', weight: 0.8, highPriority: false, factId: 'f1', locationId: null },
    ] as any);
    mockGetAllLocations.mockResolvedValue([]);
    mockGetArticleIdsForPersona.mockResolvedValue({
      topicResults: [
        {
          topicText: 'ai',
          articleIds: ['art-both'],
          matchMeta: [],
          nextCursor: null,
          hasNextPage: false,
        },
      ],
      headlineResults: [
        {
          scope: 'GLOBAL',
          countryCode: null,
          articleIds: ['art-headline-only', 'art-both'],
          clusterSizes: [],
          stableClusterIds: [],
        },
      ],
    });

    const result = await stepFetchTopicIds('p-1', makeCtx());

    expect(result.serverArticleIds).toEqual(['art-both', 'art-headline-only']);
    // Its ORDER comes from the topic loop, but it still carries the headline
    // scope: the first-writer guard at the headline loop only defends against a
    // SECOND scope, not against a topic match. Asserted so the two facts are
    // not conflated — order and scope are decided by different rules here, and
    // `partitionStoryIds` reads the scope to keep this article METERED.
    expect(result.personaMeta?.headlineScope?.get('art-both')).toBe('GLOBAL');
  });

  // ── strictMatch: tighten the server's floor for followed stories only ────

  const topicRow = (over: Record<string, any>) => ({
    id: over.id ?? 't1',
    text: over.text ?? 'ai',
    weight: over.weight ?? 0.8,
    highPriority: false,
    factId: over.factId ?? null,
    locationId: null,
    provenance: over.provenance,
  });

  const topicsSentFor = async (rows: Record<string, any>[]) => {
    mockGetActive.mockResolvedValue(rows.map(topicRow) as any);
    mockGetAllLocations.mockResolvedValue([]);
    mockGetArticleIdsForPersona.mockResolvedValue({ topicResults: [], headlineResults: [] });
    await stepFetchTopicIds('p-1', makeCtx());
    return mockGetArticleIdsForPersona.mock.calls[0][0].topics as any[];
  };

  it('sets strictMatch on a topic carried ONLY by a followed story', async () => {
    const topics = await topicsSentFor([
      { id: 't1', text: 'gaza ceasefire', provenance: 'tracked' },
      { id: 't2', text: 'AI regulation', provenance: 'llm' },
    ]);
    expect(topics.find((t) => t.text === 'gaza ceasefire').strictMatch).toBe(true);
  });

  // The whole point of the set difference: tightening a followed story must
  // never quietly tighten an ordinary interest that happens to share its text.
  it('leaves a text shared with an interest topic LOOSE', async () => {
    const topics = await topicsSentFor([
      { id: 't1', text: 'gaza ceasefire', provenance: 'tracked' },
      { id: 't2', text: 'Gaza  Ceasefire', factId: 'f1', provenance: 'llm' },
    ]);
    for (const t of topics) expect('strictMatch' in t).toBe(false);
  });

  // Two rows can carry the same NORMALIZED text and are sent as two entries
  // (buildRetrievalProfile does not dedupe). Keying the flag on the normalized
  // text is what stops the same text going out strict on one entry and loose on
  // the other.
  it('gives every entry sharing a normalized text the same flag', async () => {
    const topics = await topicsSentFor([
      { id: 't1', text: 'Gaza Ceasefire', provenance: 'tracked' },
      { id: 't2', text: '  gaza   ceasefire  ', provenance: 'tracked' },
    ]);
    expect(topics).toHaveLength(2);
    for (const t of topics) expect(t.strictMatch).toBe(true);
  });

  // Absence, not `false`. A reader who follows no stories must send the payload
  // they send today, byte for byte.
  it('omits the key entirely when nothing is tracked', async () => {
    const topics = await topicsSentFor([
      { id: 't1', text: 'ai', provenance: 'llm' },
      { id: 't2', text: 'climate', provenance: 'exploration' },
    ]);
    // Asserted as the exact KEY SET, not against limit values — the weight →
    // limit math belongs to retrieval-profile's own tests and must not be
    // pinned twice.
    expect(topics).toHaveLength(2);
    for (const t of topics) expect(Object.keys(t).sort()).toEqual(['limit', 'text']);
  });

  // ── P2b: per-scope headline depth reaches the GraphQL variables ──────────
  it('sends NO per-scope limit when there are no depth overrides', async () => {
    mockGetActive.mockResolvedValue([
      { id: 't1', text: 'ai', weight: 0.8, highPriority: false, factId: null, locationId: null },
    ] as any);
    mockGetAllLocations.mockResolvedValue([
      { countryCode: 'IN', role: 'home', weight: 1, validUntil: null },
    ] as any);
    mockGetHeadlineDepths.mockResolvedValue({});
    mockGetArticleIdsForPersona.mockResolvedValue({ topicResults: [], headlineResults: [] });

    await stepFetchTopicIds('p-1', makeCtx());

    const query = mockGetArticleIdsForPersona.mock.calls[0][0];
    expect(query.topHeadlines.scopes).toEqual([
      { scope: 'COUNTRY', countryCode: 'IN' },
      { scope: 'GLOBAL', countryCode: null },
    ]);
    // Absent, not null — an explicit null would change every untouched payload.
    for (const s of query.topHeadlines.scopes) {
      expect('limit' in s).toBe(false);
    }
  });

  it('threads each overridden scope depth into topHeadlines.scopes[].limit', async () => {
    mockGetActive.mockResolvedValue([
      { id: 't1', text: 'ai', weight: 0.8, highPriority: false, factId: null, locationId: null },
    ] as any);
    mockGetAllLocations.mockResolvedValue([
      { countryCode: 'IN', role: 'home', weight: 1, validUntil: null },
      { countryCode: 'NL', role: 'family', weight: 0.5, validUntil: null },
    ] as any);
    // NL is left at the default → still no `limit` on the wire. That is the
    // property under test and it is independent of what the default IS.
    mockGetHeadlineDepths.mockResolvedValue({ IN: 25, GLOBAL: 3 });
    mockGetArticleIdsForPersona.mockResolvedValue({ topicResults: [], headlineResults: [] });

    await stepFetchTopicIds('p-1', makeCtx());

    const query = mockGetArticleIdsForPersona.mock.calls[0][0];
    expect(query.topHeadlines.scopes).toEqual([
      { scope: 'COUNTRY', countryCode: 'IN', limit: 25 },
      { scope: 'COUNTRY', countryCode: 'NL' },
      { scope: 'GLOBAL', countryCode: null, limit: 3 },
    ]);
    // headlines P7b — conscious change: this pinned 10, but the requirement was
    // always "the top 20 articles from the top headlines in each country the
    // user is interested in". Asserted against the constant rather than a
    // literal, so the next default change moves one place, not two.
    expect(query.topHeadlines.limitPerScope).toBe(DEFAULT_HEADLINE_LIMIT_PER_SCOPE);
  });

  it('falls back to default depths (and still syncs) when the depth read throws', async () => {
    mockGetActive.mockResolvedValue([
      { id: 't1', text: 'ai', weight: 0.8, highPriority: false, factId: null, locationId: null },
    ] as any);
    mockGetAllLocations.mockResolvedValue([]);
    mockGetHeadlineDepths.mockRejectedValue(new Error('settings unreadable'));
    mockGetArticleIdsForPersona.mockResolvedValue({ topicResults: [], headlineResults: [] });

    await expect(stepFetchTopicIds('p-1', makeCtx())).resolves.toBeDefined();

    const query = mockGetArticleIdsForPersona.mock.calls[0][0];
    expect(query.topHeadlines.scopes).toEqual([{ scope: 'GLOBAL', countryCode: null }]);
  });

  // ── P7e: sync-vs-persona-migration race ──────────────────────────────────
  it('awaits the persona migration BEFORE choosing the topics path', async () => {
    // Migration populates topics as a side effect: getActive returns empty until
    // the migration resolves, then the persona path is taken.
    mockRunPersonaMigrationIfNeeded.mockResolvedValue({
      ran: true,
      factsMigrated: 1,
      topicsCreated: 1,
      locationsUpserted: 0,
    });
    mockGetActive.mockResolvedValue([
      { id: 't1', text: 'ai', weight: 0.8, highPriority: false, factId: 'f1', locationId: null },
    ] as any);
    mockGetArticleIdsForPersona.mockResolvedValue({ topicResults: [], headlineResults: [] });

    const ctx = makeCtx();
    await stepFetchTopicIds('p-1', ctx);

    expect(mockRunPersonaMigrationIfNeeded).toHaveBeenCalledTimes(1);
    // The migration must be invoked before the topics-path choice reads topics.
    expect(mockRunPersonaMigrationIfNeeded.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetActive.mock.invocationCallOrder[0],
    );
  });

  it('does not fail the step when the persona migration rejects — legacy path still proceeds', async () => {
    mockRunPersonaMigrationIfNeeded.mockRejectedValue(new Error('migration boom'));
    // Topics table still empty → legacy fallback path.
    mockGetActive.mockResolvedValue([]);
    mockGetFacts.mockResolvedValue([{ metadata: { topics: ['topic-1'] } }]);
    mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });

    const ctx = makeCtx();
    // Resolves normally despite the migration rejection.
    const result = await stepFetchTopicIds('p-1', ctx);

    expect(result.serverArticleIds).toEqual([]);
    // Legacy path ran (topics still empty), persona path did not.
    expect(mockGetArticleIdsForTopics).toHaveBeenCalled();
    expect(mockGetArticleIdsForPersona).not.toHaveBeenCalled();
    // The failure was captured, not propagated.
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ method: 'runPersonaMigrationIfNeeded' }),
      }),
    );
  });

});

// ── Mera News Free: the retrieval filter, the clamp and the degrade ─────────

describe('stepFetchTopicIds — free tier', () => {
  // Two facts, oldest first. f-old and f-old2 are the unlocked pair; f-new is
  // locked, so its topics must never reach the wire.
  const FACTS = [
    { id: 'f-old', createdAtMs: 1_000, weight: null, statement: '', sectionTitle: null },
    { id: 'f-old2', createdAtMs: 2_000, weight: null, statement: '', sectionTitle: null },
    { id: 'f-new', createdAtMs: 9_000, weight: null, statement: '', sectionTitle: null },
  ];

  const row = (over: Record<string, any>) => ({
    id: over.id,
    text: over.text,
    weight: over.weight ?? 0.8,
    highPriority: false,
    factId: over.factId ?? null,
    locationId: null,
    provenance: over.provenance ?? 'llm',
  });

  const asFree = () => {
    mockResolveAiAccessForFetch.mockResolvedValue('locked');
    mockGetFactSectionSnapshots.mockResolvedValue(FACTS as any);
  };

  const sentTopics = () => mockGetArticleIdsForPersona.mock.calls[0][0].topics as any[];

  beforeEach(() => {
    mockGetAllLocations.mockResolvedValue([]);
    mockGetArticleIdsForPersona.mockResolvedValue({ topicResults: [], headlineResults: [] });
  });

  it('sends ONLY topics under the two oldest facts', async () => {
    asFree();
    mockGetActive.mockResolvedValue([
      row({ id: 't1', text: 'unlocked one', factId: 'f-old' }),
      row({ id: 't2', text: 'unlocked two', factId: 'f-old2' }),
      row({ id: 't3', text: 'locked one', factId: 'f-new' }),
    ] as any);

    await stepFetchTopicIds('p-1', makeCtx());

    expect(sentTopics().map((t) => t.text).sort()).toEqual(['unlocked one', 'unlocked two']);
  });

  it('sends EVERY topic for an entitled user (the filter is inert)', async () => {
    mockResolveAiAccessForFetch.mockResolvedValue('entitled');
    mockGetActive.mockResolvedValue([
      row({ id: 't1', text: 'a', factId: 'f-old' }),
      row({ id: 't3', text: 'b', factId: 'f-new' }),
    ] as any);

    await stepFetchTopicIds('p-1', makeCtx());

    expect(sentTopics()).toHaveLength(2);
  });

  it('sends EVERY topic when the tier is unknown (fails OPEN)', async () => {
    // A cold start that has never resolved a tier must not lock a paying user
    // out of their own feed.
    mockResolveAiAccessForFetch.mockResolvedValue('unknown');
    mockGetActive.mockResolvedValue([
      row({ id: 't1', text: 'a', factId: 'f-old' }),
      row({ id: 't3', text: 'b', factId: 'f-new' }),
    ] as any);

    await stepFetchTopicIds('p-1', makeCtx());

    expect(sentTopics()).toHaveLength(2);
  });

  // ── D26: followed stories are exempt from the lock ──────────────────────

  it('sends a TRACKED topic even though it has no fact (D26)', async () => {
    asFree();
    mockGetActive.mockResolvedValue([
      row({ id: 't3', text: 'locked interest', factId: 'f-new' }),
      row({ id: 't9', text: 'followed story', factId: null, provenance: 'tracked' }),
    ] as any);

    await stepFetchTopicIds('p-1', makeCtx());

    expect(sentTopics().map((t) => t.text)).toEqual(['followed story']);
  });

  it('keeps a tracked-only topic QUOTA-EXEMPT under the cap (the half a filter test misses)', async () => {
    // The billing partition is derived from the same snapshot the filter
    // narrows. If narrowing dropped tracked rows, `freeTopicTexts` would go
    // empty and every followed-story article would start charging against the
    // 100/day cap — silently, since the filter test above would still pass.
    asFree();
    mockGetActive.mockResolvedValue([
      row({ id: 't1', text: 'unlocked interest', factId: 'f-old' }),
      row({ id: 't9', text: 'followed story', factId: null, provenance: 'tracked' }),
    ] as any);

    const result = await stepFetchTopicIds('p-1', makeCtx());

    expect(result.freeTopicTexts).toEqual(new Set(['followed story']));
    expect(sentTopics().find((t) => t.text === 'followed story')?.strictMatch).toBe(true);
  });

  it('a text carried by a tracked topic AND a LOCKED interest is FREE, not charged', async () => {
    // The locked interest is never sent, so the article can only have arrived
    // via the followed story. Charging it would break the promise that
    // following a story never consumes the daily allowance.
    asFree();
    mockGetActive.mockResolvedValue([
      row({ id: 't3', text: 'Gaza Ceasefire', factId: 'f-new' }),
      row({ id: 't9', text: 'gaza ceasefire', factId: null, provenance: 'tracked' }),
    ] as any);

    const result = await stepFetchTopicIds('p-1', makeCtx());

    expect(result.freeTopicTexts).toEqual(new Set(['gaza ceasefire']));
  });

  it('a text carried by a tracked topic AND an UNLOCKED interest stays METERED', async () => {
    // Both are sent, so the article would have arrived anyway. Metered wins.
    asFree();
    mockGetActive.mockResolvedValue([
      row({ id: 't1', text: 'Gaza Ceasefire', factId: 'f-old' }),
      row({ id: 't9', text: 'gaza ceasefire', factId: null, provenance: 'tracked' }),
    ] as any);

    const result = await stepFetchTopicIds('p-1', makeCtx());

    expect(result.freeTopicTexts?.size).toBe(0);
  });

  // ── D28: the depth clamp ────────────────────────────────────────────────

  it('clamps per-topic depth to FREE_TIER_TOPIC_LIMIT', async () => {
    asFree();
    mockGetActive.mockResolvedValue([
      row({ id: 't1', text: 'a', factId: 'f-old', weight: 1 }),
    ] as any);

    await stepFetchTopicIds('p-1', makeCtx());

    expect(sentTopics()[0].limit).toBe(FREE_TIER_TOPIC_LIMIT);
  });

  it('does NOT clamp an entitled user', async () => {
    mockResolveAiAccessForFetch.mockResolvedValue('entitled');
    mockGetActive.mockResolvedValue([
      row({ id: 't1', text: 'a', factId: 'f-old', weight: 1 }),
    ] as any);

    await stepFetchTopicIds('p-1', makeCtx());

    expect(sentTopics()[0].limit).toBeGreaterThan(FREE_TIER_TOPIC_LIMIT);
  });

  // ── SPEC 2 / A-2: degrade instead of throwing ───────────────────────────

  it('degrades to headline scopes when a capped user has ZERO unlocked topics', async () => {
    asFree();
    mockGetAllLocations.mockResolvedValue([
      { countryCode: 'NL', role: 'home', weight: 1, validUntil: null },
    ] as any);
    mockGetActive.mockResolvedValue([
      row({ id: 't3', text: 'locked only', factId: 'f-new' }),
    ] as any);

    const result = await stepFetchTopicIds('p-1', makeCtx());

    expect(sentTopics()).toHaveLength(0);
    expect(mockGetArticleIdsForPersona.mock.calls[0][0].topHeadlines.scopes.length).toBeGreaterThan(0);
    expect(result.serverArticleIds).toEqual([]);
  });

  it('still THROWS for an entitled user with no positively-weighted topics', async () => {
    mockResolveAiAccessForFetch.mockResolvedValue('entitled');
    mockGetAllLocations.mockResolvedValue([
      { countryCode: 'NL', role: 'home', weight: 1, validUntil: null },
    ] as any);
    mockGetActive.mockResolvedValue([
      row({ id: 't1', text: 'a', factId: 'f-old', weight: -1 }),
    ] as any);

    await expect(stepFetchTopicIds('p-1', makeCtx())).rejects.toThrow('no-topics-configured');
  });

  it('degrades via the GLOBAL scope even with NO locations at all', async () => {
    // buildRetrievalProfile pushes a GLOBAL scope unconditionally, so a capped
    // user always has something to degrade to and the sync never dead-ends on
    // an empty unlocked set. Asserted because the fallback in the source reads
    // as if it could throw here, and this records that it cannot.
    asFree();
    mockGetAllLocations.mockResolvedValue([]);
    mockGetActive.mockResolvedValue([
      row({ id: 't3', text: 'locked only', factId: 'f-new' }),
    ] as any);

    const result = await stepFetchTopicIds('p-1', makeCtx());

    const scopes = mockGetArticleIdsForPersona.mock.calls[0][0].topHeadlines.scopes;
    expect(scopes.map((sc: any) => sc.scope)).toEqual(['GLOBAL']);
    expect(result.serverArticleIds).toEqual([]);
  });

  // ── MAJOR 4: the legacy path is a lock and billing bypass ───────────────

  it('a capped user with an EMPTY topics table never takes the legacy path', async () => {
    // fetchTopicIdsLegacy reads fact.metadata.topics for every fact at
    // limitPerTopic 100 and knows nothing about the lock.
    asFree();
    mockGetAllLocations.mockResolvedValue([
      { countryCode: 'NL', role: 'home', weight: 1, validUntil: null },
    ] as any);
    mockGetActive.mockResolvedValue([] as any);

    await stepFetchTopicIds('p-1', makeCtx());

    expect(mockGetArticleIdsForTopics).not.toHaveBeenCalled();
    expect(mockGetArticleIdsForPersona).toHaveBeenCalled();
  });

  it('an ENTITLED user with an empty topics table still takes the legacy path', async () => {
    mockResolveAiAccessForFetch.mockResolvedValue('entitled');
    mockGetActive.mockResolvedValue([] as any);
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 's', metadata: { topics: ['legacy topic'] } },
    ] as any);
    mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });

    await stepFetchTopicIds('p-1', makeCtx());

    expect(mockGetArticleIdsForTopics).toHaveBeenCalled();
    expect(mockGetArticleIdsForPersona).not.toHaveBeenCalled();
  });
});

// ── stepDiff ──────────────────────────────────────────────────────────────────

describe('stepDiff', () => {
  it('throws "aborted" when signal is already aborted', async () => {
    const ctx = makeCtx(true);
    const fetchResult: FetchTopicIdsResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
    };
    await expect(stepDiff(fetchResult, ctx)).rejects.toThrow('aborted');
  });

  it('returns missingIds = serverArticleIds that are not in local store', async () => {
    mockGetLocalSuggestionServerIds.mockResolvedValue(['art-1', 'art-3']);
    const fetchResult: FetchTopicIdsResult = {
      serverArticleIds: ['art-1', 'art-2', 'art-3', 'art-4'],
      articleToTopicTexts: new Map(),
    };

    const ctx = makeCtx();
    const result = await stepDiff(fetchResult, ctx);

    // art-1 and art-3 exist locally; art-2 and art-4 are missing
    expect(result.missingIds).toEqual(expect.arrayContaining(['art-2', 'art-4']));
    expect(result.missingIds).toHaveLength(2);
  });

  it('returns empty missingIds when all server articles are local', async () => {
    mockGetLocalSuggestionServerIds.mockResolvedValue(['art-1', 'art-2']);
    const fetchResult: FetchTopicIdsResult = {
      serverArticleIds: ['art-1', 'art-2'],
      articleToTopicTexts: new Map([['art-1', ['t1']]]),
    };

    const ctx = makeCtx();
    const result = await stepDiff(fetchResult, ctx);

    expect(result.missingIds).toHaveLength(0);
  });

  it('returns all serverArticleIds as missing when local is empty', async () => {
    mockGetLocalSuggestionServerIds.mockResolvedValue([]);
    const fetchResult: FetchTopicIdsResult = {
      serverArticleIds: ['art-1', 'art-2'],
      articleToTopicTexts: new Map(),
    };

    const ctx = makeCtx();
    const result = await stepDiff(fetchResult, ctx);

    expect(result.missingIds).toEqual(['art-1', 'art-2']);
  });

  it('passes through serverArticleIds and articleToTopicTexts unchanged', async () => {
    mockGetLocalSuggestionServerIds.mockResolvedValue([]);
    const topicMap = new Map([['art-1', ['topic-a']]]);
    const fetchResult: FetchTopicIdsResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: topicMap,
    };

    const ctx = makeCtx();
    const result = await stepDiff(fetchResult, ctx);

    expect(result.serverArticleIds).toBe(fetchResult.serverArticleIds);
    expect(result.articleToTopicTexts).toBe(topicMap);
  });

  it('logs missing count via ctx.log', async () => {
    mockGetLocalSuggestionServerIds.mockResolvedValue([]);
    const fetchResult: FetchTopicIdsResult = {
      serverArticleIds: ['art-1', 'art-2', 'art-3'],
      articleToTopicTexts: new Map(),
    };

    const ctx = makeCtx();
    await stepDiff(fetchResult, ctx);

    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('3 missing'));
  });
});

// ── billing partition (followed stories are quota-exempt) ───────────────────

// ── D28: free-tier per-topic depth clamp ─────────────────────────────────────

describe('clampTopicDepth', () => {
  const t = (id: string, limit: number) => ({ topicId: id, text: id, limit, effectiveWeight: 1 });

  it('lowers only the topics above the ceiling', () => {
    const out = clampTopicDepth([t('a', 40), t('b', 8)], 12);
    expect(out.map((x) => x.limit)).toEqual([12, 8]);
  });

  it('never RAISES a topic that asked for less — it is a cap, not an assignment', () => {
    const out = clampTopicDepth([t('a', 8), t('b', 3)], 12);
    expect(out.map((x) => x.limit)).toEqual([8, 3]);
  });

  it('returns the same array identity when nothing exceeds the ceiling (paid path allocates nothing)', () => {
    const input = [t('a', 8), t('b', 12)];
    expect(clampTopicDepth(input, 12)).toBe(input);
  });

  it('does not mutate the input topics', () => {
    const input = [t('a', 40)];
    clampTopicDepth(input, 12);
    expect(input[0].limit).toBe(40);
  });

  it('preserves every other field on a clamped topic', () => {
    const [out] = clampTopicDepth([t('a', 40)], 12);
    expect(out).toEqual({ topicId: 'a', text: 'a', limit: 12, effectiveWeight: 1 });
  });

  it('handles an empty topic list', () => {
    expect(clampTopicDepth([], 12)).toEqual([]);
  });

  it('FREE_TIER_TOPIC_LIMIT keeps four default-weight topics under the 100/day cap', () => {
    // Four topics at the profile's default depth of 40 would request 160 ids
    // against a cap of 100 — the whole day in one sync. The constant exists to
    // make that arithmetic false, so assert the arithmetic, not the literal.
    expect(FREE_TIER_TOPIC_LIMIT * 4).toBeLessThan(100);
  });
});

describe('computeFreeTopicTexts', () => {
  const T = (text: string, provenance: string) => ({ text, provenance });

  it('returns tracked topic texts, normalized', () => {
    const free = computeFreeTopicTexts([
      T('  Gaza   Ceasefire ', 'tracked'),
      T('AI regulation', 'llm'),
    ]);
    expect([...free]).toEqual(['gaza ceasefire']);
  });

  it('subtracts any text also carried by a NON-tracked topic', () => {
    // createTopics dedupes on (normalized_text, fact_id), so a tracked topic
    // (fact_id null) and a fact-owned interest topic can hold the same text.
    // Metered must win, or the interest's articles would hydrate free.
    const free = computeFreeTopicTexts([
      T('gaza ceasefire', 'tracked'),
      T('gaza ceasefire', 'llm'),
    ]);
    expect(free.size).toBe(0);
  });

  it('subtracts on NORMALIZED text, so case/whitespace variants cannot slip past', () => {
    const free = computeFreeTopicTexts([
      T('Gaza Ceasefire', 'tracked'),
      T('  gaza   ceasefire  ', 'user'),
    ]);
    expect(free.size).toBe(0);
  });

  it('ignores blank texts', () => {
    expect(computeFreeTopicTexts([T('   ', 'tracked')]).size).toBe(0);
  });

  it('is empty when nothing is tracked', () => {
    expect(
      computeFreeTopicTexts([T('a', 'llm'), T('b', 'exploration')]).size,
    ).toBe(0);
  });
});

describe('partitionStoryIds', () => {
  const free = new Set(['tracked topic']);

  it('routes a tracked-ONLY article to the free set', () => {
    const map = new Map([['art-1', ['tracked topic']]]);
    expect(partitionStoryIds(['art-1'], map, free)).toEqual({
      storyIds: ['art-1'],
      personaIds: [],
    });
  });

  it('METERED WINS when an article matched a persona topic too', () => {
    const map = new Map([['art-1', ['tracked topic', 'ai regulation']]]);
    expect(partitionStoryIds(['art-1'], map, free)).toEqual({
      storyIds: [],
      personaIds: ['art-1'],
    });
  });

  it('keeps a headline-scope article metered even if its topics are all free', () => {
    const map = new Map([['art-1', ['tracked topic']]]);
    const headlineScope = new Map([['art-1', 'GLOBAL']]);
    expect(partitionStoryIds(['art-1'], map, free, headlineScope)).toEqual({
      storyIds: [],
      personaIds: ['art-1'],
    });
  });

  it('keeps an article with NO matched topics metered', () => {
    expect(partitionStoryIds(['art-1'], new Map(), free)).toEqual({
      storyIds: [],
      personaIds: ['art-1'],
    });
  });

  it('matches on normalized text', () => {
    const map = new Map([['art-1', ['  Tracked   Topic ']]]);
    expect(partitionStoryIds(['art-1'], map, free).storyIds).toEqual(['art-1']);
  });

  it('meters everything when there are no free texts', () => {
    const map = new Map([['art-1', ['tracked topic']]]);
    expect(partitionStoryIds(['art-1'], map, new Set())).toEqual({
      storyIds: [],
      personaIds: ['art-1'],
    });
    expect(partitionStoryIds(['art-1'], map, undefined)).toEqual({
      storyIds: [],
      personaIds: ['art-1'],
    });
  });

  it('outputs are disjoint and their union is exactly the input', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const map = new Map([
      ['a', ['tracked topic']],
      ['b', ['ai regulation']],
      ['c', ['tracked topic', 'ai regulation']],
      // 'd' has no entry at all
    ]);
    const { storyIds, personaIds } = partitionStoryIds(ids, map, free);

    expect(storyIds).toEqual(['a']);
    expect(personaIds).toEqual(['b', 'c', 'd']);
    expect(storyIds.filter((x) => personaIds.includes(x))).toEqual([]);
    expect([...storyIds, ...personaIds].sort()).toEqual([...ids].sort());
  });
});

describe('stepDiff — billing partition', () => {
  it('partitions AFTER the single new-to-device filter, never re-reading local ids', async () => {
    // 'old' is already on device; only 'new-story' and 'new-persona' survive the
    // diff, and the partition splits exactly those.
    mockGetLocalSuggestionServerIds.mockResolvedValue(['old']);
    const result: FetchTopicIdsResult = {
      serverArticleIds: ['old', 'new-story', 'new-persona'],
      articleToTopicTexts: new Map([
        ['old', ['tracked topic']],
        ['new-story', ['tracked topic']],
        ['new-persona', ['ai regulation']],
      ]),
      freeTopicTexts: new Set(['tracked topic']),
    };

    const diff = await stepDiff(result, makeCtx());

    expect(mockGetLocalSuggestionServerIds).toHaveBeenCalledTimes(1);
    expect(diff.missingIds).toEqual(['new-story', 'new-persona']);
    expect(diff.storyIds).toEqual(['new-story']);
    expect(diff.personaIds).toEqual(['new-persona']);
  });

  it('meters everything when the fetch produced no free texts (legacy path)', async () => {
    mockGetLocalSuggestionServerIds.mockResolvedValue([]);
    const result: FetchTopicIdsResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map([['art-1', ['whatever']]]),
    };

    const diff = await stepDiff(result, makeCtx());

    expect(diff.storyIds).toEqual([]);
    expect(diff.personaIds).toEqual(['art-1']);
  });
});

// ── stepHydratePersistEnqueue ───────────────────────────────────────────────

describe('stepHydratePersistEnqueue', () => {
  it('throws "aborted" when signal is already aborted', async () => {
    const ctx = makeCtx(true);
    const diffResult: DiffResult = {
      serverArticleIds: [],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };
    await expect(
      stepHydratePersistEnqueue(diffResult, ctx, makeOpts()),
    ).rejects.toThrow('aborted');
    expect(mockGetArticlesForTopicsByIds).not.toHaveBeenCalled();
  });

  it('hydrates, persists, enqueues eligible ids, and refreshes the store for one chunk', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-1', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    const topicMap = new Map([['art-1', ['topic-a']]]);
    // The gate elects art-1 for scoring (donor-less singleton).
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['art-1'],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: { 'art-1': ['art-1'] },
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: topicMap,
      missingIds: ['art-1'],
    };
    const opts = makeOpts();

    const ctx = makeCtx();
    const result = await stepHydratePersistEnqueue(diffResult, ctx, opts);

    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledWith(
      ['art-1'],
      expect.any(Function),
    );
    expect(mockPersistAndLinkV2Suggestions).toHaveBeenCalledWith(
      [{ _id: 'art-1' }],
      topicMap,
      undefined,
    );
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['art-1'], false, expect.any(Object));
    expect(opts.refreshStore).toHaveBeenCalled();
    expect(result.insertedCount).toBe(1);
    expect(result.enqueuedCount).toBe(1);
    expect(result.dailyLimitReached).toBe(false);
  });

  it('flushes the gate-deferred trailing partial with flushPartial=true once the lot is hydrated', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-1', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['art-1'],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: { 'art-1': ['art-1'] },
    });
    // The pipeline held art-1 back as a sub-25 trailing partial (returned to us).
    mockEnqueueCandidates.mockResolvedValue({ deferred: ['art-1'] });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map([['art-1', ['topic-a']]]),
      missingIds: ['art-1'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // Greedy enqueue then a direct tail flush with flushPartial=true — no extra
    // gate pass (the ids were already elected). The flush carries the SAME gate
    // coverage the greedy pass used, so the flushed remainder is not booked as
    // covering only itself.
    const coverage = { 'art-1': ['art-1'] };
    expect(mockEnqueueCandidates).toHaveBeenNthCalledWith(1, ['art-1'], false, coverage);
    expect(mockEnqueueCandidates).toHaveBeenNthCalledWith(2, ['art-1'], true, coverage);
    expect(mockGateUnscoredForScoring).toHaveBeenCalledTimes(1);
  });

  it('suppressEnqueue: propagates scores but hands nothing to the pipeline', async () => {
    // Set while a scoring run is already in flight. Rows stay Unscored and the
    // pipeline's post-finalize kick re-derives them, so nothing is lost.
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-1', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['art-1'],
      propagatedCount: 2,
      heldBackCount: 0,
      coveredIdsByRep: { 'art-1': ['art-1'] },
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map([['art-1', ['topic-a']]]),
      missingIds: ['art-1'],
    };
    const opts = makeOpts({ suppressEnqueue: true });

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), opts);

    // Hydration + persistence happened as normal...
    expect(mockPersistAndLinkV2Suggestions).toHaveBeenCalled();
    expect(result.insertedCount).toBe(1);
    // ...the propagation half of the gate still ran (that's the cheap win)...
    expect(mockGateUnscoredForScoring).toHaveBeenCalled();
    expect(opts.refreshStore).toHaveBeenCalled();
    // ...but nothing was dispatched, and the count doesn't lie about it.
    expect(mockEnqueueCandidates).not.toHaveBeenCalled();
    expect(result.enqueuedCount).toBe(0);
  });

  it('suppressEnqueue: skips the trailing tail flush too', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-1', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['art-1'],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: { 'art-1': ['art-1'] },
    });
    mockEnqueueCandidates.mockResolvedValue({ deferred: ['art-1'] });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map([['art-1', ['topic-a']]]),
      missingIds: ['art-1'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts({ suppressEnqueue: true }));

    expect(mockEnqueueCandidates).not.toHaveBeenCalled();
  });

  it('does NOT flush a tail when the pipeline deferred nothing', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-1', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['art-1'],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: { 'art-1': ['art-1'] },
    });
    mockEnqueueCandidates.mockResolvedValue({ deferred: [] });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map([['art-1', ['topic-a']]]),
      missingIds: ['art-1'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // Greedy enqueue only — nothing deferred, so no flush call.
    expect(mockEnqueueCandidates).toHaveBeenCalledTimes(1);
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['art-1'], false, expect.any(Object));
  });

  it('migrates legacy follows then fires reconcileTrackedStories fire-and-forget after a successful persist', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // Migration runs synchronously; the reconcile is chained after it resolves,
    // so flush the fire-and-forget microtasks before asserting it ran.
    expect(mockMigrateLegacyTrackedStories).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockReconcileTrackedStories).toHaveBeenCalledTimes(1);
  });

  it('never lets a reconcileTrackedStories failure surface from the sync', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockReconcileTrackedStories.mockRejectedValue(new Error('reconcile boom'));
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };

    // Resolves normally — the sync itself never sees the reconcile failure.
    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());
    expect(result.insertedCount).toBe(1);

    // Flush the fire-and-forget promise's rejection handler.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ component: 'feed-sync-steps' }),
      }),
    );
  });

  it('marks ineligible rows scored and enqueues only the eligible chunk ids', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'good' }, { _id: 'bad' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 2, linkedCount: 2 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'good', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
      { id: 'bad', titleEn: null, descriptionEn: 'd', relatedFacts: [] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['good'],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: { 'good': ['good'] },
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['good', 'bad'],
      articleToTopicTexts: new Map(),
      missingIds: ['good', 'bad'],
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockBatchMarkAsScoredByIds).toHaveBeenCalledWith(['bad']);
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['good'], false, expect.any(Object));
    expect(result.enqueuedCount).toBe(1);
  });

  // P8 site 1 — the defect that kept top headlines from EVER reaching a card.
  // A pure TOP-HEADLINE row is factless by design (synthetic matched topic,
  // `topicId: null`, so no `article_suggestion_facts` row is written). The old
  // `relatedFacts.length === 0` test tombstoned it here — relevance 0, status
  // `complete` — before any scoring existed, and this runs on EVERY chunk over
  // ALL unscored rows, so there was no timing window to escape through.
  it('does NOT tombstone a factless TOP-HEADLINE row, and enqueues it', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'headline' }, { _id: 'orphan' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 2, linkedCount: 0 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      // Factless BUT headline-scoped → must survive and be enqueued.
      {
        id: 'headline',
        titleEn: 't',
        descriptionEn: 'd',
        relatedFacts: [],
        meta: { headlineScope: 'GLOBAL' },
      },
      // Factless and NOT headline-scoped → genuinely orphaned, still tombstoned.
      { id: 'orphan', titleEn: 't', descriptionEn: 'd', relatedFacts: [], meta: { headlineScope: null } },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['headline'],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: { 'headline': ['headline'] },
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['headline', 'orphan'],
      articleToTopicTexts: new Map(),
      missingIds: ['headline', 'orphan'],
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // The headline is NOT in the tombstone batch; the true orphan still is.
    expect(mockBatchMarkAsScoredByIds).toHaveBeenCalledWith(['orphan']);
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['headline'], false, expect.any(Object));
    expect(result.enqueuedCount).toBe(1);
  });

  // A headline row with no text is NOT exempt — no prompt can score empty
  // strings, so the title/description half of the tombstone must still fire.
  it('still tombstones a headline row missing titleEn/descriptionEn', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'headline-no-text' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 0 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      {
        id: 'headline-no-text',
        titleEn: 't',
        descriptionEn: null,
        relatedFacts: [],
        meta: { headlineScope: 'COUNTRY' },
      },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: [],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: {},
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['headline-no-text'],
      articleToTopicTexts: new Map(),
      missingIds: ['headline-no-text'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockBatchMarkAsScoredByIds).toHaveBeenCalledWith(['headline-no-text']);
  });

  it('does NOT enqueue an already-scored id that is not in the current chunk', async () => {
    // getUnscoredSuggestionsWithFacts returns a stale eligible row from a prior
    // chunk; only ids belonging to THIS chunk should be enqueued.
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'chunk-id' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'chunk-id', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
      { id: 'other-chunk-id', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['chunk-id'],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: { 'chunk-id': ['chunk-id'] },
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['chunk-id'],
      articleToTopicTexts: new Map(),
      missingIds: ['chunk-id'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['chunk-id'], false, expect.any(Object));
  });

  it('throws a daily-limit coded error (with resetAt) when the cap left nothing to deliver', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [],
      dailyLimitReached: true,
      resetAt: '2026-06-25T00:00:00.000Z',
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };

    const err = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts()).catch(
      (e) => e,
    );
    expect((err as { code?: string }).code).toBe('daily-limit');
    expect((err as { resetAt?: number }).resetAt).toBe(
      Date.parse('2026-06-25T00:00:00.000Z'),
    );
    expect(mockEnqueueCandidates).not.toHaveBeenCalled();
  });

  it('stops the loop (does NOT throw) when the cap runs dry AFTER some chunks landed', async () => {
    // 26 ids → chunk 1 (25) delivers, chunk 2 (1) hits the cap with 0 articles.
    const missingIds = Array.from({ length: HYDRATE_CHUNK_SIZE + 1 }, (_, i) => `art-${i}`);
    mockGetArticlesForTopicsByIds
      .mockResolvedValueOnce({ articles: [{ _id: 'art-0' }], dailyLimitReached: false })
      .mockResolvedValueOnce({
        articles: [],
        dailyLimitReached: true,
        resetAt: '2026-06-26T00:00:00.000Z',
      });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-0', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['art-0'],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: { 'art-0': ['art-0'] },
    });
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // Both chunks were attempted, but the loop stopped after the dry chunk.
    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledTimes(2);
    expect(result.dailyLimitReached).toBe(true);
    expect(result.resetAt).toBe('2026-06-26T00:00:00.000Z');
    // Chunk 1's article still landed.
    expect(result.insertedCount).toBe(1);
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['art-0'], false, expect.any(Object));
  });

  it('runs the gate + enqueue PER chunk (greedy overlap), not once at the end', async () => {
    const chunk1Ids = Array.from({ length: HYDRATE_CHUNK_SIZE }, (_, i) => `art-${i}`);
    const chunk2Ids = Array.from({ length: 5 }, (_, i) => `art-${HYDRATE_CHUNK_SIZE + i}`);
    const missingIds = [...chunk1Ids, ...chunk2Ids];

    mockGetArticlesForTopicsByIds
      .mockResolvedValueOnce({
        articles: chunk1Ids.map((id) => ({ _id: id })),
        dailyLimitReached: false,
      })
      .mockResolvedValueOnce({
        articles: chunk2Ids.map((id) => ({ _id: id })),
        dailyLimitReached: false,
      });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    // Order-independent: markIneligibleAndCollectEligible scopes to the chunk set,
    // so a single all-eligible result yields the right per-chunk eligible ids.
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue(
      missingIds.map((id) => ({ id, titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] })),
    );
    // Gate returns a fixed elected id each call (one per chunk that had eligibles).
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['elected'],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: { 'elected': ['elected'] },
    });
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // Both chunks persisted eligible rows → the gate+enqueue ran once per chunk
    // (greedy overlap) rather than a single post-loop enqueue.
    expect(mockPersistAndLinkV2Suggestions).toHaveBeenCalledTimes(2);
    expect(mockGateUnscoredForScoring).toHaveBeenCalledTimes(2);
    expect(mockEnqueueCandidates).toHaveBeenCalledTimes(2);
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['elected'], false, expect.any(Object));
    // enqueuedCount accumulates gate.enqueueIds.length across both invocations.
    expect(result.enqueuedCount).toBe(2);
  });

  it('still enqueues once with whatever landed when the daily-limit cuts the run short mid-loop', async () => {
    // 26 ids → chunk 1 (25) delivers eligible ids, chunk 2 (1) hits the cap dry.
    const missingIds = Array.from({ length: HYDRATE_CHUNK_SIZE + 1 }, (_, i) => `art-${i}`);
    mockGetArticlesForTopicsByIds
      .mockResolvedValueOnce({ articles: [{ _id: 'art-0' }], dailyLimitReached: false })
      .mockResolvedValueOnce({
        articles: [],
        dailyLimitReached: true,
        resetAt: '2026-06-26T00:00:00.000Z',
      });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-0', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['art-0'],
      propagatedCount: 0,
      heldBackCount: 0,
      coveredIdsByRep: { 'art-0': ['art-0'] },
    });
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockEnqueueCandidates).toHaveBeenCalledTimes(1);
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['art-0'], false, expect.any(Object));
    expect(result.dailyLimitReached).toBe(true);
    expect(result.enqueuedCount).toBe(1);
  });

  it('processes missingIds in HYDRATE_CHUNK_SIZE chunks (one server query each)', async () => {
    const missingIds = Array.from({ length: HYDRATE_CHUNK_SIZE + 5 }, (_, i) => `art-${i}`);
    mockGetArticlesForTopicsByIds.mockResolvedValue({ articles: [], dailyLimitReached: false });
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // 30 ids → 2 chunks (25 + 5) → 2 calls.
    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledTimes(2);
    expect(mockGetArticlesForTopicsByIds.mock.calls[0][0]).toHaveLength(HYDRATE_CHUNK_SIZE);
    expect(mockGetArticlesForTopicsByIds.mock.calls[1][0]).toHaveLength(5);
  });

  it('routes story ids to the quota-EXEMPT hydrator and persona ids to the metered one', async () => {
    mockGetArticlesForStories.mockResolvedValue({ articles: [{ _id: 'story-1' }] });
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'persona-1' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });

    const topicMap = new Map([
      ['story-1', ['tracked topic']],
      ['persona-1', ['ai regulation']],
    ]);
    const diffResult: DiffResult = {
      serverArticleIds: ['story-1', 'persona-1'],
      articleToTopicTexts: topicMap,
      missingIds: ['story-1', 'persona-1'],
      storyIds: ['story-1'],
      personaIds: ['persona-1'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockGetArticlesForStories).toHaveBeenCalledTimes(1);
    expect(mockGetArticlesForStories.mock.calls[0][0]).toEqual(['story-1']);
    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledTimes(1);
    expect(mockGetArticlesForTopicsByIds.mock.calls[0][0]).toEqual(['persona-1']);

    // A free-path article must still be persisted with the FULL, unfiltered
    // topic map. `matched_topics_json` is the only thing the tracked-story
    // reconcile matches on (tracked-story-reconcile.ts queries
    // `matched_topics_json != null` and reads topicId out of it), so if the
    // billing partition ever narrowed this argument, followed stories would
    // stop growing — the user would get the articles in the Feed but the story
    // timeline would never pick them up. That is the one regression that would
    // make this whole change a net negative.
    const storyPersist = mockPersistAndLinkV2Suggestions.mock.calls.find(
      (c: any[]) => c[0].some((a: any) => a._id === 'story-1'),
    );
    expect(storyPersist).toBeDefined();
    expect(storyPersist![1]).toBe(topicMap);
    expect(storyPersist![1].get('story-1')).toEqual(['tracked topic']);
  });

  it('never sends a story id through the metered hydrator', async () => {
    // The whole point of the wave: a followed-story-only article must not reach
    // articlesForTopicsByIds, because that is the one call that charges quota.
    const diffResult: DiffResult = {
      serverArticleIds: ['story-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['story-1'],
      storyIds: ['story-1'],
      personaIds: [],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockGetArticlesForTopicsByIds).not.toHaveBeenCalled();
    expect(mockGetArticlesForStories).toHaveBeenCalledWith(
      ['story-1'],
      expect.any(Function),
    );
  });

  it('chunks each side independently at HYDRATE_CHUNK_SIZE', async () => {
    const storyIds = Array.from({ length: 30 }, (_, i) => `s-${i}`);
    const personaIds = Array.from({ length: 26 }, (_, i) => `p-${i}`);
    const diffResult: DiffResult = {
      serverArticleIds: [...storyIds, ...personaIds],
      articleToTopicTexts: new Map(),
      missingIds: [...storyIds, ...personaIds],
      storyIds,
      personaIds,
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // 30 → 25 + 5; 26 → 25 + 1. Neither side spills into the other's chunks.
    expect(mockGetArticlesForStories).toHaveBeenCalledTimes(2);
    expect(mockGetArticlesForStories.mock.calls[0][0]).toHaveLength(HYDRATE_CHUNK_SIZE);
    expect(mockGetArticlesForStories.mock.calls[1][0]).toHaveLength(5);
    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledTimes(2);
    expect(mockGetArticlesForTopicsByIds.mock.calls[1][0]).toHaveLength(1);
  });

  it('falls back to METERED for a DiffResult with no partition', async () => {
    // Fail-safe direction: a caller that never partitioned must behave exactly
    // as it did before r12 — charging for everything — not hydrate for free.
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockGetArticlesForStories).not.toHaveBeenCalled();
    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledWith(
      ['art-1'],
      expect.any(Function),
    );
  });

  // ── LOW-band headline cull convergence sweep ─────────────────────────────
  //
  // The persist-time culls in the scoring paths miss two classes of row:
  // pre-feature rows already on device, and rows score propagation stamped
  // terminal `complete` without ever entering the scoring stage. This sweep is
  // what makes the cull converge, so it must run exactly once per step —
  // independent of how many chunks hydrated or whether anything propagated —
  // and must never be able to wedge the step.
  it('sweeps cullable LOW headlines once per step and excludes them', async () => {
    mockGetCullableLowHeadlineIds.mockResolvedValue(['h-1', 'h-2']);
    const diffResult: DiffResult = {
      serverArticleIds: [],
      articleToTopicTexts: new Map(),
      missingIds: [],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockGetCullableLowHeadlineIds).toHaveBeenCalledTimes(1);
    expect(mockBatchMarkExcluded).toHaveBeenCalledWith(['h-1', 'h-2']);
  });

  it('does not write when there is nothing to cull', async () => {
    const diffResult: DiffResult = {
      serverArticleIds: [],
      articleToTopicTexts: new Map(),
      missingIds: [],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockGetCullableLowHeadlineIds).toHaveBeenCalledTimes(1);
    expect(mockBatchMarkExcluded).not.toHaveBeenCalled();
  });

  it('a failing cull sweep is reported but never fails the step', async () => {
    mockGetCullableLowHeadlineIds.mockRejectedValue(new Error('db gone'));
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };

    await expect(
      stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts()),
    ).resolves.toBeDefined();
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('the quota-exempt hydrator can never trip the daily-limit flag', async () => {
    mockGetArticlesForStories.mockResolvedValue({ articles: [{ _id: 'story-1' }] });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    const diffResult: DiffResult = {
      serverArticleIds: ['story-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['story-1'],
      storyIds: ['story-1'],
      personaIds: [],
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(result.dailyLimitReached).toBe(false);
    expect(result.resetAt).toBeUndefined();
  });

  it('skips all work and returns zeros when missingIds is empty', async () => {
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: [],
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockGetArticlesForTopicsByIds).not.toHaveBeenCalled();
    expect(result).toEqual({
      insertedCount: 0,
      enqueuedCount: 0,
      dailyLimitReached: false,
      resetAt: undefined,
    });
  });

  it('reports cumulative progress across chunks', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({ articles: [], dailyLimitReached: false });
    const missingIds = ['art-1', 'art-2'];
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };
    const opts = makeOpts();

    await stepHydratePersistEnqueue(diffResult, makeCtx(), opts);

    // Progress reaches the full total by the end.
    expect(opts.onProgress).toHaveBeenCalledWith(2);
  });

  it('passes signal to withRetry', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };

    const ctx = makeCtx();
    await stepHydratePersistEnqueue(diffResult, ctx, makeOpts());

    expect(mockWithRetry).toHaveBeenCalledWith(expect.any(Function), ctx.signal);
  });

  it('honors mid-loop abort: stops launching chunks beyond the in-flight pool', async () => {
    // 4 chunks; concurrency is HYDRATE_CONCURRENCY (3). The 3 pool workers grab
    // chunks 0,1,2 and fetch concurrently; the first chunk's refreshStore aborts,
    // so the 4th chunk is never launched.
    const missingIds = Array.from(
      { length: HYDRATE_CHUNK_SIZE * 4 },
      (_, i) => `art-${i}`,
    );
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-x' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([]);
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };

    const ctx = makeCtx();
    // Abort on the first chunk's store refresh.
    const opts = makeOpts({
      refreshStore: jest.fn().mockImplementation(async () => {
        ctx.controller.abort();
      }),
    });

    await stepHydratePersistEnqueue(diffResult, ctx, opts);

    // Exactly the initial concurrent pool was fetched — chunk 4 was never launched.
    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledTimes(HYDRATE_CONCURRENCY);
  });

  it('hydrates chunks concurrently (up to HYDRATE_CONCURRENCY fetches in flight)', async () => {
    // 4 chunks; each fetch is deferred so we can observe how many run at once.
    const missingIds = Array.from(
      { length: HYDRATE_CHUNK_SIZE * 4 },
      (_, i) => `art-${i}`,
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];
    mockGetArticlesForTopicsByIds.mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          resolvers.push(() => {
            inFlight--;
            resolve({ articles: [], dailyLimitReached: false });
          });
        }),
    );
    const flush = async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    };
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };

    const p = stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());
    await flush();
    // The pool launched exactly HYDRATE_CONCURRENCY fetches before any resolved.
    expect(maxInFlight).toBe(HYDRATE_CONCURRENCY);

    // Drain: each resolution frees a worker to launch the next chunk.
    while (resolvers.length > 0) {
      resolvers.shift()!();
      await flush();
    }
    await p;
    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledTimes(4);
  });

  it('awaits resume between chunks (pause support)', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({ articles: [], dailyLimitReached: false });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };
    const opts = makeOpts();

    await stepHydratePersistEnqueue(diffResult, makeCtx(), opts);

    expect(opts.awaitResumeIfPaused).toHaveBeenCalled();
  });

  it('runs the skip gate over the in-flight set and enqueues only its elected ids', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'a' }, { _id: 'b' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 2, linkedCount: 2 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'a', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
      { id: 'b', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGetNonTerminalCandidateIds.mockResolvedValue(new Set(['in-flight-id']));
    // a and b are same-sync duplicates → gate elects only 'a', holds 'b' back.
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['a'],
      propagatedCount: 0,
      heldBackCount: 1,
      coveredIdsByRep: { 'a': ['a', 'a-sib'] },
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['a', 'b'],
      articleToTopicTexts: new Map(),
      missingIds: ['a', 'b'],
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // Gate received the in-flight set produced by getNonTerminalCandidateIds
    // plus the (fail-open null) user geo/language context loaded once per run.
    expect(mockGateUnscoredForScoring).toHaveBeenCalledWith(new Set(['in-flight-id']), null);
    // Only the elected representative is enqueued; the held-back sibling is not.
    // Its coverage rides along so the pipeline can count the sibling as an
    // article being analysed rather than reporting one representative.
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['a'], false, {
      a: ['a', 'a-sib'],
    });
    expect(result.enqueuedCount).toBe(1);
  });

  it('refreshes the store when the gate propagated scores, and does not enqueue when it elected nothing', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'a' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'a', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    // Gate propagated a donor's score onto 'a' (nothing left to enqueue).
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: [],
      propagatedCount: 1,
      heldBackCount: 0,
      coveredIdsByRep: {},
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['a'],
      articleToTopicTexts: new Map(),
      missingIds: ['a'],
    };
    const opts = makeOpts();

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), opts);

    // Propagated rows are terminal Complete — surfaced via an extra refreshStore
    // (one for the hydration chunk + one for the propagation).
    expect((opts.refreshStore as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockEnqueueCandidates).not.toHaveBeenCalled();
    expect(result.enqueuedCount).toBe(0);
  });

  it('skips the gate entirely when no eligible ids were collected this sync', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'a' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    // Persisted row is ineligible (no facts) → allEligibleIds empty → gate skipped.
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'a', titleEn: 't', descriptionEn: 'd', relatedFacts: [] },
    ]);
    const diffResult: DiffResult = {
      serverArticleIds: ['a'],
      articleToTopicTexts: new Map(),
      missingIds: ['a'],
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockGateUnscoredForScoring).not.toHaveBeenCalled();
    expect(mockEnqueueCandidates).not.toHaveBeenCalled();
    expect(result.enqueuedCount).toBe(0);
  });
});

// ── stepScore ─────────────────────────────────────────────────────────────────

describe('stepScore', () => {
  it('throws "aborted" when signal is already aborted', async () => {
    // Covers the abort check before the dynamic import
    const ctx = makeCtx(true);
    await expect(stepScore(ctx)).rejects.toThrow('aborted');
    expect(mockRunScoringPass).not.toHaveBeenCalled();
  });

  // NOTE: stepScore uses `await import('@/lib/services/SuggestionSyncService')`
  // which is a dynamic import. Despite jest.mock() being set up for that path,
  // @babel/plugin-transform-modules-commonjs does NOT rewrite dynamic import() calls,
  // so jest's VM throws "A dynamic import callback was invoked without --experimental-vm-modules"
  // when the dynamic import line is actually reached. The runScoringPass() line is therefore
  // unreachable in this test environment. The abort-path is tested above.
});

export {};

// ── already-read exclusion (relevance v3 §3) ────────────────────────────────

describe('stepHydratePersistEnqueue — already-read exclusion', () => {
  const openedImpression = (
    overrides: Record<string, unknown> = {},
  ) => ({ articleId: 'x', stableClusterId: null, titleNorm: null, opened: true, ...overrides });

  it('never persists a hydrated article the user already opened', async () => {
    mockLoadReadStoryIndex.mockResolvedValue(
      buildReadStoryIndex([openedImpression({ articleId: 'art-read' })]),
    );
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-read' }, { _id: 'art-fresh' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });

    const diffResult: DiffResult = {
      serverArticleIds: ['art-read', 'art-fresh'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-read', 'art-fresh'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // Only the fresh article reaches the DB — the read one is never a row, so
    // it is never scored, never rendered, and never needs evicting.
    expect(mockPersistAndLinkV2Suggestions).toHaveBeenCalledWith(
      [{ _id: 'art-fresh' }],
      expect.any(Map),
      undefined,
    );
  });

  it('matches a re-serve on the stored title even when the article id is new', async () => {
    mockLoadReadStoryIndex.mockResolvedValue(
      buildReadStoryIndex([
        openedImpression({
          articleId: 'old-id',
          titleNorm: 'anthropic launches claude opus for enterprise customers',
        }),
      ]),
    );
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [
        {
          _id: 'new-id',
          title_en: 'Anthropic launches Claude Opus for enterprise customers today',
        },
        { _id: 'development', title_en: 'Anthropic faces EU antitrust probe model pricing' },
      ],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });

    const diffResult: DiffResult = {
      serverArticleIds: ['new-id', 'development'],
      articleToTopicTexts: new Map(),
      missingIds: ['new-id', 'development'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // The genuinely new development survives; only the re-serve is dropped.
    const persisted = mockPersistAndLinkV2Suggestions.mock.calls[0][0];
    expect(persisted.map((a: any) => a._id)).toEqual(['development']);
  });

  it('marks an ALREADY-SYNCED unscored row already_read and withholds it from enqueue', async () => {
    mockLoadReadStoryIndex.mockResolvedValue(
      buildReadStoryIndex([openedImpression({ articleId: 'art-old' })]),
    );
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-new' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    // `art-old` was synced on an EARLIER cycle — the pre-persist screen above
    // never sees it, so the global unscored scan is its only defense.
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-old', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
      { id: 'art-new', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);

    const diffResult: DiffResult = {
      serverArticleIds: ['art-new'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-new'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockBatchMarkAlreadyRead).toHaveBeenCalledWith(['art-old']);
    // Not tombstoned as "ineligible" — that would misreport WHY it is invisible.
    expect(mockBatchMarkAsScoredByIds).not.toHaveBeenCalled();
    // ...and the gate still ran for the fresh row.
    expect(mockGateUnscoredForScoring).toHaveBeenCalled();
  });

  it('a chunk that is entirely already-read is still a DELIVERED chunk (no daily-limit throw)', async () => {
    mockLoadReadStoryIndex.mockResolvedValue(
      buildReadStoryIndex([openedImpression({ articleId: 'art-read' })]),
    );
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-read' }],
      dailyLimitReached: true,
      resetAt: '2026-08-06T00:00:00.000Z',
    });

    const diffResult: DiffResult = {
      serverArticleIds: ['art-read'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-read'],
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(result.dailyLimitReached).toBe(true);
    expect(result.insertedCount).toBe(0);
    expect(mockPersistAndLinkV2Suggestions).not.toHaveBeenCalled();
  });

  it('a failed already_read write never fails the sync', async () => {
    mockLoadReadStoryIndex.mockResolvedValue(
      buildReadStoryIndex([openedImpression({ articleId: 'art-old' })]),
    );
    mockBatchMarkAlreadyRead.mockRejectedValue(new Error('db down'));
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-new' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-old', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);

    const diffResult: DiffResult = {
      serverArticleIds: ['art-new'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-new'],
    };

    await expect(
      stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts()),
    ).resolves.toBeDefined();
    expect(mockCaptureException).toHaveBeenCalled();
  });
});
