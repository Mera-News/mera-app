// relevance v3 — the shared core: one band ladder, the two-axis blend, the v3
// response decoder, and the interest-evidence rescue floor.
//
// These four are the contract the rest of the v3 work codes against, so the
// cases below are written as CONTRACT tests: exact cutoff edges, exact blend
// landmarks, and the decoder's null-on-structural-mismatch rule (callers retry
// on null — a padded batch would silently lose its reasons).

import {
  bandOf,
  bandRank,
  bucketOf,
  bucketRank,
  applyInterestRescueFloor,
  type RelevanceBand,
} from '../feed-select/ownership';
import { blendToScore } from '../article-pipeline/scoring';
import {
  parseScoreV3Response,
  CLOUD_SCORE_V3_SYSTEM_PROMPT,
  CLOUD_HEADLINE_SCORE_V3_SYSTEM_PROMPT,
} from '../prompts/prompts';
import { DEFAULT_HARNESS_CONFIG } from '../core/config';
import type {
  MatchedTopicInput,
  RelevanceComponents,
} from '../scoring-engine/relevance';

// --- bandOf / bandRank ----------------------------------------------------

describe('bandOf — the single relevance ladder', () => {
  it('maps each cutoff edge to its band', () => {
    // EMERGENCY is strictly greater than 1.0 — 1.0 itself is HIGH.
    expect(bandOf(1.1)).toBe('EMERGENCY');
    expect(bandOf(1.0001)).toBe('EMERGENCY');
    expect(bandOf(1.0)).toBe('HIGH');
    expect(bandOf(0.8)).toBe('HIGH');
    expect(bandOf(0.7999)).toBe('MEDIUM');
    expect(bandOf(0.6)).toBe('MEDIUM');
    expect(bandOf(0.5999)).toBe('LOW');
    expect(bandOf(0.4)).toBe('LOW');
    expect(bandOf(0.3999)).toBe('SUB_GATE');
  });

  it('treats missing / sentinel / non-finite values as SUB_GATE', () => {
    expect(bandOf(null)).toBe('SUB_GATE');
    expect(bandOf(undefined)).toBe('SUB_GATE');
    expect(bandOf(-1)).toBe('SUB_GATE');
    expect(bandOf(NaN)).toBe('SUB_GATE');
  });

  it('reads its cutoffs from config rather than hardcoding them', () => {
    const cfg = {
      ...DEFAULT_HARNESS_CONFIG,
      articlePipeline: {
        ...DEFAULT_HARNESS_CONFIG.articlePipeline,
        discardFloor: 0.5,
      },
    };
    expect(bandOf(0.45)).toBe('LOW'); // default config
    expect(bandOf(0.45, cfg)).toBe('SUB_GATE'); // raised floor
  });

  it('ranks bands EMERGENCY 4 … SUB_GATE 0, strictly monotone', () => {
    const ordered: RelevanceBand[] = [
      'SUB_GATE',
      'LOW',
      'MEDIUM',
      'HIGH',
      'EMERGENCY',
    ];
    expect(ordered.map(bandRank)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('bucketOf — compatibility alias', () => {
  it('agrees with bandOf everywhere, with SUB_GATE reported as UNSCORED', () => {
    for (const v of [1.1, 1.0, 0.8, 0.6, 0.4, 0.39, -1]) {
      const band = bandOf(v);
      expect(bucketOf(v)).toBe(band === 'SUB_GATE' ? 'UNSCORED' : band);
    }
    expect(bucketOf(null)).toBe('UNSCORED');
  });

  it('ranks identically to bandRank', () => {
    expect(bucketRank('UNSCORED')).toBe(bandRank('SUB_GATE'));
    expect(bucketRank('LOW')).toBe(bandRank('LOW'));
    expect(bucketRank('EMERGENCY')).toBe(bandRank('EMERGENCY'));
  });
});

// --- blendToScore ---------------------------------------------------------

describe('blendToScore — 0-100 axes → the persisted 0.05-1.10 band', () => {
  it('maps the band ends', () => {
    expect(blendToScore(0, 0)).toBeCloseTo(0.05, 10);
    expect(blendToScore(100, 100)).toBeCloseTo(1.1, 10);
  });

  it('is interest-leaning: rel is worth 0.65, impact 0.35', () => {
    // Same weighted mean either way is the WRONG expectation — swapping the
    // axes must change the score whenever they differ.
    expect(blendToScore(100, 0)).toBeGreaterThan(blendToScore(0, 100));
    expect(blendToScore(100, 0)).toBeCloseTo(0.05 + 1.05 * 0.65, 10);
    expect(blendToScore(0, 100)).toBeCloseTo(0.05 + 1.05 * 0.35, 10);
  });

  it('hits the band landmarks the prompt anchors are calibrated against', () => {
    // Equal axes ⇒ weighted mean = the axis value, so these read directly:
    // 33.33 → the render gate (0.4), 52.38 → MEDIUM, 71.43 → HIGH.
    expect(blendToScore(100 / 3, 100 / 3)).toBeCloseTo(0.4, 6);
    expect(blendToScore(1100 / 21, 1100 / 21)).toBeCloseTo(0.6, 6);
    expect(blendToScore(500 / 7, 500 / 7)).toBeCloseTo(0.8, 6);
    expect(bandOf(blendToScore(60, 50))).toBe('MEDIUM');
    expect(bandOf(blendToScore(80, 70))).toBe('HIGH');
  });

  it('lands the prompt few-shot anchors where the anchors claim', () => {
    const hit = blendToScore(88, 70); // "major EU AI Act obligations"
    expect(hit).toBeCloseTo(0.908, 3);
    expect(bandOf(hit)).toBe('HIGH');

    const mid = blendToScore(50, 35); // tangential industry news
    expect(mid).toBeCloseTo(0.52, 3);
    expect(bandOf(mid)).toBe('LOW'); // above the gate ⇒ still gets a "why"
    expect(mid).toBeGreaterThanOrEqual(0.4);

    const junk = blendToScore(12, 5); // chess tournament abroad
    expect(junk).toBeCloseTo(0.15, 3);
    expect(bandOf(junk)).toBe('SUB_GATE');
  });

  it('agrees with the prompt-stated "why" gate (0.65·rel + 0.35·impact ≥ 34)', () => {
    for (const [rel, impact] of [
      [40, 20],
      [60, 0],
      [0, 100],
      [34, 34],
      [33, 33],
      [88, 70],
      [12, 5],
    ] as const) {
      const weighted = 0.65 * rel + 0.35 * impact;
      // 34 is the prompt's rounded-up form of the exact 33.33 boundary, so
      // "weighted ≥ 34" must never emit a why for a sub-gate row.
      if (weighted >= 34) expect(blendToScore(rel, impact)).toBeGreaterThan(0.4);
    }
  });

  it('clamps out-of-range and non-finite axis values instead of yielding NaN', () => {
    expect(blendToScore(150, 200)).toBeCloseTo(1.1, 10);
    expect(blendToScore(-40, -10)).toBeCloseTo(0.05, 10);
    expect(blendToScore(NaN, 50)).toBeCloseTo(blendToScore(0, 50), 10);
    expect(Number.isNaN(blendToScore(NaN, NaN))).toBe(false);
  });

  it('is monotone in both axes', () => {
    expect(blendToScore(50, 50)).toBeGreaterThan(blendToScore(49, 50));
    expect(blendToScore(50, 50)).toBeGreaterThan(blendToScore(50, 49));
  });
});

// --- parseScoreV3Response -------------------------------------------------

describe('parseScoreV3Response', () => {
  it('decodes a well-formed batch', () => {
    const out = parseScoreV3Response(
      '[{"i":1,"rel":88,"impact":70,"why":"New EU obligations hit your AI work."},{"i":2,"rel":12,"impact":5}]',
      2,
    );
    expect(out).toEqual([
      { rel: 88, impact: 70, why: 'New EU obligations hit your AI work.' },
      { rel: 12, impact: 5 },
    ]);
  });

  it('omits "why" rather than emitting an empty string below the gate', () => {
    const out = parseScoreV3Response('[{"i":1,"rel":10,"impact":2,"why":""}]', 1);
    expect(out).toEqual([{ rel: 10, impact: 2 }]);
    expect(out![0]).not.toHaveProperty('why');
  });

  it('tolerates prose and a markdown fence around the array', () => {
    const out = parseScoreV3Response(
      'Here are the scores:\n```json\n[{"i":1,"rel":63,"impact":41,"why":"Dutch water rules affect your city."}]\n```\nDone.',
      1,
    );
    expect(out).toEqual([
      { rel: 63, impact: 41, why: 'Dutch water rules affect your city.' },
    ]);
  });

  it('accepts numeric strings and rounds/clamps the axes to 0-100 integers', () => {
    const out = parseScoreV3Response(
      '[{"i":1,"rel":"62.4","impact":140},{"i":2,"rel":-5,"impact":0.5}]',
      2,
    );
    expect(out).toEqual([
      { rel: 62, impact: 100 },
      { rel: 0, impact: 1 },
    ]);
  });

  it('reorders by "i" when every entry declares a distinct 1..N position', () => {
    const out = parseScoreV3Response(
      '[{"i":2,"rel":20,"impact":10},{"i":1,"rel":80,"impact":60}]',
      2,
    );
    expect(out).toEqual([
      { rel: 80, impact: 60 },
      { rel: 20, impact: 10 },
    ]);
  });

  it('falls back to array order when "i" is absent or unusable', () => {
    expect(parseScoreV3Response('[{"rel":80,"impact":60},{"rel":20,"impact":10}]', 2)).toEqual([
      { rel: 80, impact: 60 },
      { rel: 20, impact: 10 },
    ]);
    // duplicated positions ⇒ numbering ignored, not half-applied
    expect(
      parseScoreV3Response('[{"i":1,"rel":80,"impact":60},{"i":1,"rel":20,"impact":10}]', 2),
    ).toEqual([
      { rel: 80, impact: 60 },
      { rel: 20, impact: 10 },
    ]);
  });

  it('returns null on a count mismatch (both directions)', () => {
    expect(parseScoreV3Response('[{"i":1,"rel":80,"impact":60}]', 2)).toBeNull();
    expect(
      parseScoreV3Response('[{"i":1,"rel":80,"impact":60},{"i":2,"rel":1,"impact":1}]', 1),
    ).toBeNull();
  });

  it('returns null on structural damage rather than guessing', () => {
    expect(parseScoreV3Response('', 1)).toBeNull();
    expect(parseScoreV3Response('not json at all', 1)).toBeNull();
    expect(parseScoreV3Response('[{"i":1,"rel":80,"impact":60}', 1)).toBeNull(); // truncated
    expect(parseScoreV3Response('[{"i":1,"rel":80}]', 1)).toBeNull(); // missing axis
    expect(parseScoreV3Response('[{"i":1,"rel":"high","impact":60}]', 1)).toBeNull();
    expect(parseScoreV3Response('[[88,70]]', 1)).toBeNull(); // not objects
    expect(parseScoreV3Response('[{"i":1,"rel":80,"impact":60}]', 0)).toBeNull();
  });

  it('strips markdown and echoed prefixes out of "why"', () => {
    const out = parseScoreV3Response(
      '[{"i":1,"rel":80,"impact":60,"why":"**Why this matters to you:** The ruling  hits\\nyour work."}]',
      1,
    );
    expect(out![0].why).toBe('The ruling hits your work.');
  });
});

// --- prompt shape ---------------------------------------------------------

describe('v3 system prompts', () => {
  it('state the two axes, the JSON contract, and the field order', () => {
    for (const p of [
      CLOUD_SCORE_V3_SYSTEM_PROMPT,
      CLOUD_HEADLINE_SCORE_V3_SYSTEM_PROMPT,
    ]) {
      expect(p).toContain('"rel"');
      expect(p).toContain('"impact"');
      expect(p).toContain('"why"');
      expect(p).toContain('(0.65 × rel) + (0.35 × impact)');
      expect(p).toContain('Field order is load-bearing');
      // the second-person voice rule, shared with the legacy reason prompts
      expect(p).toContain('The reason is read BY the user');
      // anti-compression calibration
      expect(p).toContain('Spread is mandatory');
      expect(p).toContain('rel ≥ 60');
    }
  });

  it('keeps the headline variant on the indirect-impact rubric', () => {
    expect(CLOUD_HEADLINE_SCORE_V3_SYSTEM_PROMPT).toContain(
      'Impact channels (CLOSED LIST)',
    );
    expect(CLOUD_SCORE_V3_SYSTEM_PROMPT).not.toContain(
      'Impact channels (CLOSED LIST)',
    );
  });
});

// --- config flags ---------------------------------------------------------

describe('v3 config surface', () => {
  it('ships RELEVANCE_V3 off by default, as an explicit boolean literal', () => {
    expect(DEFAULT_HARNESS_CONFIG.scoringEngine.RELEVANCE_V3).toBe(false);
    expect('RELEVANCE_V3' in DEFAULT_HARNESS_CONFIG.scoringEngine).toBe(true);
    expect(typeof DEFAULT_HARNESS_CONFIG.scoringEngine.RELEVANCE_V3).toBe(
      'boolean',
    );
  });

  it('gives the merged pass a bigger output budget than the score-only pass', () => {
    const a = DEFAULT_HARNESS_CONFIG.articlePipeline;
    expect(a.v3ScoreBatchMaxTokens).toBe(640);
    expect(a.v3ScoreBatchMaxTokens).toBeGreaterThan(a.scoreBatchMaxTokens);
  });
});

// --- applyInterestRescueFloor --------------------------------------------

const ENG = DEFAULT_HARNESS_CONFIG.scoringEngine;

function components(topicComp: number): RelevanceComponents {
  return {
    topicComp,
    breadthComp: 0,
    geoComp: 0,
    geoAlignment: 'NONE',
    entityComp: 0,
    eventComp: 0,
    pubComp: 0,
    popComp: 0,
    affinity: topicComp,
    mathBase: 0.5,
    base: 0.5,
    negTopicPenalty: 0,
    suppressPenalty: 0,
    wrongLocPenalty: 0,
    seenPenalty: 0,
    wrongLocationFlag: 0,
  };
}

function topics(...vectorScores: (number | undefined)[]): MatchedTopicInput[] {
  return vectorScores.map((vectorScore, i) => ({
    topicId: `t${i}`,
    effectiveWeight: 0.8,
    vectorScore,
  }));
}

describe('applyInterestRescueFloor', () => {
  it('rescues a sub-gate LLM score backed by strong topic + vector evidence', () => {
    const out = applyInterestRescueFloor(0.33, components(0.8), topics(0.95), ENG);
    expect(out).toEqual({ score: 0.4, rescued: true });
  });

  it('rescues exactly to the floor — never higher', () => {
    const out = applyInterestRescueFloor(0.05, components(1.0), topics(1.0), ENG);
    expect(out.score).toBe(DEFAULT_HARNESS_CONFIG.articlePipeline.discardFloor);
    expect(bandOf(out.score)).toBe('LOW');
  });

  it('accepts the boundary values (topicComp 0.7, vectorScore = VS_HI)', () => {
    expect(
      applyInterestRescueFloor(0.3, components(0.7), topics(ENG.VS_HI), ENG).rescued,
    ).toBe(true);
    expect(
      applyInterestRescueFloor(0.3, components(0.69), topics(ENG.VS_HI), ENG).rescued,
    ).toBe(false);
    expect(
      applyInterestRescueFloor(0.3, components(0.7), topics(ENG.VS_HI - 0.01), ENG)
        .rescued,
    ).toBe(false);
  });

  it('passes through anything already at or above the gate', () => {
    expect(
      applyInterestRescueFloor(0.4, components(0.9), topics(0.99), ENG),
    ).toEqual({ score: 0.4, rescued: false });
    expect(
      applyInterestRescueFloor(0.85, components(0.9), topics(0.99), ENG),
    ).toEqual({ score: 0.85, rescued: false });
  });

  it('passes through when the math evidence is missing or weak', () => {
    expect(applyInterestRescueFloor(0.31, null, topics(0.99), ENG)).toEqual({
      score: 0.31,
      rescued: false,
    });
    // strong topic weight but no strong SEMANTIC match — conjunctive by design
    expect(
      applyInterestRescueFloor(0.31, components(0.95), topics(undefined), ENG),
    ).toEqual({ score: 0.31, rescued: false });
    expect(applyInterestRescueFloor(0.31, components(0.95), [], ENG)).toEqual({
      score: 0.31,
      rescued: false,
    });
  });

  it('needs only ONE matched topic to clear VS_HI', () => {
    const out = applyInterestRescueFloor(
      0.2,
      components(0.75),
      topics(0.4, undefined, 0.93),
      ENG,
    );
    expect(out.rescued).toBe(true);
  });
});
