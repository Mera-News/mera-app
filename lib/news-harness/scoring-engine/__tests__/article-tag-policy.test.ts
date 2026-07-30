// EXPO_PUBLIC_USE_ARTICLE_TAGS — the engine-side half.
//
// The flag decides whether the app HONOURS the server's article-tagging
// metadata. Off (the default) every article is presented to the scoring engine
// as untagged, so it routes to the legacy two-pass LLM (`backstop`) path exactly
// as it does in production today, where the enrichment stage has never run. On,
// a tagged article takes the deterministic math path.
//
// These tests pin BOTH directions plus the default, so flipping the default
// literal in core/config.ts fails loudly rather than silently re-routing every
// article the first time staging emits a tag.

import { DEFAULT_HARNESS_CONFIG, type ScoringEngineConfig } from '../../core/config';
import { computeRelevance, type ScoredCandidateInput } from '../relevance';
import { applyArticleTagPolicy, applyArticleTagPolicyAll } from '../tag-policy';
import type { PersonaScoringContext } from '../persona-context';

const NOW = Date.UTC(2026, 6, 30);

const OFF: ScoringEngineConfig = DEFAULT_HARNESS_CONFIG.scoringEngine;
const ON: ScoringEngineConfig = { ...OFF, USE_ARTICLE_TAGS: true };

/** A persona that cares about Bhopal, Nvidia, and has a "shown less" filter on
 *  the entity `nvidia` — so every tag-derived signal is observable. */
function persona(over: Partial<PersonaScoringContext> = {}): PersonaScoringContext {
  return {
    locations: [{ id: 'loc-1', city: 'bhopal', countryCode: 'IN', role: 'home', weight: 1 }],
    pubPrefs: new Map(),
    softSuppressions: [],
    hardSuppressions: [],
    entityInterest: new Map([['nvidia', 1]]),
    ...over,
  };
}

/** FULLY TAGGED: geo tags AND entities AND an event type — the article shape
 *  staging will start producing once enrichment is enabled. */
function tagged(over: Partial<ScoredCandidateInput> = {}): ScoredCandidateInput {
  return {
    id: 'art-1',
    titleEn: 'Nvidia opens a Bhopal campus',
    descriptionEn: 'The chipmaker announced the site today.',
    countryCode: 'IN',
    eventType: 'business',
    category: 'technology',
    geoTags: [{ city: 'bhopal', countryCode: 'IN' }],
    entities: ['Nvidia'],
    matchedTopics: [{ topicId: 't-1', text: 'chips', effectiveWeight: 0.5 }],
    ...over,
  };
}

describe('DEFAULT_HARNESS_CONFIG — the shipped default', () => {
  // THE MUTATION TARGET. Flipping this literal to `true` must fail this test
  // AND the "behaves as today" test below; that pair is what makes the default
  // a deliberate choice rather than an accident.
  it('ships with article tags OFF', () => {
    expect(DEFAULT_HARNESS_CONFIG.scoringEngine.USE_ARTICLE_TAGS).toBe(false);
  });

  it('states the default explicitly rather than leaving it undefined', () => {
    expect('USE_ARTICLE_TAGS' in DEFAULT_HARNESS_CONFIG.scoringEngine).toBe(true);
    expect(typeof DEFAULT_HARNESS_CONFIG.scoringEngine.USE_ARTICLE_TAGS).toBe('boolean');
  });
});

describe('applyArticleTagPolicy — routing', () => {
  it('flag OFF (the default): a FULLY TAGGED article is still treated as backstop', () => {
    const r = computeRelevance(applyArticleTagPolicy(tagged(), OFF), persona(), OFF, NOW);
    expect(r.mode).toBe('backstop');
  });

  it('flag ON: the same article takes the math path', () => {
    const r = computeRelevance(applyArticleTagPolicy(tagged(), ON), persona(), ON, NOW);
    expect(r.mode).toBe('math');
  });

  it('an untagged article is backstop under BOTH policies (nothing to honour)', () => {
    const bare = tagged({ geoTags: [], entities: [], eventType: null });
    expect(computeRelevance(applyArticleTagPolicy(bare, OFF), persona(), OFF, NOW).mode)
      .toBe('backstop');
    expect(computeRelevance(applyArticleTagPolicy(bare, ON), persona(), ON, NOW).mode)
      .toBe('backstop');
  });
});

describe('applyArticleTagPolicy — the tags are not merely ignored for routing', () => {
  // Gating ONLY `isBackstop` would leave the geo/entity/event score components
  // and the suppression matcher reading the tags. These pin that "off" means
  // the engine never sees them at all.
  it('flag OFF zeroes every tag-derived score component', () => {
    const c = computeRelevance(applyArticleTagPolicy(tagged(), OFF), persona(), OFF, NOW)
      .components;
    expect(c.geoComp).toBe(0);
    expect(c.entityComp).toBe(0);
    expect(c.eventComp).toBe(0);
  });

  it('flag ON lets those same components fire', () => {
    const c = computeRelevance(applyArticleTagPolicy(tagged(), ON), persona(), ON, NOW).components;
    expect(c.geoComp).toBeGreaterThan(0);
    expect(c.entityComp).toBeGreaterThan(0);
  });

  it('flag OFF makes an entity-kind suppression inert; ON makes it bite', () => {
    const p = persona({
      softSuppressions: [{ keywords: [], kind: 'entity', value: 'nvidia', strength: 1 }],
    });
    const off = computeRelevance(applyArticleTagPolicy(tagged(), OFF), p, OFF, NOW);
    const on = computeRelevance(applyArticleTagPolicy(tagged(), ON), p, ON, NOW);
    expect(off.components.suppressPenalty).toBe(0);
    expect(on.components.suppressPenalty).toBeGreaterThan(0);
  });

  it('does NOT strip category — it is not part of the untagged predicate and is populated today', () => {
    expect(applyArticleTagPolicy(tagged(), OFF).category).toBe('technology');
  });
});

describe('applyArticleTagPolicy — allocation behaviour', () => {
  it('returns the SAME reference when the policy is ON', () => {
    const input = tagged();
    expect(applyArticleTagPolicy(input, ON)).toBe(input);
  });

  it('returns the SAME reference when the row is already untagged (today’s prod path)', () => {
    const input = tagged({ geoTags: [], entities: [], eventType: null });
    expect(applyArticleTagPolicy(input, OFF)).toBe(input);
  });

  it('the batch form returns the SAME array when nothing changes', () => {
    const inputs = [tagged({ geoTags: [], entities: [], eventType: null })];
    expect(applyArticleTagPolicyAll(inputs, OFF)).toBe(inputs);
    expect(applyArticleTagPolicyAll(inputs, ON)).toBe(inputs);
  });

  it('the batch form strips every tagged row when the policy is OFF', () => {
    const out = applyArticleTagPolicyAll([tagged({ id: 'a' }), tagged({ id: 'b' })], OFF);
    for (const i of out) {
      expect(i.geoTags).toEqual([]);
      expect(i.entities).toEqual([]);
      expect(i.eventType).toBeNull();
    }
  });
});

describe('RelevanceComponents.mode — the persisted audit record', () => {
  // `score_components_json` is JSON.stringify(components) at both persist sites,
  // so carrying `mode` here is what makes the math-vs-LLM split readable after
  // the fact without a new column.
  it('records the path that scored the row', () => {
    expect(computeRelevance(applyArticleTagPolicy(tagged(), OFF), persona(), OFF, NOW)
      .components.mode).toBe('backstop');
    expect(computeRelevance(applyArticleTagPolicy(tagged(), ON), persona(), ON, NOW)
      .components.mode).toBe('math');
  });

  it('survives a JSON round trip (that is how it is stored)', () => {
    const { components } = computeRelevance(tagged(), persona(), ON, NOW);
    expect(JSON.parse(JSON.stringify(components)).mode).toBe('math');
  });
});
