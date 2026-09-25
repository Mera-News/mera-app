/**
 * What the Feed header says while a sync is really running (only the Feed
 * narrates; the Dashboard shows the Mera mark instead), as a pure function.
 *
 * ── Why this lives in lib/services and not beside the component ─────────────
 *
 * Same reason as `processing-stage.ts` and `chat-phase.ts`, which this file is
 * deliberately shaped after: it is the decision table two screens would
 * otherwise each answer slightly differently, and it belongs under the
 * coverage gate honestly rather than being parked in `components/` to dodge it.
 *
 * No React, no store, no i18n and NO CLOCK. The interval that drives `tick`
 * and the crossfade that hides the swap are properties of the surface and live
 * in `HeaderNarrationLine`. Everything here is a total function of its
 * arguments, which is what makes the table testable row by row.
 *
 * ── The three things that are not obvious ───────────────────────────────────
 *
 * 1. **THE CYCLE ALTERNATES, AND TICK 0 IS A STAGE SLOT.** The title vanishes
 *    when a run starts, so the very first thing in its place has to say why
 *    the header changed. A nudge first ("Save what you cannot read right now.")
 *    would read as an unprompted interruption.
 *
 * 2. **PARITY AND THE NUDGE CURSOR ARE RUN-SCOPED, NOT STAGE-SCOPED.** This is
 *    a deliberate divergence from both precedents, which reset their cursor on
 *    every pool change. Reset parity per stage and a run that walks
 *    `fetching -> downloading -> grouping` in six seconds is all even ticks, so
 *    it shows only stage lines and THE NUDGES NEVER APPEAR AT ALL. Only the
 *    STAGE cursor is stage-scoped, which keeps the property the precedents
 *    actually care about: a new stage opens on its own first line rather than
 *    halfway down its pool.
 *
 * 3. **`stage === null` RESOLVES TO A POOL, NEVER TO NOTHING.** `isFeedProcessing`
 *    can be true before a stage resolves, and the row is height-pinned, so a
 *    null here would paint a blank box where the title used to be. `'starting'`
 *    is the honest thing to say in that window and is what the reader sees
 *    first on most runs. Same reason `OPENING_PHASE_ID` exists in
 *    `chat-phases.ts`.
 */

import type { ProcessingStageId } from '@/lib/services/processing-stage';

/**
 * The pools a stage slot can draw from: the six pipeline stages, plus two that
 * are not stages at all.
 *
 * `starting` covers the window before a stage resolves. `onDevice` is not a
 * seventh stage in the pipeline — it is the same `analysing` step done locally,
 * and it exists as its own pool ONLY because on-device scoring can honestly say
 * nothing leaves the phone and the cloud round trip cannot. One step, two
 * truthful descriptions, chosen by where the work happens.
 */
export const HEADER_STAGE_POOL_IDS = [
  'starting',
  'fetching',
  'downloading',
  'grouping',
  'analysing',
  'onDevice',
  'summarising',
  'preparing',
] as const;

export type HeaderStagePoolId = (typeof HEADER_STAGE_POOL_IDS)[number];

/** Which slot this tick is. */
export type HeaderNarrationKind = 'stage' | 'nudge';

/** Every pool the line can draw from, stage pools plus the one nudge pool. */
export type HeaderNarrationPoolId = HeaderStagePoolId | 'nudges';

/**
 * The pipeline stage a slot should describe.
 *
 * `onDevice` overrides `analysing` ALONE. The other five stages are the same
 * work either way — a download is a download — and giving them on-device
 * variants would mean five more pools whose copy differs in nothing a reader
 * could act on.
 */
export function headerStagePool(
  stage: ProcessingStageId | null,
  onDevice: boolean,
): HeaderStagePoolId {
  if (stage === null) return 'starting';
  if (stage === 'analysing' && onDevice) return 'onDevice';
  return stage;
}

export interface ResolveHeaderNarrationInput {
  /** Slots elapsed in THIS RUN. 0 on the first line, +1 per swap. */
  readonly tick: number;
  /** The `tick` at which the current stage pool became current. */
  readonly stageStartTick: number;
  /** The live pipeline stage, or null before one resolves. */
  readonly stage: ProcessingStageId | null;
  /** Scoring is happening locally rather than in the cloud. */
  readonly onDevice: boolean;
  /**
   * Where in the nudge pool this run starts.
   *
   * Runs happen many times a day, so without this every run would open on the
   * same nudge and a reader would see one sentence far more than the rest. The
   * caller draws it across the pool's whole length. The caller picks it once per run; the
   * resolver only adds it, so a fixed seed makes the whole table deterministic
   * in a test.
   */
  readonly nudgeSeed: number;
}

export interface HeaderNarration {
  readonly kind: HeaderNarrationKind;
  readonly poolId: HeaderNarrationPoolId;
  /**
   * How far into the pool to read, UNBOUNDED and never negative.
   *
   * Deliberately not reduced modulo a pool length: this module holds no copy
   * and therefore does not know how long any pool is. The registry owns the
   * lengths and wraps. Returning a raw count also means a test can assert the
   * cursor advanced without knowing what the copy happens to be today.
   */
  readonly cursor: number;
}

/**
 * One tick of the line.
 *
 * Total over every input, including a `stageStartTick` ahead of `tick`, which
 * a caller should never produce but which must not yield a negative index into
 * a pool if one ever does.
 */
export function resolveHeaderNarration({
  tick,
  stageStartTick,
  stage,
  onDevice,
  nudgeSeed,
}: ResolveHeaderNarrationInput): HeaderNarration {
  const kind: HeaderNarrationKind = tick % 2 === 0 ? 'stage' : 'nudge';

  if (kind === 'nudge') {
    // RUN-scoped: `tick`, not `tick - stageStartTick`. See note 2 above.
    return { kind, poolId: 'nudges', cursor: nudgeSeed + Math.floor(tick / 2) };
  }

  // STAGE-scoped, so a stage that has just begun opens on its own first line.
  const elapsed = Math.max(0, tick - stageStartTick);
  return {
    kind,
    poolId: headerStagePool(stage, onDevice),
    cursor: Math.floor(elapsed / 2),
  };
}

/**
 * The bookkeeping a caller does between ticks, as a pure reducer.
 *
 * It exists so the ONE piece of mutable state this feature has — when the
 * current stage began — is testable without a renderer. A component holding
 * this in a ref and comparing stages by hand is how "a new stage opens on its
 * own first line" silently stops being true: the comparison has to be against
 * the resolved POOL, not the raw stage, or an `analysing` run that flips to
 * on-device keeps the cursor it had and jumps into the middle of a pool whose
 * first line the reader never saw.
 */
export interface HeaderNarrationRun {
  readonly tick: number;
  readonly stageStartTick: number;
  /** The pool that was current at `stageStartTick`. */
  readonly pool: HeaderStagePoolId;
  readonly nudgeSeed: number;
}

export function startHeaderNarrationRun(
  stage: ProcessingStageId | null,
  onDevice: boolean,
  nudgeSeed: number,
): HeaderNarrationRun {
  return { tick: 0, stageStartTick: 0, pool: headerStagePool(stage, onDevice), nudgeSeed };
}

/** Advance one slot, restarting the stage cursor if the pool changed. */
export function advanceHeaderNarrationRun(
  prev: HeaderNarrationRun,
  stage: ProcessingStageId | null,
  onDevice: boolean,
): HeaderNarrationRun {
  const tick = prev.tick + 1;
  const pool = headerStagePool(stage, onDevice);
  if (pool === prev.pool) return { ...prev, tick };
  // The stage cursor restarts here and the nudge cursor deliberately does not,
  // because it is derived from `tick`, which this never rewinds.
  return { ...prev, tick, stageStartTick: tick, pool };
}
