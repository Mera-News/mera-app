// stage-scoring — loadPersonaScoringContext seam test (Wave 7b integration).
// Verifies the persona snapshot wiring: seenStoryIds comes from the OPENS-ONLY
// story-impression reader (user decision: impressions never demote), and
// entityInterest stays deliberately unset (later wave).

jest.mock('@/lib/llm/cloudComplete', () => ({
  cloudBatchComplete: jest.fn(),
  cloudComplete: jest.fn(),
}));
jest.mock('@/lib/llm/completeLocal', () => ({ completeLocal: jest.fn() }));
jest.mock('@/lib/database/services/calibration-service', () => ({
  getScoringOverrides: jest.fn().mockResolvedValue({}),
  recordOverrides: jest.fn().mockResolvedValue({ count: 0, notified: false }),
}));
// Mutable so the relevance-v4 cases below can flip the runtime flag between
// awaits — `effectiveHarnessConfig` reads the store at CALL time, so no
// resetModules/dynamic-require dance is needed (unlike the env-bound half).
const mockStoreState: { processingMode: string; relevanceV4: boolean } = {
  processingMode: 'CLOUD',
  relevanceV4: false,
};
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: () => mockStoreState },
}));
jest.mock('@/lib/news-harness-app/logger-adapter', () => ({
  appHarnessLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/database/services/topic-service', () => ({
  getActive: jest.fn().mockResolvedValue([
    { id: 't1', weight: 0.8, highPriority: false, factId: 'f1', locationId: null },
  ]),
}));
jest.mock('@/lib/database/services/location-service', () => ({
  getAll: jest.fn().mockResolvedValue([
    { id: 'loc1', city: 'Bhopal', region: 'Madhya Pradesh', countryCode: 'in', role: 'family', weight: 1, validUntil: null },
  ]),
}));
jest.mock('@/lib/database/services/publication-preference-service', () => ({
  getActive: jest.fn().mockResolvedValue([{ publicationName: 'Fav Times', weight: 0.5 }]),
}));
jest.mock('@/lib/database/services/suppression-service', () => ({
  getActive: jest.fn().mockResolvedValue([{ keywords: ['celebrity gossip'], strength: 0.5 }]),
}));
jest.mock('@/lib/database/services/fact-service', () => ({
  getFacts: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getFactWeightById: jest.fn().mockResolvedValue(new Map([['f1', 0.5]])),
  buildStageCandidateInput: jest.fn(),
}));
jest.mock('@/lib/database/services/story-impression-service', () => ({
  getOpenedSeenSet: jest.fn().mockResolvedValue(new Set(['opened-article', 'stable-story-1'])),
}));

import {
  buildStageCandidates,
  effectiveHarnessConfig,
  loadPersonaScoringContext,
} from '../stage-scoring';
import { getOpenedSeenSet } from '@/lib/database/services/story-impression-service';
import { buildStageCandidateInput } from '@/lib/database/services/article-suggestion-service';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { screenHardSuppressions } from '@/lib/news-harness/scoring-engine';
import { getScoringOverrides } from '@/lib/database/services/calibration-service';

describe('loadPersonaScoringContext — persona snapshot seam', () => {
  it('populates seenStoryIds from the OPENS-ONLY reader and leaves entityInterest unset', async () => {
    const { persona, topicWeights } = await loadPersonaScoringContext(1_700_000_000_000);

    // seen = opens only: the set is exactly what getOpenedSeenSet returned.
    expect(getOpenedSeenSet).toHaveBeenCalledTimes(1);
    expect(persona.seenStoryIds).toEqual(new Set(['opened-article', 'stable-story-1']));

    // entityInterest is deliberately NOT wired yet (entityComp reads 0).
    expect(persona.entityInterest).toBeUndefined();

    // sanity on the rest of the snapshot wiring:
    expect(topicWeights.get('t1')).toEqual({
      effectiveWeight: 0.4, // 0.8 topic × 0.5 fact weight
      highPriority: false,
      locationId: undefined,
    });
    expect(persona.locations[0]).toMatchObject({ city: 'bhopal', countryCode: 'IN' }); // normalized
    expect(persona.pubPrefs.get('fav times')).toBe(0.5);
    expect(persona.softSuppressions).toEqual([{ keywords: ['celebrity gossip'], strength: 0.5 }]);
  });
});

// effectiveHarnessConfig is the composition root for BOTH env-bound and runtime
// config. `lib/news-harness/**` is RN-free and must never read the store, and
// the calibration-overrides layer is a closed NUMERIC allowlist, so this is the
// only place a boolean routing switch can enter the config.
describe('effectiveHarnessConfig — the relevance-v4 runtime switch', () => {
  beforeEach(() => {
    mockStoreState.relevanceV4 = false;
    (getScoringOverrides as jest.Mock).mockResolvedValue({});
  });

  it('flag OFF: hands back the DEFAULT_HARNESS_CONFIG REFERENCE (no allocation)', async () => {
    // Reference equality, not deep equality — the whole point of the fast path.
    // A copy here would be behaviourally identical but silently allocate on
    // every scoring batch, and it is what harness-config-base.test.ts pins.
    const cfg = await effectiveHarnessConfig();
    expect(cfg).toBe(DEFAULT_HARNESS_CONFIG);
    expect(cfg.articlePipeline.legacyTagPromptEnabled).toBe(false);
    expect(cfg.articlePipeline.legacyTagReasonGateEnabled).toBe(false);
  });

  it('flag ON: BOTH tag features on — one switch, two flags', async () => {
    mockStoreState.relevanceV4 = true;
    const cfg = await effectiveHarnessConfig();
    // They were measured together and ship together. A build where the toggle
    // moved only one of them would be a configuration nobody measured.
    expect(cfg.articlePipeline.legacyTagPromptEnabled).toBe(true);
    expect(cfg.articlePipeline.legacyTagReasonGateEnabled).toBe(true);
  });

  it('flag ON: the whole scoringEngine is UNTOUCHED', async () => {
    mockStoreState.relevanceV4 = true;
    const cfg = await effectiveHarnessConfig();
    // v4 moves the PROMPT, never the engine. The scoringEngine slice must pass
    // through BY REFERENCE so the calibration fast path below short-circuits —
    // and so a future edit cannot couple the scoring-prompt toggle to what a
    // user's suppression filters match.
    expect(cfg.scoringEngine).toBe(DEFAULT_HARNESS_CONFIG.scoringEngine);
    expect(cfg.topicGen).toBe(DEFAULT_HARNESS_CONFIG.topicGen);
  });

  it('flag ON: nothing in articlePipeline moved except the two v4 flags', async () => {
    mockStoreState.relevanceV4 = true;
    const cfg = await effectiveHarnessConfig();
    expect({
      ...cfg.articlePipeline,
      legacyTagPromptEnabled: false,
      legacyTagReasonGateEnabled: false,
    }).toEqual(DEFAULT_HARNESS_CONFIG.articlePipeline);
  });

  it('flag ON still layers the calibration overrides on top', async () => {
    mockStoreState.relevanceV4 = true;
    (getScoringOverrides as jest.Mock).mockResolvedValue({ W_TOPIC: 0.1 });
    const cfg = await effectiveHarnessConfig();
    expect(cfg.articlePipeline.legacyTagPromptEnabled).toBe(true);
    expect(cfg.scoringEngine.W_TOPIC).toBeCloseTo(
      DEFAULT_HARNESS_CONFIG.scoringEngine.W_TOPIC * 1.1,
      6,
    );
  });

  it('FAILS OPEN to DEFAULT_HARNESS_CONFIG (v4 off) when the overrides read throws', async () => {
    mockStoreState.relevanceV4 = true;
    (getScoringOverrides as jest.Mock).mockRejectedValue(new Error('db down'));
    const cfg = await effectiveHarnessConfig();
    expect(cfg).toBe(DEFAULT_HARNESS_CONFIG);
    expect(cfg.articlePipeline.legacyTagPromptEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE SEAM WHERE THE TAG BLANKING USED TO LIVE.
//
// `buildStageCandidates` is the ONE place a persisted row becomes an engine
// input, and until `USE_ARTICLE_TAGS` was deleted it ran every input through
// `applyArticleTagPolicy`, which blanked `geoTags` / `entities` / `eventType`.
// Both the tests below FAIL against that code — they are the regression guard
// for the bug that blanking caused: the card feedback surface mints
// `event_type` / `entity` / `place` suppressions, and `suppression.ts` matches
// them against exactly the columns that were being cleared, so those filters
// were stored, shown to the user, and matched nothing.
//
// Deliberately at this seam rather than on the matcher: the matcher was never
// broken. Only this seam was, which is why a unit test over
// `suppressionMatchesCandidate` alone would have passed before the fix too.
// ---------------------------------------------------------------------------

describe('buildStageCandidates — the engine sees the server tags', () => {
  // `buildStageCandidateInput` (the row → input parser) is mocked, which is
  // exactly the isolation this needs: the parser never changed, the BLANKING
  // STEP after it did. Feed the seam a tagged input and assert it comes out
  // tagged. Pre-change, `applyArticleTagPolicy` sat between these two lines and
  // cleared all three fields, so both tests below went red.
  const taggedInput = {
    id: 'a0',
    titleEn: 'Commission opens antitrust case',
    descriptionEn: 'Brussels probe',
    matchedTopics: [],
    geoTags: [{ city: 'brussels', countryCode: 'BEL' }],
    entities: ['european commission'],
    eventType: 'crime',
  };

  const candidate = {
    id: 'a0',
    titleEn: 'Commission opens antitrust case',
    descriptionEn: 'Brussels probe',
    countryCode: 'BEL',
    userTopicIds: [],
    relatedFacts: [],
    meta: { id: 'a0' },
  };

  beforeEach(() => {
    (buildStageCandidateInput as jest.Mock).mockReturnValue(taggedInput);
  });

  it('passes geoTags / entities / eventType through unblanked', () => {
    const [stage] = buildStageCandidates([candidate as never], new Map());
    expect(stage.input.eventType).toBe('crime');
    expect(stage.input.entities).toEqual(['european commission']);
    expect(stage.input.geoTags).toEqual([{ city: 'brussels', countryCode: 'BEL' }]);
  });

  it("a user's event_type filter now screens the row out", () => {
    // The exact row shape `feedback-tree/resolve-leaf-actions.ts` writes from
    // `from_context_eventType`. This is the user-facing bug: before the fix the
    // filter was created, stored, shown back to the user — and screened nothing.
    const [stage] = buildStageCandidates([candidate as never], new Map());
    const dropped = screenHardSuppressions(
      [stage.input],
      [{ keywords: [], strength: 1, kind: 'event_type', value: 'crime' }],
    );
    expect([...dropped.keys()]).toEqual(['a0']);
  });
});
