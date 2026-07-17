import { DEFAULT_HARNESS_CONFIG } from '../../core/config';
import {
  computeRelevance,
  type ScoredCandidateInput,
} from '../relevance';
import type { PersonaScoringContext, PersonaLocationSnapshot } from '../persona-context';

const cfg = DEFAULT_HARNESS_CONFIG.scoringEngine;
const NOW = 1_700_000_000_000;
const OLD = NOW - 100 * 3_600_000; // > 24h → freshness floor
const FRESH = NOW - 1 * 3_600_000; // ≤ 6h → freshness 1.0

// tier helpers (the eval contract: FEED ≥0.40, TANGENTIAL 0.25–0.40, EXCLUDE <0.25)
const isFeed = (s: number) => s >= 0.4;
const isExclude = (s: number) => s < 0.25;

const chhindwara: PersonaLocationSnapshot = {
  id: 'loc-chhindwara', city: 'chhindwara', region: 'madhya pradesh', countryCode: 'IN', role: 'family', weight: 1.0,
};
const amsterdam: PersonaLocationSnapshot = {
  id: 'loc-amsterdam', city: 'amsterdam', region: 'noord-holland', countryCode: 'NL', role: 'home', weight: 1.0,
};

const emptyPersona = (over: Partial<PersonaScoringContext> = {}): PersonaScoringContext => ({
  locations: [],
  pubPrefs: new Map(),
  softSuppressions: [],
  ...over,
});

const candidate = (over: Partial<ScoredCandidateInput> = {}): ScoredCandidateInput => ({
  id: 'a1',
  titleEn: 'title',
  descriptionEn: 'body',
  matchedTopics: [],
  ...over,
});

describe('computeRelevance — core band', () => {
  // Wave 7b breadth cutover: a SOLO topic no longer self-lands in FEED. Breadth
  // (W_TOPIC 0.42→0.32, +W_BREADTH 0.10) intentionally drops a single-topic
  // match to the TANGENTIAL band so the judge decides it — single-topic matches
  // are mostly spurious (golden: only ~14% of solo matches are FEED).
  it('a solo 0.8-weight topic lands BELOW FEED (breadth demotes it to TANGENTIAL)', () => {
    const r = computeRelevance(
      candidate({ matchedTopics: [{ topicId: 't1', effectiveWeight: 0.8 }], pubDateMs: OLD }),
      emptyPersona(),
      cfg,
      NOW,
    );
    expect(r.mode).toBe('backstop'); // no tags → backstop (still math-scored here)
    expect(r.components.topicComp).toBeCloseTo(0.8, 6);
    expect(r.components.breadthComp).toBe(0); // solo → no breadth
    expect(r.components.mathBase).toBeGreaterThanOrEqual(0.25);
    expect(r.components.mathBase).toBeLessThan(0.4);
    expect(isFeed(r.score)).toBe(false);
  });

  it('breadth lifts a multi-topic (3×0.8) match back into FEED', () => {
    const r = computeRelevance(
      candidate({
        matchedTopics: [
          { topicId: 't1', effectiveWeight: 0.8 },
          { topicId: 't2', effectiveWeight: 0.8 },
          { topicId: 't3', effectiveWeight: 0.8 },
        ],
        pubDateMs: OLD,
      }),
      emptyPersona(),
      cfg,
      NOW,
    );
    expect(r.components.breadthComp).toBe(1); // 3 topics saturate BREADTH_SAT=2
    expect(isFeed(r.score)).toBe(true);
  });

  it('vectorScore modulation suppresses a high-weight but weak-similarity topic', () => {
    const strong = computeRelevance(
      candidate({ matchedTopics: [{ topicId: 't1', effectiveWeight: 0.8, vectorScore: 0.95 }] }),
      emptyPersona(),
      cfg,
      NOW,
    );
    const weak = computeRelevance(
      candidate({ matchedTopics: [{ topicId: 't1', effectiveWeight: 0.8, vectorScore: 0.7 }] }),
      emptyPersona(),
      cfg,
      NOW,
    );
    expect(strong.components.topicComp).toBeCloseTo(0.8, 6); // vs≥VS_HI → full
    expect(weak.components.topicComp).toBe(0); // vs<VS_LO → suppressed to 0
  });

  it('a −1 matched topic guts the score to EXCLUDE', () => {
    const r = computeRelevance(
      candidate({ matchedTopics: [{ topicId: 't1', effectiveWeight: -1 }], pubDateMs: FRESH }),
      emptyPersona(),
      cfg,
      NOW,
    );
    expect(r.components.negTopicPenalty).toBeCloseTo(0.45, 6);
    expect(isExclude(r.score)).toBe(true);
    expect(r.score).toBeCloseTo(cfg.BASE_MIN, 6);
  });

  it('effectiveWeight and high_priority are re-clamped to |w| ≤ 1', () => {
    const r = computeRelevance(
      candidate({ matchedTopics: [{ topicId: 't1', effectiveWeight: 0.95, highPriority: true }], pubDateMs: OLD }),
      emptyPersona(),
      cfg,
      NOW,
    );
    // 0.95 × 1.25 = 1.1875 → clamped to 1.0
    expect(r.components.topicComp).toBeCloseTo(1.0, 6);
  });
});

describe('computeRelevance — wrong-location', () => {
  it('wrong-location drops a would-be-FEED (~0.7) into EXCLUDE (~0.15)', () => {
    const dindori = candidate({
      matchedTopics: [{ topicId: 't1', effectiveWeight: 0.8, locationId: 'loc-chhindwara' }],
      geoTags: [{ city: 'dindori', region: 'madhya pradesh', countryCode: 'IN' }],
      eventType: 'weather',
      maxClusterSize: 32, // popComp → 1.0
      pubDateMs: FRESH,
    });
    const r = computeRelevance(dindori, emptyPersona({ locations: [chhindwara] }), cfg, NOW);
    expect(r.components.wrongLocationFlag).toBe(1);
    expect(r.components.base).toBeGreaterThan(0.6); // high before the penalty
    expect(r.components.wrongLocPenalty).toBeCloseTo(0.55, 6);
    expect(isExclude(r.score)).toBe(true);
    expect(r.score).toBeLessThan(0.25);
  });

  it('the SAME story about the followed city stays FEED (no wrong-location)', () => {
    const local = candidate({
      matchedTopics: [{ topicId: 't1', effectiveWeight: 0.8, locationId: 'loc-chhindwara' }],
      geoTags: [{ city: 'chhindwara', region: 'madhya pradesh', countryCode: 'IN' }],
      eventType: 'weather',
      maxClusterSize: 32,
      pubDateMs: FRESH,
    });
    const r = computeRelevance(local, emptyPersona({ locations: [chhindwara] }), cfg, NOW);
    expect(r.components.geoAlignment).toBe('CITY');
    expect(r.components.wrongLocationFlag).toBe(0);
    expect(isFeed(r.score)).toBe(true);
  });
});

describe('computeRelevance — headline floor', () => {
  const popularGlobal = (): ScoredCandidateInput =>
    candidate({
      id: 'h1',
      titleEn: 'Massive global summit on trade',
      matchedTopics: [], // topicComp 0
      headlineScope: 'GLOBAL',
      eventType: 'business',
      maxClusterSize: 40, // popComp saturated
      pubDateMs: FRESH,
    });

  it('a popular GLOBAL headline clears the 0.3 render gate via the floor', () => {
    const r = computeRelevance(popularGlobal(), emptyPersona(), cfg, NOW);
    // pure math base is far below 0.3 …
    expect(r.components.mathBase).toBeLessThan(0.3);
    // … the headline floor lifts it above the gate.
    expect(r.components.base).toBeGreaterThanOrEqual(0.35);
    expect(r.score).toBeGreaterThan(0.3);
  });

  it('a suppression still kills a floored headline (floor is BEFORE penalties)', () => {
    const persona = emptyPersona({
      softSuppressions: [{ keywords: ['trade'], strength: 1.0 }],
    });
    const r = computeRelevance(popularGlobal(), persona, cfg, NOW);
    expect(r.components.suppressPenalty).toBeCloseTo(0.3, 6);
    expect(r.score).toBeLessThan(0.3); // killed despite the floor
  });
});

describe('computeRelevance — EMERGENCY reachability', () => {
  const saturated = (over: Partial<ScoredCandidateInput> = {}): ScoredCandidateInput =>
    candidate({
      id: 'e1',
      publicationName: 'Fav Times',
      // EMERGENCY now also needs breadth (Wave 7b) — a saturated breaking story
      // is multi-topic by nature; 3 anchored topics saturate BREADTH_SAT.
      matchedTopics: [
        { topicId: 't1', effectiveWeight: 1.0, locationId: 'loc-amsterdam' },
        { topicId: 't2', effectiveWeight: 1.0, locationId: 'loc-amsterdam' },
        { topicId: 't3', effectiveWeight: 1.0, locationId: 'loc-amsterdam' },
      ],
      geoTags: [{ city: 'amsterdam', region: 'noord-holland', countryCode: 'NL' }],
      entities: ['ajax'],
      eventType: 'disaster',
      maxClusterSize: 64,
      pubDateMs: NOW, // freshness 1.0
      ...over,
    });
  const fullPersona = (): PersonaScoringContext =>
    emptyPersona({
      locations: [amsterdam],
      pubPrefs: new Map([['fav times', 1.0]]),
      entityInterest: new Map([['ajax', 1.0]]),
    });

  it('reaches EMERGENCY (>1.0) only at saturation WITH pub + entity contributions', () => {
    const r = computeRelevance(saturated(), fullPersona(), cfg, NOW);
    expect(r.score).toBeGreaterThan(cfg.BASE_MAX - 0.05); // near the 1.10 ceiling
    expect(r.score).toBeGreaterThan(DEFAULT_HARNESS_CONFIG.articlePipeline.emergencyPriorityCutoff);
  });

  it('without pub + entity the same saturated story stays below EMERGENCY', () => {
    const r = computeRelevance(saturated(), emptyPersona({ locations: [amsterdam] }), cfg, NOW);
    expect(r.score).toBeLessThanOrEqual(DEFAULT_HARNESS_CONFIG.articlePipeline.emergencyPriorityCutoff);
  });
});

describe('computeRelevance — mode + clamps + monotonicity', () => {
  it('no geo_tags AND no entities AND no event_type → backstop mode', () => {
    const r = computeRelevance(candidate({ matchedTopics: [{ topicId: 't', effectiveWeight: 0.5 }] }), emptyPersona(), cfg, NOW);
    expect(r.mode).toBe('backstop');
  });

  it('any tag (even event_type "other") → math mode', () => {
    const r = computeRelevance(candidate({ eventType: 'other', matchedTopics: [{ topicId: 't', effectiveWeight: 0.5 }] }), emptyPersona(), cfg, NOW);
    expect(r.mode).toBe('math');
  });

  it('score never leaves [BASE_MIN, BASE_MAX]', () => {
    const hi = computeRelevance(
      candidate({ matchedTopics: [{ topicId: 't', effectiveWeight: 1 }], geoTags: [{ city: 'amsterdam', countryCode: 'NL' }], pubDateMs: NOW, maxClusterSize: 999 }),
      emptyPersona({ locations: [amsterdam], pubPrefs: new Map([['title', 1]]) }),
      cfg,
      NOW,
    );
    expect(hi.score).toBeLessThanOrEqual(cfg.BASE_MAX);
    expect(hi.score).toBeGreaterThanOrEqual(cfg.BASE_MIN);
  });

  it('adding a stronger positive matched topic never lowers the score', () => {
    const base = computeRelevance(
      candidate({ matchedTopics: [{ topicId: 't1', effectiveWeight: 0.5 }], pubDateMs: OLD }),
      emptyPersona(),
      cfg,
      NOW,
    );
    const stronger = computeRelevance(
      candidate({ matchedTopics: [{ topicId: 't1', effectiveWeight: 0.5 }, { topicId: 't2', effectiveWeight: 0.9 }], pubDateMs: OLD }),
      emptyPersona(),
      cfg,
      NOW,
    );
    expect(stronger.score).toBeGreaterThanOrEqual(base.score);
    expect(stronger.components.topicComp).toBeCloseTo(0.9, 6);
  });
});
