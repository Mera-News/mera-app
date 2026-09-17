// The waiting-word rotation. Pure, so the ordering rules are testable without
// a renderer or a clock.
//
// The pool is 15 locale keys. `w1` is always shown FIRST — it is "Thinking",
// the plainest of them — so the wait opens on something unremarkable and only
// then starts wandering. Everything after that is shuffled.

/** Locale keys for the pool, in their canonical order. w1 is the opener. */
export const STREAMING_WORD_KEYS = [
  'streamingWords.w1',
  'streamingWords.w2',
  'streamingWords.w3',
  'streamingWords.w4',
  'streamingWords.w5',
  'streamingWords.w6',
  'streamingWords.w7',
  'streamingWords.w8',
  'streamingWords.w9',
  'streamingWords.w10',
  'streamingWords.w11',
  'streamingWords.w12',
  'streamingWords.w13',
  'streamingWords.w14',
  'streamingWords.w15',
] as const;

export const STREAMING_WORD_INTERVAL_MS = 2_500;

/**
 * A shuffled walk over 0..n-1 with NO repeats inside a cycle.
 *
 * `avoid` is the index the previous cycle ended on: it is never placed first,
 * so the seam between two cycles cannot show the same word twice in a row.
 * Without that, "no repeats" would hold within a cycle and visibly fail at the
 * one place a user is most likely to notice it.
 */
export function shuffledCycle(
  n: number,
  avoid: number | null = null,
  rng: () => number = Math.random,
): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (n > 1 && avoid !== null && out[0] === avoid) {
    // Swap with the tail rather than reshuffling: one deterministic move, and
    // it cannot loop on an unlucky rng.
    [out[0], out[n - 1]] = [out[n - 1], out[0]];
  }
  return out;
}

/**
 * The full order for one run: the opener, then shuffled cycles of everything.
 *
 * Returns `count` indices, so a test can assert the sequence without driving
 * a component through `count` timer ticks.
 */
export function wordOrder(
  count: number,
  poolSize: number = STREAMING_WORD_KEYS.length,
  rng: () => number = Math.random,
): number[] {
  const out: number[] = [0];
  let cycle: number[] = [];
  let cursor = 0;
  while (out.length < count) {
    if (cursor >= cycle.length) {
      cycle = shuffledCycle(poolSize, out[out.length - 1], rng);
      cursor = 0;
    }
    const next = cycle[cursor++];
    // The opener is index 0 and the first cycle may contain it again; skip it
    // only when it would repeat immediately.
    if (next === out[out.length - 1]) continue;
    out.push(next);
  }
  return out;
}
