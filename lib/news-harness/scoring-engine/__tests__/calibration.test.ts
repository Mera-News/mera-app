import { DEFAULT_HARNESS_CONFIG } from '../../core/config';
import type { RelevanceComponents } from '../relevance';
import {
  CALIBRATION_OVERRIDE_THRESHOLD,
  CALIBRATION_WINDOW_MS,
  CALIBRATION_NOTIFY_COOLDOWN_MS,
  CALIBRATION_MIN_INTERVAL_MS,
  MAX_CONSTANT_DELTA_PCT,
  CALIBRATION_SAMPLE_CAP,
  EMPTY_COUNTER_STATE,
  rolloverIfExpired,
  recordInWindow,
  shouldFireNotification,
  buildCalibrationCase,
  appendCappedSample,
  buildCalibrationReport,
  buildCalibrationUserMessage,
  parseCalibrationDeltas,
  clampCalibrationDeltas,
  mergeAndClampOverrides,
  applyScoringOverrides,
  type CalibrationCase,
} from '../calibration';

const eng = DEFAULT_HARNESS_CONFIG.scoringEngine;

const NOW = 1_700_000_000_000;

function comps(overrides: Partial<RelevanceComponents> = {}): RelevanceComponents {
  return {
    topicComp: 0.4,
    breadthComp: 0.2,
    geoComp: 0.1,
    geoAlignment: 'CITY',
    entityComp: 0,
    eventComp: 0,
    pubComp: 0,
    popComp: 0.3,
    affinity: 0.5,
    mathBase: 0.6,
    base: 0.6,
    negTopicPenalty: 0,
    suppressPenalty: 0,
    wrongLocPenalty: 0,
    seenPenalty: 0,
    wrongLocationFlag: 0,
    ...overrides,
  };
}

function caseAt(id: string, computed: number, judge: number): CalibrationCase {
  return buildCalibrationCase(id, computed, judge, comps());
}

describe('override counter — window rollover', () => {
  it('anchors the window on first record', () => {
    const s = recordInWindow(EMPTY_COUNTER_STATE, 3, NOW);
    expect(s.windowStartMs).toBe(NOW);
    expect(s.count).toBe(3);
  });

  it('accumulates within the window', () => {
    let s = recordInWindow(EMPTY_COUNTER_STATE, 10, NOW);
    s = recordInWindow(s, 5, NOW + 1000);
    expect(s.count).toBe(15);
    expect(s.windowStartMs).toBe(NOW);
  });

  it('rolls over (resets count, re-anchors) once the window expires', () => {
    let s = recordInWindow(EMPTY_COUNTER_STATE, 40, NOW);
    s = recordInWindow(s, 7, NOW + CALIBRATION_WINDOW_MS + 1);
    expect(s.count).toBe(7);
    expect(s.windowStartMs).toBe(NOW + CALIBRATION_WINDOW_MS + 1);
  });

  it('preserves lastNotified/lastCalibration across a rollover', () => {
    const seeded = { count: 50, windowStartMs: NOW, lastNotifiedMs: NOW, lastCalibrationMs: NOW };
    const rolled = rolloverIfExpired(seeded, NOW + CALIBRATION_WINDOW_MS + 1);
    expect(rolled.count).toBe(0);
    expect(rolled.lastNotifiedMs).toBe(NOW);
    expect(rolled.lastCalibrationMs).toBe(NOW);
  });
});

describe('notification rails', () => {
  it('fires once the threshold is reached and no rails block', () => {
    const s = { count: CALIBRATION_OVERRIDE_THRESHOLD, windowStartMs: NOW, lastNotifiedMs: null, lastCalibrationMs: null };
    expect(shouldFireNotification(s, NOW)).toBe(true);
  });

  it('does not fire below the threshold', () => {
    const s = { count: CALIBRATION_OVERRIDE_THRESHOLD - 1, windowStartMs: NOW, lastNotifiedMs: null, lastCalibrationMs: null };
    expect(shouldFireNotification(s, NOW)).toBe(false);
  });

  it('respects the ≤1-calibration/7d rail', () => {
    const s = { count: 80, windowStartMs: NOW, lastNotifiedMs: null, lastCalibrationMs: NOW };
    expect(shouldFireNotification(s, NOW + 1000)).toBe(false);
    expect(shouldFireNotification(s, NOW + CALIBRATION_MIN_INTERVAL_MS + 1)).toBe(true);
  });

  it('respects the notify cooldown after a prior invitation', () => {
    const s = { count: 80, windowStartMs: NOW, lastNotifiedMs: NOW, lastCalibrationMs: null };
    expect(shouldFireNotification(s, NOW + 1000)).toBe(false);
    expect(shouldFireNotification(s, NOW + CALIBRATION_NOTIFY_COOLDOWN_MS + 1)).toBe(true);
  });
});

describe('report shaping — no article text', () => {
  it('builds a case with signed delta + coarse classes, carrying only numbers', () => {
    const c = buildCalibrationCase('a1', 0.7, 0.2, comps({ eventComp: 0.3, geoAlignment: 'COUNTRY' }));
    expect(c.id).toBe('a1');
    expect(c.delta).toBeCloseTo(-0.5, 5);
    expect(c.geoClass).toBe('COUNTRY');
    expect(c.eventClass).toBe('actionable');
    // No title/description/fact fields leak in.
    expect(JSON.stringify(c)).not.toMatch(/title|description|text|statement/i);
  });

  it('aggregates overshoot vs undershoot', () => {
    const cases = [caseAt('a', 0.8, 0.3), caseAt('b', 0.2, 0.7), caseAt('c', 0.9, 0.4)];
    const report = buildCalibrationReport(cases);
    expect(report.sampleSize).toBe(3);
    expect(report.overshootCount).toBe(2); // judge cut a & c
    expect(report.undershootCount).toBe(1); // judge lifted b
    expect(report.meanAbsDelta).toBeGreaterThan(0);
    expect(buildCalibrationUserMessage(report)).toContain('"sampleSize":3');
  });

  it('caps the sample to CALIBRATION_SAMPLE_CAP, keeping the newest', () => {
    const many = Array.from({ length: CALIBRATION_SAMPLE_CAP + 10 }, (_, i) => caseAt(`c${i}`, 0.8, 0.3));
    const capped = appendCappedSample([], many);
    expect(capped.length).toBe(CALIBRATION_SAMPLE_CAP);
    expect(capped[capped.length - 1].id).toBe(`c${CALIBRATION_SAMPLE_CAP + 9}`);
  });
});

describe('parse + clamp gateway deltas', () => {
  it('parses the { deltas: {} } envelope', () => {
    expect(parseCalibrationDeltas('{"deltas":{"W_TOPIC":0.1}}')).toEqual({ W_TOPIC: 0.1 });
  });

  it('parses a bare object and ignores prose around it', () => {
    expect(parseCalibrationDeltas('here you go: {"P_WRONG":-0.05} done')).toEqual({ P_WRONG: -0.05 });
  });

  it('fail-closed on garbage', () => {
    expect(parseCalibrationDeltas('not json')).toEqual({});
    expect(parseCalibrationDeltas('')).toEqual({});
  });

  it('clamps to ±20% and drops unknown / non-tunable keys', () => {
    const clamped = clampCalibrationDeltas(
      { W_TOPIC: 0.9, P_WRONG: -0.5, BASE_MIN: 0.1, NOT_A_KEY: 0.1, W_POP: 0 },
      eng,
    );
    expect(clamped.W_TOPIC).toBe(MAX_CONSTANT_DELTA_PCT);
    expect(clamped.P_WRONG).toBe(-MAX_CONSTANT_DELTA_PCT);
    expect(clamped).not.toHaveProperty('BASE_MIN'); // not tunable
    expect(clamped).not.toHaveProperty('NOT_A_KEY');
    expect(clamped).not.toHaveProperty('W_POP'); // zero delta dropped
  });
});

describe('merge composition stays within bounds', () => {
  it('composes repeated deltas and re-clamps to ±20%', () => {
    const merged = mergeAndClampOverrides({ W_TOPIC: 0.15 }, { W_TOPIC: 0.15 });
    // (1.15*1.15 - 1) = 0.3225 → clamped to 0.2
    expect(merged.W_TOPIC).toBe(MAX_CONSTANT_DELTA_PCT);
  });

  it('keeps keys from either side', () => {
    const merged = mergeAndClampOverrides({ W_TOPIC: 0.1 }, { P_SEEN: -0.1 });
    expect(merged.W_TOPIC).toBeCloseTo(0.1, 5);
    expect(merged.P_SEEN).toBeCloseTo(-0.1, 5);
  });
});

describe('layering overrides over a base config', () => {
  it('returns the SAME reference when there is nothing to apply', () => {
    expect(applyScoringOverrides(eng, {})).toBe(eng);
    expect(applyScoringOverrides(eng, { W_TOPIC: 0 })).toBe(eng);
  });

  it('scales each tunable constant by (1 + delta), leaving the rest untouched', () => {
    const applied = applyScoringOverrides(eng, { W_TOPIC: 0.1, P_WRONG: -0.2 });
    expect(applied.W_TOPIC).toBeCloseTo(eng.W_TOPIC * 1.1, 6);
    expect(applied.P_WRONG).toBeCloseTo(eng.P_WRONG * 0.8, 6);
    expect(applied.W_GEO).toBe(eng.W_GEO); // untouched
    expect(applied.BASE_MIN).toBe(eng.BASE_MIN); // structural, never touched
    // base config is not mutated
    expect(eng.W_TOPIC).not.toBeCloseTo(eng.W_TOPIC * 1.1, 6);
  });
});
