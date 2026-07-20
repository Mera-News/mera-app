// scoring-engine — the PURE core of the M-P5c calibration loop (Wave 9 P-D).
//
// Round-3 A1: the judge is ADVISORY — it no longer changes the applied score.
// run-stage / judge-calls still flag a row `override` when |judge − computed| >
// OVERRIDE_DELTA (judge.ts) and expose the advisory judge score; each such row
// becomes a CalibrationCase with `computed` = the APPLIED math score. This module
// turns that stream of disagreements into a self-tuning signal:
//
//   (1) a persistent 7-day override COUNTER with window rollover;
//   (2) the ≤1-calibration/7-day + notify-cooldown RAILS that gate when the
//       "recalibrate?" notification may fire;
//   (3) the REPORT shaping — per-case computed-vs-judge + component breakdown +
//       event/geo class, carrying NO article text off the device;
//   (4) the gateway PROMPT (system + user) for the single calibration call;
//   (5) parsing + CLAMPING the returned constant tweaks to ≤±20%/constant and
//       LAYERING them over a base ScoringEngineConfig (base config untouched).
//
// Pure / RN-free by contract (lib/news-harness). The RN adapter that persists
// the counter, fires the notification, and makes the gateway call lives in
// lib/database/services/calibration-service.ts.
//
// Calibration constants are kept LOCAL here (precedent: OVERRIDE_DELTA in
// judge.ts) rather than in core/config.ts.

import type { ScoringEngineConfig } from '../core/config';
import type { RelevanceComponents } from './relevance';

// --- constants (local, not scoring weights) --------------------------------

/** Large overrides that must accumulate (within the window) before we invite a
 *  recalibration. */
export const CALIBRATION_OVERRIDE_THRESHOLD = 50;

/** Accumulation window — overrides older than this roll off (counter resets). */
export const CALIBRATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Rail: at most one calibration per this interval. */
export const CALIBRATION_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Rail: after a notification is produced (or dismissed/declined), don't
 *  re-invite until this cools off — the counter keeps accumulating meanwhile. */
export const CALIBRATION_NOTIFY_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000;

/** Per-constant tuning bound: |applied − base| ≤ this fraction of base. */
export const MAX_CONSTANT_DELTA_PCT = 0.2;

/** How many representative override cases the report may carry (bounded so the
 *  gateway payload — and the persisted sample — stay small). */
export const CALIBRATION_SAMPLE_CAP = 25;

/** Scoring constants the calibration loop is allowed to nudge. Deliberately the
 *  affinity WEIGHTS + PENALTIES + the high-priority multiplier — NOT the band
 *  bounds (BASE_MIN/MAX), saturation knees, or geo multipliers, which define the
 *  engine's shape rather than its taste. Any delta targeting a key outside this
 *  set is dropped by clampCalibrationDeltas. */
export const TUNABLE_CONSTANTS = [
  'W_TOPIC',
  'W_BREADTH',
  'W_GEO',
  'W_ENTITY',
  'W_EVENT',
  'W_PUB',
  'W_POP',
  'BASE_OFFSET',
  'BASE_SLOPE',
  'P_NEG',
  'P_SUP',
  'P_SUP_CAP',
  'P_WRONG',
  'P_SEEN',
  'HP_MULT',
] as const;

export type TunableConstant = (typeof TUNABLE_CONSTANTS)[number];

const TUNABLE_SET: ReadonlySet<string> = new Set(TUNABLE_CONSTANTS);

/** Fractional per-constant tweaks (e.g. { W_TOPIC: +0.1, P_WRONG: -0.05 } →
 *  W_TOPIC ×1.1, P_WRONG ×0.95). This IS the persisted overrides layer. */
export type ScoringConstantDeltas = Partial<Record<TunableConstant, number>>;

const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

// --- persistent counter + window rollover ----------------------------------

export interface OverrideCounterState {
  /** Large overrides accumulated in the current window. */
  count: number;
  /** Window anchor (ms). 0 = never started. */
  windowStartMs: number;
  /** When the last "recalibrate?" notification fired (ms), or null. */
  lastNotifiedMs: number | null;
  /** When the last calibration actually ran (ms), or null — the ≤1/7d anchor. */
  lastCalibrationMs: number | null;
}

export const EMPTY_COUNTER_STATE: OverrideCounterState = {
  count: 0,
  windowStartMs: 0,
  lastNotifiedMs: null,
  lastCalibrationMs: null,
};

/** Reset the count + re-anchor the window if it never started or has expired.
 *  lastNotified/lastCalibration are preserved across a rollover (they are
 *  longer-lived rails). Returns the SAME object when no rollover is needed. */
export function rolloverIfExpired(
  state: OverrideCounterState,
  nowMs: number,
): OverrideCounterState {
  const expired =
    state.windowStartMs === 0 || nowMs - state.windowStartMs >= CALIBRATION_WINDOW_MS;
  if (!expired) return state;
  return {
    count: 0,
    windowStartMs: nowMs,
    lastNotifiedMs: state.lastNotifiedMs,
    lastCalibrationMs: state.lastCalibrationMs,
  };
}

/** Roll the window if needed, then add `n` overrides to the count. */
export function recordInWindow(
  state: OverrideCounterState,
  n: number,
  nowMs: number,
): OverrideCounterState {
  const rolled = rolloverIfExpired(state, nowMs);
  return { ...rolled, count: rolled.count + Math.max(0, n) };
}

/** The rails that gate the "recalibrate?" invitation:
 *   - count has reached the threshold;
 *   - at least CALIBRATION_MIN_INTERVAL_MS since the last calibration (≤1/7d);
 *   - past the notify cooldown since the last invitation (decline/dismiss just
 *     re-arms after the cooldown while the counter keeps climbing). */
export function shouldFireNotification(
  state: OverrideCounterState,
  nowMs: number,
): boolean {
  if (state.count < CALIBRATION_OVERRIDE_THRESHOLD) return false;
  if (
    state.lastCalibrationMs !== null &&
    nowMs - state.lastCalibrationMs < CALIBRATION_MIN_INTERVAL_MS
  ) {
    return false;
  }
  if (
    state.lastNotifiedMs !== null &&
    nowMs - state.lastNotifiedMs < CALIBRATION_NOTIFY_COOLDOWN_MS
  ) {
    return false;
  }
  return true;
}

// --- report shaping (NO article text) --------------------------------------

/** Numeric component snapshot fed to the gateway — the "why the math scored it"
 *  breakdown WITHOUT any article title/description/fact text. */
export interface CalibrationComponentSnapshot {
  topicComp: number;
  breadthComp: number;
  geoComp: number;
  entityComp: number;
  eventComp: number;
  pubComp: number;
  popComp: number;
  negTopicPenalty: number;
  suppressPenalty: number;
  wrongLocPenalty: number;
  seenPenalty: number;
}

/** One override case in the report: the math vs judge scores, the class of the
 *  story (event/geo), and the component breakdown — all numeric/coarse. */
export interface CalibrationCase {
  /** Opaque row id (article/suggestion id). No text. */
  id: string;
  computed: number;
  judge: number;
  /** judge − computed (signed): >0 the judge lifted, <0 the judge cut. */
  delta: number;
  /** Coarse geo class (components.geoAlignment: NONE/CITY/REGION/COUNTRY). */
  geoClass: string;
  /** Coarse event class ('actionable' when eventComp>0, else 'none'). */
  eventClass: string;
  components: CalibrationComponentSnapshot;
}

const round = (x: number, dp = 3): number => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

/** Shape a single override row into a CalibrationCase (drops all text). */
export function buildCalibrationCase(
  id: string,
  computed: number,
  judge: number,
  comps: RelevanceComponents,
  eventClass?: string,
): CalibrationCase {
  return {
    id,
    computed: round(computed),
    judge: round(judge),
    delta: round(judge - computed),
    geoClass: comps.geoAlignment,
    eventClass: eventClass ?? (comps.eventComp > 0 ? 'actionable' : 'none'),
    components: {
      topicComp: round(comps.topicComp),
      breadthComp: round(comps.breadthComp),
      geoComp: round(comps.geoComp),
      entityComp: round(comps.entityComp),
      eventComp: round(comps.eventComp),
      pubComp: round(comps.pubComp),
      popComp: round(comps.popComp),
      negTopicPenalty: round(comps.negTopicPenalty),
      suppressPenalty: round(comps.suppressPenalty),
      wrongLocPenalty: round(comps.wrongLocPenalty),
      seenPenalty: round(comps.seenPenalty),
    },
  };
}

/** Keep the most-recent `cap` cases (incoming appended after existing). */
export function appendCappedSample(
  existing: CalibrationCase[],
  incoming: CalibrationCase[],
  cap: number = CALIBRATION_SAMPLE_CAP,
): CalibrationCase[] {
  const merged = existing.concat(incoming);
  return merged.length <= cap ? merged : merged.slice(merged.length - cap);
}

export interface CalibrationReport {
  /** Number of cases summarized (the sample, not the full window count). */
  sampleSize: number;
  /** Mean of |judge − computed| across the sample. */
  meanAbsDelta: number;
  /** Cases where the judge CUT the math (delta < 0) — math over-scored. */
  overshootCount: number;
  /** Cases where the judge LIFTED the math (delta > 0) — math under-scored. */
  undershootCount: number;
  cases: CalibrationCase[];
}

/** Aggregate a sample of override cases into the report the gateway reasons over. */
export function buildCalibrationReport(cases: CalibrationCase[]): CalibrationReport {
  const capped = cases.length <= CALIBRATION_SAMPLE_CAP
    ? cases
    : cases.slice(cases.length - CALIBRATION_SAMPLE_CAP);
  let sumAbs = 0;
  let overshoot = 0;
  let undershoot = 0;
  for (const c of capped) {
    sumAbs += Math.abs(c.delta);
    if (c.delta < 0) overshoot += 1;
    else if (c.delta > 0) undershoot += 1;
  }
  return {
    sampleSize: capped.length,
    meanAbsDelta: capped.length > 0 ? round(sumAbs / capped.length) : 0,
    overshootCount: overshoot,
    undershootCount: undershoot,
    cases: capped,
  };
}

// --- gateway prompt --------------------------------------------------------

/** System prompt for the single E2EE calibration call. The model receives ONLY
 *  the numeric report (no article text) and returns bounded fractional tweaks. */
export const CALIBRATION_SYSTEM_PROMPT = [
  'You are a calibration assistant for an on-device news-relevance scorer.',
  'The scorer produces a deterministic "computed" score from numeric components',
  '(topic, breadth, geo, entity, event, publication, popularity) minus',
  'penalties. A separate judge sometimes disagrees with that score. You are given a',
  'sample of cases where the judge disagreed strongly with the math, each as the',
  'computed score, the judge score, the signed delta, coarse geo/event classes,',
  'and the numeric component breakdown. NO article text is provided.',
  '',
  'Propose small fractional adjustments to the scoring CONSTANTS so the math moves',
  'toward the judge on similar cases in future. Positive delta scales a constant up',
  '(×(1+delta)), negative scales it down. Each delta MUST be within [-0.2, 0.2].',
  'Only adjust constants that the evidence implicates; omit the rest. Be',
  'conservative — prefer few, small changes.',
  '',
  'Tunable constants: W_TOPIC, W_BREADTH, W_GEO, W_ENTITY, W_EVENT, W_PUB, W_POP,',
  'BASE_OFFSET, BASE_SLOPE, P_NEG, P_SUP, P_SUP_CAP, P_WRONG, P_SEEN, HP_MULT.',
  '',
  'Respond with STRICT JSON only, no prose:',
  '{"deltas": {"W_TOPIC": 0.05, "P_WRONG": -0.1}}',
].join('\n');

/** Compact user message = the JSON report. */
export function buildCalibrationUserMessage(report: CalibrationReport): string {
  return JSON.stringify(report);
}

// --- parse + clamp + layer -------------------------------------------------

interface ParsedDeltaEnvelope {
  deltas?: unknown;
}

/**
 * Decode the gateway's calibration response into a raw fractional-delta map.
 * Accepts either { "deltas": { … } } or a bare { … } object. Fail-CLOSED: any
 * parse failure / wrong shape → {} (no tuning applied). Clamping/allowlisting is
 * the caller's job via clampCalibrationDeltas.
 */
export function parseCalibrationDeltas(output: string): Record<string, number> {
  const trimmed = (output ?? '').trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const envelope = parsed as ParsedDeltaEnvelope;
  const raw =
    envelope.deltas && typeof envelope.deltas === 'object'
      ? (envelope.deltas as Record<string, unknown>)
      : (parsed as Record<string, unknown>);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Keep only tunable constants that actually exist (and are numeric) on the base
 * config, and clamp each fractional delta to ±MAX_CONSTANT_DELTA_PCT. Unknown /
 * non-tunable / non-numeric keys are dropped. Zero deltas are dropped too.
 */
export function clampCalibrationDeltas(
  deltas: Record<string, number>,
  baseConfig: ScoringEngineConfig,
): ScoringConstantDeltas {
  const out: ScoringConstantDeltas = {};
  for (const [k, v] of Object.entries(deltas)) {
    if (!TUNABLE_SET.has(k)) continue;
    if (typeof (baseConfig as unknown as Record<string, unknown>)[k] !== 'number') continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) continue;
    const clamped = clamp(v, -MAX_CONSTANT_DELTA_PCT, MAX_CONSTANT_DELTA_PCT);
    if (clamped !== 0) out[k as TunableConstant] = round(clamped, 4);
  }
  return out;
}

/**
 * Compose a freshly-clamped delta map onto the already-persisted overrides so
 * repeated calibrations never drift a constant beyond ±MAX_CONSTANT_DELTA_PCT of
 * its BASE value. Composition is multiplicative in the applied factor:
 *   (1 + effective) = (1 + prev)·(1 + next), then `effective` is re-clamped.
 * Keys present in either map survive.
 */
export function mergeAndClampOverrides(
  prev: ScoringConstantDeltas,
  next: ScoringConstantDeltas,
): ScoringConstantDeltas {
  const out: ScoringConstantDeltas = {};
  const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    if (!TUNABLE_SET.has(k)) continue;
    const p = prev[k as TunableConstant] ?? 0;
    const n = next[k as TunableConstant] ?? 0;
    const composed = (1 + p) * (1 + n) - 1;
    const clamped = clamp(composed, -MAX_CONSTANT_DELTA_PCT, MAX_CONSTANT_DELTA_PCT);
    if (clamped !== 0) out[k as TunableConstant] = round(clamped, 4);
  }
  return out;
}

/**
 * Layer the persisted fractional overrides over a base ScoringEngineConfig:
 * applied[k] = base[k] × (1 + delta[k]) for every tunable override. Returns the
 * SAME reference when there is nothing to apply (hot-path allocation-light — the
 * scoring engine can skip building an effective config).
 */
export function applyScoringOverrides(
  base: ScoringEngineConfig,
  overrides: ScoringConstantDeltas,
): ScoringEngineConfig {
  const entries = Object.entries(overrides).filter(
    ([k, v]) => TUNABLE_SET.has(k) && typeof v === 'number' && v !== 0,
  );
  if (entries.length === 0) return base;
  const next: ScoringEngineConfig = { ...base };
  const nextRec = next as unknown as Record<string, number>;
  const baseRec = base as unknown as Record<string, number>;
  for (const [k, delta] of entries) {
    const baseVal = baseRec[k];
    if (typeof baseVal === 'number') {
      nextRec[k] = round(baseVal * (1 + (delta as number)), 6);
    }
  }
  return next;
}
