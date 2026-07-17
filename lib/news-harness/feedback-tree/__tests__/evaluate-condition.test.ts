import { evaluateCondition } from '../evaluate-condition';
import type { LocalFeedbackContext } from '../types';

const ctx = (over: Partial<LocalFeedbackContext> = {}): LocalFeedbackContext => ({ ...over });

describe('evaluateCondition', () => {
  it('no condition → visible', () => {
    expect(evaluateCondition(undefined, ctx())).toBe(true);
    expect(evaluateCondition({}, ctx())).toBe(true);
  });

  it('publication_visits_gte gates on visit count', () => {
    expect(evaluateCondition({ publication_visits_gte: 5 }, ctx({ publicationVisits: 5 }))).toBe(true);
    expect(evaluateCondition({ publication_visits_gte: 5 }, ctx({ publicationVisits: 4 }))).toBe(false);
    expect(evaluateCondition({ publication_visits_gte: 5 }, ctx())).toBe(false); // missing → 0
  });

  it('cluster_size_gte gates on cluster size', () => {
    expect(evaluateCondition({ cluster_size_gte: 2 }, ctx({ clusterSize: 2 }))).toBe(true);
    expect(evaluateCondition({ cluster_size_gte: 2 }, ctx({ clusterSize: 1 }))).toBe(false);
  });

  it('has_matched_topics requires at least one real topicId', () => {
    expect(
      evaluateCondition({ has_matched_topics: true }, ctx({ matchedTopics: [{ topicId: 't1', text: 'x' }] })),
    ).toBe(true);
    // synthetic headline matches (topicId null) do NOT satisfy it
    expect(
      evaluateCondition({ has_matched_topics: true }, ctx({ matchedTopics: [{ topicId: null, text: 'x' }] })),
    ).toBe(false);
    expect(evaluateCondition({ has_matched_topics: true }, ctx({ matchedTopics: [] }))).toBe(false);
  });

  it('has_geo_mismatch requires the flag', () => {
    expect(evaluateCondition({ has_geo_mismatch: true }, ctx({ hasGeoMismatch: true }))).toBe(true);
    expect(evaluateCondition({ has_geo_mismatch: true }, ctx({ hasGeoMismatch: false }))).toBe(false);
    expect(evaluateCondition({ has_geo_mismatch: true }, ctx())).toBe(false);
  });

  it('all gates must pass (AND semantics)', () => {
    const cond = { publication_visits_gte: 3, cluster_size_gte: 2 };
    expect(evaluateCondition(cond, ctx({ publicationVisits: 3, clusterSize: 2 }))).toBe(true);
    expect(evaluateCondition(cond, ctx({ publicationVisits: 3, clusterSize: 1 }))).toBe(false);
  });

  it('unknown gate keys are ignored (forward-compat)', () => {
    expect(evaluateCondition({ some_future_gate: 99 } as never, ctx())).toBe(true);
  });
});
