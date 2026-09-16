// The relevance decoder's output-contract counters.
//
// WHAT THIS PROTECTS. The relevance prompt tells the model that `s` "MUST lie
// inside the band of the `k` you chose". The decoder has always enforced that
// by CLAMPING, so a self-contradicting answer never reaches the product — but
// the contradiction itself was discarded, and it is the cheapest
// instruction-following signal the scorer has: no rater, no golden labels, no
// extra call, available on every batch.
//
// Two properties matter and they pull against each other, so both are pinned:
//
//   1. The counters are ACCURATE — a violation is counted once, with the right
//      magnitude, measured against the raw value rather than after another
//      clamp has already hidden it.
//   2. Passing no accumulator changes NOTHING. Every production call site omits
//      it, so the scores and the log lines must be identical with and without.
//      A counter that perturbs the thing it counts is worse than no counter.
import {
  parseBatchRelevanceResponse,
  newRelevanceDecodeStats,
  type RelevanceDecodeStats,
} from '../article-pipeline/scoring';
import { DEFAULT_HARNESS_CONFIG } from '../core/config';
import type { HarnessLogger } from '../core/ports';

const CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;

function recordingLogger(): { logger: HarnessLogger; lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (msg: string) => lines.push(`${level}:${msg}`);
  return {
    lines,
    logger: {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    },
  };
}

function decode(output: string, n: number, stats?: RelevanceDecodeStats) {
  return parseBatchRelevanceResponse(output, n, 'id', undefined, CFG, undefined, stats);
}

describe('relevance decode stats — counting', () => {
  it('counts a clean tiered batch with no violations', () => {
    const stats = newRelevanceDecodeStats();
    const scores = decode(
      '[{"k":"domain","s":0.62},{"k":"none","s":0.12},{"k":"interest","s":0.33}]',
      3,
      stats,
    );
    expect(scores).toEqual([0.62, 0.12, 0.33]);
    expect(stats.entries).toBe(3);
    expect(stats.tieredEntries).toBe(3);
    expect(stats.bandViolations).toBe(0);
    expect(stats.bandViolationMass).toBe(0);
    expect(stats.unknownStakeTags).toBe(0);
  });

  it('counts a score that overshoots its declared band, and its magnitude', () => {
    // "none" declares 0.05–0.24; 0.71 is 0.47 above the ceiling. The product
    // still sees the clamped 0.24 — that is the point, the score is corrected
    // and only the disagreement is reported.
    const stats = newRelevanceDecodeStats();
    const scores = decode('[{"k":"none","s":0.71}]', 1, stats);
    expect(scores).toEqual([0.24]);
    expect(stats.bandViolations).toBe(1);
    expect(stats.bandViolationMass).toBeCloseTo(0.47, 10);
  });

  it('counts a score that undershoots its declared band', () => {
    // "home" declares 0.40–1.10; 0.10 is 0.30 below the floor.
    const stats = newRelevanceDecodeStats();
    const scores = decode('[{"k":"home","s":0.1}]', 1, stats);
    expect(scores).toEqual([0.4]);
    expect(stats.bandViolations).toBe(1);
    expect(stats.bandViolationMass).toBeCloseTo(0.3, 10);
  });

  it('measures a wild value against the RAW score, not the 0-1.1 clamp', () => {
    // This is the assertion that fails if someone "simplifies" the distance to
    // be taken after clampRelevance: 7.0 under "none" is 6.76 out of band, and
    // measuring post-clamp would report 0.86 and understate it by 8x.
    const stats = newRelevanceDecodeStats();
    const scores = decode('[{"k":"none","s":7}]', 1, stats);
    expect(scores).toEqual([0.24]);
    expect(stats.bandViolations).toBe(1);
    expect(stats.bandViolationMass).toBeCloseTo(6.76, 10);
  });

  it('separates an unknown tag from a violation', () => {
    // An invented tag has no band to break. It skips band clamping entirely,
    // which is a different (and quieter) failure than contradicting a real one.
    const stats = newRelevanceDecodeStats();
    const scores = decode('[{"k":"vibes","s":0.9}]', 1, stats);
    expect(scores).toEqual([0.9]);
    expect(stats.unknownStakeTags).toBe(1);
    expect(stats.bandViolations).toBe(0);
    expect(stats.tieredEntries).toBe(1);
  });

  it('counts legacy bare numbers separately and never as violations', () => {
    const stats = newRelevanceDecodeStats();
    const scores = decode('[0.5, 0.9]', 2, stats);
    expect(scores).toEqual([0.5, 0.9]);
    expect(stats.legacyNumberEntries).toBe(2);
    expect(stats.tieredEntries).toBe(0);
    expect(stats.bandViolations).toBe(0);
  });

  it('counts a length mismatch and still pads to expectedCount', () => {
    const stats = newRelevanceDecodeStats();
    const scores = decode('[{"k":"none","s":0.1}]', 3, stats);
    expect(scores).toHaveLength(3);
    expect(scores[1]).toBe(CFG.fallbackRelevance);
    expect(stats.lengthMismatches).toBe(1);
  });

  it('counts the regex fallback when the array is not valid JSON', () => {
    const stats = newRelevanceDecodeStats();
    const scores = decode('here you go: 0.61, 0.22', 2, stats);
    expect(scores).toEqual([0.61, 0.22]);
    expect(stats.regexFallbacks).toBe(1);
    expect(stats.entries).toBe(0);
  });

  it('counts a total failure when nothing parses', () => {
    const stats = newRelevanceDecodeStats();
    const scores = decode('I cannot help with that.', 2, stats);
    expect(scores).toEqual([CFG.fallbackRelevance, CFG.fallbackRelevance]);
    expect(stats.totalFailures).toBe(1);
    expect(stats.regexFallbacks).toBe(1);
  });

  it('accumulates across batches, which is how a run reports a rate', () => {
    const stats = newRelevanceDecodeStats();
    decode('[{"k":"none","s":0.71}]', 1, stats);
    decode('[{"k":"domain","s":0.62}]', 1, stats);
    decode('[{"k":"home","s":0.2}]', 1, stats);
    expect(stats.tieredEntries).toBe(3);
    expect(stats.bandViolations).toBe(2);
    // 2 of 3 tiered entries contradicted their own tag.
    expect(stats.bandViolations / stats.tieredEntries).toBeCloseTo(2 / 3, 10);
  });
});

describe('relevance decode stats — passing none changes nothing', () => {
  const CASES: [string, string, number][] = [
    ['clean tiered', '[{"k":"domain","s":0.62},{"k":"none","s":0.12}]', 2],
    ['violating tiered', '[{"k":"none","s":0.71},{"k":"home","s":0.1}]', 2],
    ['unknown tag', '[{"k":"vibes","s":0.9}]', 1],
    ['legacy numbers', '[0.5, 0.9]', 2],
    ['length mismatch', '[{"k":"none","s":0.1}]', 3],
    ['regex fallback', 'here you go: 0.61, 0.22', 2],
    ['total failure', 'I cannot help with that.', 2],
  ];

  it.each(CASES)('%s: identical scores with and without an accumulator', (_n, out, count) => {
    const without = decode(out, count);
    const with_ = decode(out, count, newRelevanceDecodeStats());
    expect(with_).toEqual(without);
  });

  it.each(CASES)('%s: identical log lines with and without an accumulator', (_n, out, count) => {
    const a = recordingLogger();
    parseBatchRelevanceResponse(out, count, 'id', undefined, CFG, a.logger);
    const b = recordingLogger();
    parseBatchRelevanceResponse(
      out,
      count,
      'id',
      undefined,
      CFG,
      b.logger,
      newRelevanceDecodeStats(),
    );
    expect(b.lines).toEqual(a.lines);
  });

  it('is non-vacuous: the cases above really do exercise the warn paths', () => {
    // Without this, the log-equality test would pass for the boring reason that
    // nothing ever logs.
    const rec = recordingLogger();
    parseBatchRelevanceResponse('nope', 2, 'id', undefined, CFG, rec.logger);
    expect(rec.lines.length).toBeGreaterThan(0);
    expect(rec.lines.every((l) => l.startsWith('warn:'))).toBe(true);
  });
});

describe('newRelevanceDecodeStats', () => {
  it('starts at zero on every field', () => {
    const stats = newRelevanceDecodeStats();
    for (const [key, value] of Object.entries(stats)) {
      expect([key, value]).toEqual([key, 0]);
    }
  });

  it('hands back an independent accumulator each call', () => {
    const a = newRelevanceDecodeStats();
    const b = newRelevanceDecodeStats();
    decode('[{"k":"none","s":0.71}]', 1, a);
    expect(a.bandViolations).toBe(1);
    expect(b.bandViolations).toBe(0);
  });
});
