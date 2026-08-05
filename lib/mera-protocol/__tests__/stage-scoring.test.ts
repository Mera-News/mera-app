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
// Mutable so the RELEVANCE_V3 cases below can flip the runtime flag between
// awaits — `effectiveHarnessConfig` reads the store at CALL time, so no
// resetModules/dynamic-require dance is needed (unlike the env-bound half).
const mockStoreState: { processingMode: string; relevanceV3: boolean } = {
  processingMode: 'CLOUD',
  relevanceV3: false,
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

import { effectiveHarnessConfig, loadPersonaScoringContext } from '../stage-scoring';
import { getOpenedSeenSet } from '@/lib/database/services/story-impression-service';
import { HARNESS_CONFIG_BASE } from '../harness-config-base';
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
describe('effectiveHarnessConfig — the relevanceV3 runtime switch', () => {
  beforeEach(() => {
    mockStoreState.relevanceV3 = false;
    (getScoringOverrides as jest.Mock).mockResolvedValue({});
  });

  it('flag OFF: hands back the HARNESS_CONFIG_BASE REFERENCE (no allocation)', async () => {
    // Reference equality, not deep equality — the whole point of the fast path.
    // A copy here would be behaviourally identical but silently allocate on
    // every scoring batch, and it is what harness-config-base.test.ts pins.
    const cfg = await effectiveHarnessConfig();
    expect(cfg).toBe(HARNESS_CONFIG_BASE);
    expect(cfg.scoringEngine.RELEVANCE_V3).toBe(false);
  });

  it('flag ON: RELEVANCE_V3 true, USE_ARTICLE_TAGS untouched, nothing else moved', async () => {
    mockStoreState.relevanceV3 = true;
    const cfg = await effectiveHarnessConfig();
    expect(cfg.scoringEngine.RELEVANCE_V3).toBe(true);
    // v3 is independent of tag policy — no forcing, no subsumption.
    expect(cfg.scoringEngine.USE_ARTICLE_TAGS).toBe(
      HARNESS_CONFIG_BASE.scoringEngine.USE_ARTICLE_TAGS,
    );
    // ...and nothing else moved: no weight, offset or penalty is touched.
    expect({
      ...cfg.scoringEngine,
      RELEVANCE_V3: false,
    }).toEqual(HARNESS_CONFIG_BASE.scoringEngine);
    // Sibling sub-configs pass through by reference — this is a scoring-engine
    // concern only.
    expect(cfg.articlePipeline).toBe(HARNESS_CONFIG_BASE.articlePipeline);
    expect(cfg.topicGen).toBe(HARNESS_CONFIG_BASE.topicGen);
  });

  it('flag ON still layers the calibration overrides on top', async () => {
    mockStoreState.relevanceV3 = true;
    (getScoringOverrides as jest.Mock).mockResolvedValue({ W_TOPIC: 0.1 });
    const cfg = await effectiveHarnessConfig();
    expect(cfg.scoringEngine.RELEVANCE_V3).toBe(true);
    expect(cfg.scoringEngine.W_TOPIC).toBeCloseTo(
      HARNESS_CONFIG_BASE.scoringEngine.W_TOPIC * 1.1,
      6,
    );
  });

  it('FAILS OPEN to HARNESS_CONFIG_BASE (v3 off) when the overrides read throws', async () => {
    mockStoreState.relevanceV3 = true;
    (getScoringOverrides as jest.Mock).mockRejectedValue(new Error('db down'));
    const cfg = await effectiveHarnessConfig();
    expect(cfg).toBe(HARNESS_CONFIG_BASE);
    expect(cfg.scoringEngine.RELEVANCE_V3).toBe(false);
  });
});
