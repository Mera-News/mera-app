// Calibration Service — the RN adapter for the M-P5c override→calibration loop
// (Wave 9 P-D). Pure logic lives in
// lib/news-harness/scoring-engine/calibration.ts; this module supplies the
// device-coupled pieces:
//
//   - a PERSISTENT 7-day override counter + bounded case sample (settings KV);
//   - the threshold check that PRODUCES the `calibration` notification (with the
//     ≤1/7d + notify-cooldown rails), NOT an API call;
//   - runCalibration(): builds the report, makes ONE E2EE gateway call through
//     the existing inference path (cloudComplete — same client-side-encrypt
//     primitive as scoring), clamps the returned tweaks to ≤±20%/constant,
//     persists them to the `scoringEngineOverrides` layer, appends a revertible
//     change-log row, and resets the counter;
//   - getScoringOverrides(): the layer the math engine reads at scoring time.
//
// The gateway round-trip fires ONLY on explicit user confirm (runCalibration) —
// never automatically. recordOverrides() only tallies + (maybe) notifies.

import { getSetting, setSetting } from './setting-service';
import { append as appendChangeLog } from './persona-change-log-service';
import { cloudComplete } from '../../llm/cloudComplete';
import { SMALL_MODEL } from '../../llm/constants';
import { toastManager } from '../../toast-manager';
import logger from '../../logger';
import { DEFAULT_HARNESS_CONFIG } from '../../news-harness/core/config';
import {
  CALIBRATION_SYSTEM_PROMPT,
  EMPTY_COUNTER_STATE,
  appendCappedSample,
  buildCalibrationReport,
  buildCalibrationUserMessage,
  clampCalibrationDeltas,
  mergeAndClampOverrides,
  parseCalibrationDeltas,
  recordInWindow,
  shouldFireNotification,
  type CalibrationCase,
  type OverrideCounterState,
  type ScoringConstantDeltas,
} from '../../news-harness/scoring-engine/calibration';

// --- settings keys ---------------------------------------------------------

const KEY_COUNTER = 'calibration.override_counter';
const KEY_SAMPLE = 'calibration.override_sample';
const KEY_OVERRIDES = 'calibration.scoring_overrides';

/** Model + output budget for the single calibration completion. */
const CALIBRATION_MODEL = SMALL_MODEL;
const CALIBRATION_MAX_TOKENS = 256;
const CALIBRATION_TEMPERATURE = 0.2;

// --- persistence helpers ---------------------------------------------------

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await getSetting(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn('[calibration-service] failed to read setting — using fallback', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

async function readCounter(): Promise<OverrideCounterState> {
  const s = await readJson<OverrideCounterState>(KEY_COUNTER, EMPTY_COUNTER_STATE);
  // Defensive: normalize a partial/corrupt row back to a valid shape.
  return {
    count: typeof s.count === 'number' ? s.count : 0,
    windowStartMs: typeof s.windowStartMs === 'number' ? s.windowStartMs : 0,
    lastNotifiedMs: typeof s.lastNotifiedMs === 'number' ? s.lastNotifiedMs : null,
    lastCalibrationMs: typeof s.lastCalibrationMs === 'number' ? s.lastCalibrationMs : null,
  };
}

async function readSample(): Promise<CalibrationCase[]> {
  const s = await readJson<CalibrationCase[]>(KEY_SAMPLE, []);
  return Array.isArray(s) ? s : [];
}

// --- override capture + notification ---------------------------------------

export interface RecordOverridesResult {
  /** Total large overrides accumulated in the current window (post-record). */
  count: number;
  /** True if this call produced the "recalibrate?" notification. */
  notified: boolean;
}

/**
 * Record a batch of LARGE judge overrides (rows where |judge − computed| >
 * OVERRIDE_DELTA), captured by the scoring hot path. Cheap: one settings
 * read + write of the counter (+ the bounded sample). When the window count
 * crosses the threshold and the rails allow, PRODUCES the `calibration`
 * notification (persisted row + toast toward the bell) — no API call here.
 *
 * A no-op when `cases` is empty (the hot path skips the call entirely then).
 */
export async function recordOverrides(
  cases: CalibrationCase[],
): Promise<RecordOverridesResult> {
  if (cases.length === 0) {
    const cur = await readCounter();
    return { count: cur.count, notified: false };
  }

  const nowMs = Date.now();
  const prev = await readCounter();
  const next = recordInWindow(prev, cases.length, nowMs);

  // If the window rolled over (re-anchored), the old sample is stale — drop it.
  const rolled = next.windowStartMs !== prev.windowStartMs;
  const prevSample = rolled ? [] : await readSample();
  const sample = appendCappedSample(prevSample, cases);

  let notified = false;
  let stateToPersist = next;
  if (shouldFireNotification(next, nowMs)) {
    try {
      await fireCalibrationNotification(next.count);
      stateToPersist = { ...next, lastNotifiedMs: nowMs };
      notified = true;
    } catch (err) {
      logger.captureException(err, {
        tags: { service: 'calibration-service', method: 'recordOverrides.notify' },
      });
    }
  }

  await Promise.all([
    setSetting(KEY_COUNTER, JSON.stringify(stateToPersist)),
    setSetting(KEY_SAMPLE, JSON.stringify(sample)),
  ]);

  return { count: next.count, notified };
}

/** Produce the calibration notification row + bell toast with the recalibrate
 *  chip. Raw i18n keys are stored so the panel re-resolves them per locale. */
async function fireCalibrationNotification(count: number): Promise<void> {
  await toastManager.showNotifiedToast({
    type: 'calibration',
    source: 'calibration-service',
    title: 'calibration.notificationTitle',
    body: 'calibration.notificationBody',
    icon: 'tune',
    action: 'info',
    context: { count },
    actions: [{ id: 'recalibrate', labelKey: 'calibration.recalibrateChip' }],
  });
  logger.info('[calibration-service] calibration notification produced', { count });
}

// --- overrides layer (read by the scoring engine) --------------------------

/** The persisted fractional overrides the math engine layers over the base
 *  ScoringEngineConfig at scoring time. {} when never calibrated. */
export async function getScoringOverrides(): Promise<ScoringConstantDeltas> {
  const raw = await readJson<ScoringConstantDeltas>(KEY_OVERRIDES, {});
  return raw && typeof raw === 'object' ? raw : {};
}

// --- the calibration run (explicit user confirm ONLY) ----------------------

export interface CalibrationOutcome {
  status: 'applied' | 'no_change' | 'failed';
  /** The clamped deltas applied this run (status 'applied'). */
  applied?: ScoringConstantDeltas;
  /** The full overrides layer after the merge (status 'applied'). */
  overrides?: ScoringConstantDeltas;
  /** change-log row id (status 'applied') — carries { before, after } to revert. */
  changeLogId?: string;
}

/**
 * Run the calibration: build the report from the retained override sample, make
 * the ONE E2EE gateway call, clamp + compose the returned tweaks onto the
 * persisted overrides, change-log the mutation, and reset the counter.
 * Fail-safe: gateway/parse failure returns 'failed' and leaves state untouched.
 */
export async function runCalibration(): Promise<CalibrationOutcome> {
  const sample = await readSample();
  const report = buildCalibrationReport(sample);

  let rawDeltas: Record<string, number>;
  try {
    const output = await cloudComplete({
      systemPrompt: CALIBRATION_SYSTEM_PROMPT,
      prompt: buildCalibrationUserMessage(report),
      model: CALIBRATION_MODEL,
      maxTokens: CALIBRATION_MAX_TOKENS,
      temperature: CALIBRATION_TEMPERATURE,
    });
    rawDeltas = parseCalibrationDeltas(output);
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'calibration-service', method: 'runCalibration.gateway' },
    });
    return { status: 'failed' };
  }

  const clamped = clampCalibrationDeltas(rawDeltas, DEFAULT_HARNESS_CONFIG.scoringEngine);
  if (Object.keys(clamped).length === 0) {
    // Nothing actionable came back — reset the counter (the invitation is
    // consumed) but record no change.
    await resetCounterAfterCalibration();
    logger.info('[calibration-service] calibration produced no actionable deltas');
    return { status: 'no_change' };
  }

  const prevOverrides = await getScoringOverrides();
  const nextOverrides = mergeAndClampOverrides(prevOverrides, clamped);
  await setSetting(KEY_OVERRIDES, JSON.stringify(nextOverrides));

  // Change-log the mutation. NOTE (wave 9): persona-change-log's revertChange
  // does not yet invert 'set_scoring_override'; we record { before, after } so a
  // later wave (or restoreScoringOverrides below) can revert it.
  let changeLogId: string | undefined;
  try {
    const row = await appendChangeLog({
      actionType: 'set_scoring_override',
      action: { before: prevOverrides, after: nextOverrides, delta: undefined },
      source: 'user',
      summary: `Recalibrated scoring engine (${Object.keys(clamped).length} constants tuned)`,
    });
    changeLogId = row.id;
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'calibration-service', method: 'runCalibration.changelog' },
    });
  }

  await resetCounterAfterCalibration();
  logger.info('[calibration-service] calibration applied', {
    tuned: Object.keys(clamped),
  });
  return { status: 'applied', applied: clamped, overrides: nextOverrides, changeLogId };
}

/** Reset counter + clear the sample; stamp lastCalibrationMs (arms the ≤1/7d
 *  rail). Called after every completed run (applied or no_change). */
async function resetCounterAfterCalibration(): Promise<void> {
  const nowMs = Date.now();
  const cleared: OverrideCounterState = {
    count: 0,
    windowStartMs: nowMs,
    lastNotifiedMs: null,
    lastCalibrationMs: nowMs,
  };
  await Promise.all([
    setSetting(KEY_COUNTER, JSON.stringify(cleared)),
    setSetting(KEY_SAMPLE, JSON.stringify([])),
  ]);
}

/**
 * Revert the scoring-override layer to a prior state (the `before` recorded in a
 * `set_scoring_override` change-log row). Provided because revertChange can't
 * yet invert this action type; the audit UI can call this directly.
 */
export async function restoreScoringOverrides(
  overrides: ScoringConstantDeltas,
): Promise<void> {
  await setSetting(KEY_OVERRIDES, JSON.stringify(overrides ?? {}));
}
