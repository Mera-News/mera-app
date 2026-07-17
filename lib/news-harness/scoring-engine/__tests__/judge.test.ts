import { DEFAULT_HARNESS_CONFIG } from '../../core/config';
import { parseJudgeResponse, summarizeComponents, OVERRIDE_DELTA } from '../judge';
import type { RelevanceComponents } from '../relevance';

const cfg = DEFAULT_HARNESS_CONFIG.scoringEngine;

describe('parseJudgeResponse — conservative decode + full override', () => {
  it('"ok" keeps the computed score', () => {
    const d = parseJudgeResponse('[{"j":"ok"}]', [0.62], cfg);
    expect(d[0].score).toBe(0.62);
    expect(d[0].override).toBe(false);
    expect(d[0].adjusted).toBe(false);
  });

  it('"adj" fully overrides (no ±clamp) and flags >0.3 as an override', () => {
    const d = parseJudgeResponse('[{"j":"adj","s":0.12}]', [0.62], cfg);
    expect(d[0].score).toBe(0.12);
    expect(d[0].adjusted).toBe(true);
    expect(d[0].override).toBe(true); // |0.12 − 0.62| = 0.5 > 0.3
  });

  it('a small "adj" is adjusted but NOT an override', () => {
    const d = parseJudgeResponse('[{"j":"adj","s":0.5}]', [0.62], cfg);
    expect(d[0].score).toBe(0.5);
    expect(d[0].adjusted).toBe(true);
    expect(d[0].override).toBe(false); // 0.12 ≤ OVERRIDE_DELTA
    expect(OVERRIDE_DELTA).toBe(0.3);
  });

  it('clamps an out-of-band override into [BASE_MIN, BASE_MAX]', () => {
    expect(parseJudgeResponse('[{"j":"adj","s":9}]', [0.6], cfg)[0].score).toBe(cfg.BASE_MAX);
    expect(parseJudgeResponse('[{"j":"adj","s":-1}]', [0.6], cfg)[0].score).toBe(cfg.BASE_MIN);
  });

  it('captures a reason string when present', () => {
    const d = parseJudgeResponse('[{"j":"ok","r":"Bhopal heat alert hits your family city."}]', [0.7], cfg);
    expect(d[0].reason).toBe('Bhopal heat alert hits your family city.');
  });

  it('unparseable output → fail-open to computed scores', () => {
    const d = parseJudgeResponse('the model rambled', [0.3, 0.8], cfg);
    expect(d.map((x) => x.score)).toEqual([0.3, 0.8]);
    expect(d.every((x) => !x.override && !x.adjusted)).toBe(true);
  });

  it('length mismatch → fail-open for the whole batch', () => {
    const d = parseJudgeResponse('[{"j":"adj","s":0.1}]', [0.3, 0.8], cfg);
    expect(d.map((x) => x.score)).toEqual([0.3, 0.8]);
  });

  it('malformed "adj" (no numeric s) keeps computed for that row', () => {
    const d = parseJudgeResponse('[{"j":"adj"},{"j":"ok"}]', [0.55, 0.4], cfg);
    expect(d[0].score).toBe(0.55);
    expect(d[0].adjusted).toBe(false);
    expect(d[1].score).toBe(0.4);
  });
});

describe('summarizeComponents', () => {
  const base: RelevanceComponents = {
    topicComp: 0.8, breadthComp: 0.5, geoComp: 0.3, geoAlignment: 'COUNTRY',
    entityComp: 0, eventComp: 0, pubComp: 0, popComp: 0, freshComp: 0.5,
    affinity: 0, mathBase: 0.4, base: 0.4, negTopicPenalty: 0, suppressPenalty: 0,
    wrongLocPenalty: 0, seenPenalty: 0, wrongLocationFlag: 0, matchedLocationId: 'loc-1',
  };

  it('names the winning topic + the matched location ROLE', () => {
    const s = summarizeComponents(base, [{ topicId: 't1', text: 'Bhopal weather', effectiveWeight: 0.8 }], [
      { id: 'loc-1', countryCode: 'IN', role: 'family', weight: 1 },
    ]);
    expect(s).toContain("'Bhopal weather'");
    expect(s).toContain('COUNTRY-level match to your family place');
  });

  it('surfaces the wrong-location penalty', () => {
    const s = summarizeComponents(
      { ...base, wrongLocationFlag: 1, wrongLocPenalty: 0.55 },
      [{ topicId: 't1', text: 'Chhindwara news', effectiveWeight: 0.8 }],
    );
    expect(s).toContain('WRONG-location');
  });
});
