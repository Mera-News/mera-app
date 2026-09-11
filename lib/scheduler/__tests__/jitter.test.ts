import {
  JITTER_RATIO,
  __setJitterSeedForTests,
  jitterFactor,
  jitteredInterval,
} from '../jitter';

// A spread of real task names plus a few synthetic ones, so a formula change
// cannot pass by luck on a single string.
const TASKS = [
  'feed-sync',
  'entitlement-sync',
  'apollo-cache-evict',
  'push-token-check',
  'data-cleanup',
  'persona-migration',
  'persona-hygiene',
  'sanity-backfill',
  'persona-geo',
  'feedback-cycle',
  'inference-recover',
  'a',
  '',
  'x'.repeat(200),
];

beforeEach(() => {
  __setJitterSeedForTests(0.123456789);
});

describe('jitterFactor', () => {
  it('stays within +/- JITTER_RATIO for every task name', () => {
    for (const name of TASKS) {
      const f = jitterFactor(name);
      expect(f).toBeGreaterThanOrEqual(1 - JITTER_RATIO);
      expect(f).toBeLessThan(1 + JITTER_RATIO);
    }
  });

  it('is stable across repeated calls (the cache)', () => {
    const first = jitterFactor('feed-sync');
    for (let i = 0; i < 50; i++) {
      expect(jitterFactor('feed-sync')).toBe(first);
    }
  });

  it('differs between task names for one seed', () => {
    const factors = new Set(TASKS.map((t) => jitterFactor(t)));
    // Not all 14 need be distinct for correctness, but collapsing to one value
    // would mean the task name is not reaching the hash at all.
    expect(factors.size).toBeGreaterThan(TASKS.length / 2);
  });

  it('moves when the seed moves (devices do not share a cadence)', () => {
    const a = jitterFactor('feed-sync');
    __setJitterSeedForTests(0.987654321);
    const b = jitterFactor('feed-sync');
    expect(b).not.toBe(a);
  });

  it('spreads across the band rather than clustering at one end', () => {
    // 200 synthetic devices, one task. A formula that always returned ~1.0
    // would pass every test above and defeat the entire point of the module.
    const seen: number[] = [];
    for (let i = 0; i < 200; i++) {
      __setJitterSeedForTests(i / 200);
      seen.push(jitterFactor('feed-sync'));
    }
    expect(Math.min(...seen)).toBeLessThan(0.9);
    expect(Math.max(...seen)).toBeGreaterThan(1.1);
  });
});

describe('jitteredInterval', () => {
  it('lands inside the band for a 5-minute base', () => {
    for (const name of TASKS) {
      const ms = jitteredInterval(name, 300_000);
      expect(ms).toBeGreaterThanOrEqual(240_000);
      expect(ms).toBeLessThanOrEqual(360_000);
    }
  });

  it('lands inside the band for a 15-minute base', () => {
    const ms = jitteredInterval('entitlement-sync', 15 * 60 * 1000);
    expect(ms).toBeGreaterThanOrEqual(720_000);
    expect(ms).toBeLessThanOrEqual(1_080_000);
  });

  // Load-bearing: `frequency === 0` means "event-driven, always due" throughout
  // the scheduler. Jittering it would mint a cadence the task never declared.
  it('returns 0 unchanged', () => {
    expect(jitteredInterval('inference-recover', 0)).toBe(0);
  });

  it('returns a negative base unchanged', () => {
    expect(jitteredInterval('weird', -1)).toBe(-1);
  });

  it('returns an integer', () => {
    expect(Number.isInteger(jitteredInterval('feed-sync', 300_000))).toBe(true);
  });

  it('is consistent with jitterFactor for the same task', () => {
    expect(jitteredInterval('feed-sync', 300_000)).toBe(
      Math.round(300_000 * jitterFactor('feed-sync')),
    );
  });
});
