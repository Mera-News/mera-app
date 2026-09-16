// MODEL_FALLBACKS is the map a session silently switches to when a primary
// times out, so a wrong entry is invisible until an outage — the worst moment
// to discover it. These pins exist so a change is deliberate.

import { BIG_MODEL, MODEL_FALLBACKS, SMALL_MODEL } from '../constants';

describe('MODEL_FALLBACKS', () => {
  // BIG's entry is a DEGRADED fallback, pinned so the degradation stays visible:
  // screened at 12/19 finish_reason=length against 0/123 for the primary. It is
  // chosen because GLM is closed and no fallback at all is worse, not because it
  // passed.
  it('pins both entries', () => {
    expect(MODEL_FALLBACKS[BIG_MODEL]).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
    expect(MODEL_FALLBACKS[SMALL_MODEL]).toBe('Qwen/Qwen3.8-27B');
  });

  it('has an entry for every primary, or a timeout has nowhere to go', () => {
    for (const primary of [BIG_MODEL, SMALL_MODEL]) {
      expect(typeof MODEL_FALLBACKS[primary]).toBe('string');
      expect(MODEL_FALLBACKS[primary].length).toBeGreaterThan(0);
    }
  });

  it('never points a primary at itself', () => {
    // A self-referential entry turns the fallback into a no-op and the session
    // keeps hammering the model that just timed out.
    for (const primary of [BIG_MODEL, SMALL_MODEL]) {
      expect(MODEL_FALLBACKS[primary]).not.toBe(primary);
    }
  });

  it('does NOT reintroduce GLM, which is closed', () => {
    // Closed 2026-09-16: re-measured 0/6 parse with a leaked reasoning trace on
    // every call against the shipped scoring prompt, and it cannot be told to
    // stop thinking. The 52/52 figure that originally selected it does not
    // reproduce under the same model id.
    for (const target of Object.values(MODEL_FALLBACKS)) {
      expect(target).not.toMatch(/glm/i);
    }
  });

  it('uses only text models, no vision-language model', () => {
    // A VL model screened well on scoring and was rejected as a TEXT fallback by
    // the user. Pinned so a future cost comparison does not quietly reinstate it.
    for (const target of Object.values(MODEL_FALLBACKS)) {
      expect(target).not.toMatch(/-VL-|vision/i);
    }
  });

  it('the two primaries fall back to DIFFERENT models', () => {
    // Not a correctness rule, a blast-radius one: one dead fallback should not
    // take out both lanes at once.
    expect(MODEL_FALLBACKS[BIG_MODEL]).not.toBe(MODEL_FALLBACKS[SMALL_MODEL]);
  });
});
