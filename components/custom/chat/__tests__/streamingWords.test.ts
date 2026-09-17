// The rotation rules, pure. No renderer, no clock.

import { shuffledCycle, STREAMING_WORD_KEYS, wordOrder } from '../streaming-words';

/** Deterministic rng so a shuffle is reproducible. */
const seeded = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
};

describe('shuffledCycle', () => {
  it('is a permutation: every index exactly once', () => {
    const out = shuffledCycle(15, null, seeded(1));
    expect(out).toHaveLength(15);
    expect([...out].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 15 }, (_, i) => i),
    );
  });

  it('never opens on the index it was told to avoid', () => {
    // The seam between two cycles is where "no repeats" is most visible and
    // was easiest to get wrong.
    for (let seed = 1; seed <= 200; seed++) {
      for (const avoid of [0, 7, 14]) {
        expect(shuffledCycle(15, avoid, seeded(seed))[0]).not.toBe(avoid);
      }
    }
  });

  it('degenerates safely at n = 1', () => {
    expect(shuffledCycle(1, 0, seeded(3))).toEqual([0]);
  });
});

describe('wordOrder', () => {
  it('always opens on w1, the plainest word', () => {
    for (let seed = 1; seed <= 50; seed++) {
      expect(wordOrder(5, 15, seeded(seed))[0]).toBe(0);
    }
  });

  it('never shows the same word twice in a row, over a long run', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const order = wordOrder(120, 15, seeded(seed));
      for (let i = 1; i < order.length; i++) {
        expect(order[i]).not.toBe(order[i - 1]);
      }
    }
  });

  it('uses the whole pool rather than a favourite few', () => {
    const order = wordOrder(60, 15, seeded(9));
    expect(new Set(order).size).toBe(15);
  });

  it('covers every word within a cycle before repeating any', () => {
    // First 15 after the opener are one shuffled cycle.
    const order = wordOrder(16, 15, seeded(4));
    expect(new Set(order.slice(1, 16)).size).toBeGreaterThanOrEqual(14);
  });
});

describe('the pool itself', () => {
  it('has 15 distinct keys, which the no-repeat rotation depends on', () => {
    expect(STREAMING_WORD_KEYS).toHaveLength(15);
    expect(new Set(STREAMING_WORD_KEYS).size).toBe(15);
  });
});
