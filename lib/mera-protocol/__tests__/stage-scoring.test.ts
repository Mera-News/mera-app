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
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: () => ({ processingMode: 'CLOUD' }) },
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

import { loadPersonaScoringContext } from '../stage-scoring';
import { getOpenedSeenSet } from '@/lib/database/services/story-impression-service';

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
