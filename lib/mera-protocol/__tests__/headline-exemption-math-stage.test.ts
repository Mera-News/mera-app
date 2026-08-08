// P6 — call site 2 of 3: `computeMathStage`, the E2EE pipeline's own hard screen.
//
// This path never enters `computeAndScore`, so it is a SEPARATE convergence
// point for the same matcher: miss it and the exemption holds on the inline
// scoring path but not on the deferred-judge one, which is the path prod
// actually runs.
//
// The persona is assembled from the real DB services, so the hard/soft split is
// exercised for real too — `getActive` returns a strength-1.0 suppression, which
// `loadPersonaScoringContext` must place in `hardSuppressions`.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});
jest.mock('@/lib/llm/cloudComplete', () => ({
  cloudBatchComplete: jest.fn(),
  cloudComplete: jest.fn(),
}));
jest.mock('@/lib/llm/completeLocal', () => ({ completeLocal: jest.fn() }));
jest.mock('@/lib/database/services/calibration-service', () => ({
  getScoringOverrides: jest.fn().mockResolvedValue({}),
  recordOverrides: jest.fn().mockResolvedValue({ count: 0, notified: false }),
}));
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: () => ({ processingMode: 'CLOUD' }) },
}));
jest.mock('@/lib/news-harness-app/logger-adapter', () => ({
  appHarnessLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/database/services/topic-service', () => ({
  getActive: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/database/services/location-service', () => ({
  getAll: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/database/services/publication-preference-service', () => ({
  getActive: jest.fn().mockResolvedValue([]),
}));
const mockGetSuppressions = jest.fn();
jest.mock('@/lib/database/services/suppression-service', () => ({
  ...jest.requireActual('@/lib/database/services/suppression-service'),
  getActive: (...a: unknown[]) => mockGetSuppressions(...a),
}));
jest.mock('@/lib/database/services/fact-service', () => ({
  getFacts: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/database/services/story-impression-service', () => ({
  getOpenedSeenSet: jest.fn().mockResolvedValue(new Set<string>()),
}));

import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import type { ScoringCandidate, StageCandidateRow } from '@/lib/news-harness/core/types';
import { computeMathStage } from '../stage-scoring';

const ENG = DEFAULT_HARNESS_CONFIG.scoringEngine;
const NOW_MS = 1_752_700_000_000;
const RENDER_GATE = 0.3;

const meta = (over: Partial<StageCandidateRow> = {}): StageCandidateRow => ({
  id: 'x',
  titleEn: 'Nvidia unveils a new GPU',
  descriptionEn: 'The chipmaker announced it in Taipei.',
  publicationName: 'The Verge',
  countryCode: 'US',
  firstPubDateMs: NOW_MS - 3_600_000,
  maxClusterSize: 40,
  eventType: 'business',
  category: 'technology',
  geoTagsJson: null,
  entitiesJson: null,
  matchedTopicsJson: null,
  headlineScope: null,
  stableClusterId: null,
  ...over,
});

const candidate = (id: string, over: Partial<StageCandidateRow> = {}): ScoringCandidate => ({
  id,
  titleEn: 'Nvidia unveils a new GPU',
  descriptionEn: 'The chipmaker announced it in Taipei.',
  countryCode: 'US',
  userTopicIds: [],
  relatedFacts: [],
  meta: meta({ id, ...over }),
});

beforeEach(() => {
  jest.clearAllMocks();
  // strength 1.0 ≥ HARD_SUPPRESSION_STRENGTH ⇒ a HARD filter.
  mockGetSuppressions.mockResolvedValue([{ keywords: ['nvidia'], strength: 1 }]);
});

describe('computeMathStage — hard screen (call site 2 of 3)', () => {
  it('drops the normal row and keeps the headline row in the scored stage', async () => {
    const res = await computeMathStage(
      [candidate('normal'), candidate('head', { headlineScope: 'GLOBAL' })],
      NOW_MS,
    );

    expect([...res.excludedIds]).toEqual(['normal']);
    expect(res.excludedValueById.get('normal')).toBe('nvidia');
    expect(res.stage.map((c) => c.input.id)).toEqual(['head']);
  });

  it('reports the kept row so the caller can label it, and scores it demoted', async () => {
    const res = await computeMathStage([candidate('head', { headlineScope: 'GLOBAL' })], NOW_MS);

    expect(res.exemptedValueById.get('head')).toBe('nvidia');
    expect(res.componentsMap.get('head')!.hardFilterExempt).toBe(true);

    const score = res.computedScoreMap.get('head')!;
    expect(score).toBeGreaterThan(RENDER_GATE);
    // Demoted to the bare floor: the unfiltered row would also earn the pop lift.
    expect(score).toBeCloseTo(ENG.HEADLINE_BASE_FLOOR, 10);
  });

  it('leaves the headline untouched when it matches no hard filter', async () => {
    const res = await computeMathStage(
      [candidate('head', { headlineScope: 'GLOBAL', titleEn: 'AMD ships a GPU', descriptionEn: 'In Austin.' })],
      NOW_MS,
    );
    expect(res.exemptedValueById.size).toBe(0);
    expect(res.computedScoreMap.get('head')!).toBeCloseTo(
      ENG.HEADLINE_BASE_FLOOR + ENG.HEADLINE_POP_LIFT,
      10,
    );
  });

  it('changes nothing when the user has no hard filters', async () => {
    mockGetSuppressions.mockResolvedValue([]);
    const res = await computeMathStage(
      [candidate('normal'), candidate('head', { headlineScope: 'GLOBAL' })],
      NOW_MS,
    );
    expect(res.excludedIds.size).toBe(0);
    expect(res.exemptedValueById.size).toBe(0);
    expect(res.stage).toHaveLength(2);
  });
});
