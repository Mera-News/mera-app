// Escalating cooldown thresholds. Every wrong attempt increments failCount;
// each time it crosses a multiple of 5 we impose the corresponding lockout.
const COOLDOWN_STEP = 5;
const COOLDOWN_30S = 30_000;
const COOLDOWN_60S = 60_000;
const COOLDOWN_5MIN = 5 * 60_000;

/**
 * Cooldown to impose given the *new* total failCount. Returns 0 unless
 * failCount just landed on a COOLDOWN_STEP boundary.
 *   5  → 30s, 10 → 60s, 15+ → 5min (and every 5 thereafter).
 */
function cooldownForFailCount(failCount: number): number {
  if (failCount === 0 || failCount % COOLDOWN_STEP !== 0) return 0;
  if (failCount >= 15) return COOLDOWN_5MIN;
  if (failCount >= 10) return COOLDOWN_60S;
  return COOLDOWN_30S;
}

export { cooldownForFailCount };
