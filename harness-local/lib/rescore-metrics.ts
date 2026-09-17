// harness-local — pure metrics for the pass-2 rescore report.
//
// Every function here takes plain arrays/maps and returns plain data: no I/O,
// no config side-effects, so `selftest.ts` can feed each one an input built to
// make it report failure. A metric that cannot be shown failing on a
// constructed input is not verified, only exercised.

import { bandOf, bandRank, DEFAULT_HARNESS_CONFIG, type RelevanceBand } from '../../lib/news-harness';

// --- band histogram ---------------------------------------------------------

export type BandHistogram = Record<RelevanceBand, number>;

const EMPTY_HISTOGRAM: BandHistogram = {
  EMERGENCY: 0,
  HIGH: 0,
  MEDIUM: 0,
  LOW: 0,
  SUB_GATE: 0,
};

/**
 * Buckets a set of scores into the one relevance ladder (EMERGENCY/HIGH/
 * MEDIUM/LOW/SUB_GATE — see `bandOf`). Four live bins by construction (plus
 * SUB_GATE for anything below the render gate): this is NOT a distribution
 * shape, it is a gate-crossing count reported per band.
 */
export function bandHistogram(scores: (number | null | undefined)[]): BandHistogram {
  const out: BandHistogram = { ...EMPTY_HISTOGRAM };
  for (const s of scores) {
    out[bandOf(s, DEFAULT_HARNESS_CONFIG)] += 1;
  }
  return out;
}

/** Count of scores at or above `threshold` (defaults to the production render
 *  gate / discardFloor, 0.4). Non-finite / null scores never count. */
export function gateCount(
  scores: (number | null | undefined)[],
  threshold: number = DEFAULT_HARNESS_CONFIG.articlePipeline.discardFloor,
): number {
  return scores.filter((s) => typeof s === 'number' && Number.isFinite(s) && s >= threshold).length;
}

// --- precision / recall -----------------------------------------------------

export interface VerdictItem {
  score: number | null | undefined;
  verdict: string | null | undefined;
}

export interface PrecisionRecallResult {
  /** Rows with a non-null verdict — the only ones a figure is computed over. */
  n: number;
  /** Rows dropped because `verdict` was null/undefined. */
  excluded: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  /** null when there were no predicted-positive rows (undefined, not 0 — a 0
   *  would silently read as "the model never false-positived", which is not
   *  what an empty predicted set means). */
  precision: number | null;
  /** null when there were no actual-positive rows, for the same reason. */
  recall: number | null;
}

/**
 * Precision/recall of "score >= threshold" against `verdict`, for a caller-
 * supplied positive set (the label has three values — must_show / nice_to_have
 * / skip — and which count as positive is a reporting choice, not a fact, so
 * this never hardcodes one).
 */
export function precisionRecallAt(
  items: VerdictItem[],
  threshold: number,
  positiveVerdicts: ReadonlySet<string>,
): PrecisionRecallResult {
  let excluded = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const item of items) {
    if (item.verdict == null) {
      excluded += 1;
      continue;
    }
    const predictedPositive =
      typeof item.score === 'number' && Number.isFinite(item.score) && item.score >= threshold;
    const actualPositive = positiveVerdicts.has(item.verdict);
    if (predictedPositive && actualPositive) tp += 1;
    else if (predictedPositive && !actualPositive) fp += 1;
    else if (!predictedPositive && actualPositive) fn += 1;
    else tn += 1;
  }
  const n = tp + fp + fn + tn;
  return {
    n,
    excluded,
    truePositive: tp,
    falsePositive: fp,
    falseNegative: fn,
    trueNegative: tn,
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
  };
}

// --- rescore delta summary ---------------------------------------------------

export interface RescoreDeltaSummary {
  /** Rows where a pass-2 rescore actually applied (fail-open unparsed rows are
   *  not counted here — this describes the rescored subset, not the gated
   *  subset). */
  n: number;
  meanSignedDelta: number;
  meanAbsDelta: number;
  /** `bandOf(after) > bandOf(before)`. */
  bandChangesUp: number;
  /** `bandOf(after) < bandOf(before)`. */
  bandChangesDown: number;
  bandUnchanged: number;
}

const EMPTY_RESCORE_SUMMARY: RescoreDeltaSummary = {
  n: 0,
  meanSignedDelta: 0,
  meanAbsDelta: 0,
  bandChangesUp: 0,
  bandChangesDown: 0,
  bandUnchanged: 0,
};

/** `{ before, after }` pairs, one per article whose pass-2 score replaced its
 *  pass-1 score. Signed delta is `after - before`, so a negative mean means
 *  the rescore demotes on net (the `rescore-demote-only` arm should show
 *  this; a positive mean on `reason-rescore` is the inflation check U5 gates
 *  promotion on). */
export function rescoreSummary(pairs: { before: number; after: number }[]): RescoreDeltaSummary {
  if (pairs.length === 0) return { ...EMPTY_RESCORE_SUMMARY };
  let signedSum = 0;
  let absSum = 0;
  let up = 0;
  let down = 0;
  let unchanged = 0;
  for (const { before, after } of pairs) {
    const delta = after - before;
    signedSum += delta;
    absSum += Math.abs(delta);
    const beforeRank = bandRank(bandOf(before, DEFAULT_HARNESS_CONFIG));
    const afterRank = bandRank(bandOf(after, DEFAULT_HARNESS_CONFIG));
    if (afterRank > beforeRank) up += 1;
    else if (afterRank < beforeRank) down += 1;
    else unchanged += 1;
  }
  return {
    n: pairs.length,
    meanSignedDelta: signedSum / pairs.length,
    meanAbsDelta: absSum / pairs.length,
    bandChangesUp: up,
    bandChangesDown: down,
    bandUnchanged: unchanged,
  };
}

// --- formatting --------------------------------------------------------------

export function formatBandHistogram(h: BandHistogram): string {
  const order: RelevanceBand[] = ['EMERGENCY', 'HIGH', 'MEDIUM', 'LOW', 'SUB_GATE'];
  return order.map((b) => `${b}=${h[b]}`).join(' ');
}

export function formatPrecisionRecall(label: string, r: PrecisionRecallResult): string {
  const p = r.precision === null ? 'n/a (no predicted-positive rows)' : r.precision.toFixed(3);
  const rec = r.recall === null ? 'n/a (no actual-positive rows)' : r.recall.toFixed(3);
  return (
    `${label}: precision=${p} recall=${rec} ` +
    `(n=${r.n}, excluded=${r.excluded}, tp=${r.truePositive} fp=${r.falsePositive} ` +
    `fn=${r.falseNegative} tn=${r.trueNegative})`
  );
}

export function formatRescoreSummary(s: RescoreDeltaSummary): string {
  if (s.n === 0) return 'rescore: n=0 (no reason row carried a parsed rescore in this cell)';
  return (
    `rescore: n=${s.n} mean-signed-delta=${s.meanSignedDelta.toFixed(3)} ` +
    `mean-abs-delta=${s.meanAbsDelta.toFixed(3)} band-up=${s.bandChangesUp} ` +
    `band-down=${s.bandChangesDown} band-unchanged=${s.bandUnchanged}`
  );
}
