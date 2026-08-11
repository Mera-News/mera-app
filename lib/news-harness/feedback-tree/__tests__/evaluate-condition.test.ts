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

// Added with the `has_event_type` gate. Its original note said the server
// populates `event_type` on "none of ~303k prod articles" — that measured the
// RAW corpus and predates the 2026-07-30 / 2026-08-09 enrichment backfills.
// MEASURED 2026-08-10 over 300 topic-linked prod articles, coverage on SERVED
// articles (the only population a feedback tree sees) is 97%. The gate stays
// for the remaining 3%: there, an ungated event-type leaf renders, applies
// nothing and shows no toast.
describe('evaluateCondition — has_event_type', () => {
  it('requires a non-blank event type', () => {
    expect(evaluateCondition({ has_event_type: true }, ctx({ eventType: 'Earnings call' }))).toBe(true);
    expect(evaluateCondition({ has_event_type: true }, ctx({ eventType: '  ' }))).toBe(false);
    expect(evaluateCondition({ has_event_type: true }, ctx({ eventType: null }))).toBe(false);
    // Today's reality for every article.
    expect(evaluateCondition({ has_event_type: true }, ctx())).toBe(false);
  });

  it('does not gate when the key is absent or false', () => {
    expect(evaluateCondition({ has_event_type: false }, ctx())).toBe(true);
    expect(evaluateCondition({}, ctx())).toBe(true);
  });
});

// v5 — `has_entity`, the gate for "Show less of {{entity}}".
//
// THE TRAP THIS PINS: unknown gate keys are IGNORED for forward-compat, so a
// key that isn't wired into `evaluateCondition` does not hide the node — it
// SHOWS it, on every article, including the ~30% of served articles with no
// entities at all. A typo fails OPEN and silently. The absent-context case is
// therefore the load-bearing assertion, not a formality: it is the only one
// that can tell a working gate from a misspelt one.
describe('evaluateCondition — has_entity', () => {
  it('is FALSE when the context carries no entity (the fail-open trap)', () => {
    expect(evaluateCondition({ has_entity: true }, ctx())).toBe(false);
    expect(evaluateCondition({ has_entity: true }, ctx({ entity: null }))).toBe(false);
    expect(evaluateCondition({ has_entity: true }, ctx({ entity: '   ' }))).toBe(false);
  });

  it('is TRUE once the article carries one', () => {
    expect(evaluateCondition({ has_entity: true }, ctx({ entity: 'Reserve Bank of India' }))).toBe(
      true,
    );
  });

  it('does not gate when the key is absent or false', () => {
    expect(evaluateCondition({ has_entity: false }, ctx())).toBe(true);
    expect(evaluateCondition({}, ctx())).toBe(true);
  });

  it('is genuinely enforced, unlike a key this module does NOT know', () => {
    // The discriminator: a misspelt gate behaves like the second line, not the
    // first. If `has_entity` ever stops being enforced, these two converge.
    expect(evaluateCondition({ has_entity: true }, ctx())).toBe(false);
    expect(evaluateCondition({ has_entitiy: true } as never, ctx())).toBe(true);
  });
});
