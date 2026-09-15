/**
 * The processing area's frozen contract. Every other file in this directory
 * reads from here and nothing writes back.
 *
 * `ProcessingStageId` itself is NOT redeclared here: it is owned by
 * `lib/services/processing-stage.ts`, where the decision table that produces it
 * lives, and is re-exported so a component never has two names for one thing.
 */
export {
  PROCESSING_STAGE_IDS,
  processingStageIndex,
  type ProcessingStageId,
} from '@/lib/services/processing-stage';
export type { ChunkState } from '@/lib/services/scoring-pipeline';

import { PROCESSING_STAGE_IDS as STAGE_IDS } from '@/lib/services/processing-stage';
import type { ProcessingStageId } from '@/lib/services/processing-stage';
import type { ChunkState } from '@/lib/services/scoring-pipeline';

const PROCESSING_STAGE_COUNT = STAGE_IDS.length;

/**
 * The in-list card's height, in points. FIXED, and not negotiable down to a
 * `minHeight`.
 *
 * The Feed is an insert-only list under `maintainVisibleContentPosition` that
 * grows upward, and `DashboardSectionsFeed.tsx` carries a written record of a
 * pull-to-refresh bug traced to MVCP interacting with constant re-derivation. A
 * list item whose height changes as it loads re-opens that bug class, so every
 * string inside this card carries a `numberOfLines` clamp and the rotating
 * headline sits in a fixed two-line box: the longest locale must not be able to
 * grow it and the shortest must not be able to shrink it.
 */
export const PROCESSING_CARD_HEIGHT = 300;

/**
 * The chunk strip's reserved height, in points. Reserved whenever a run could
 * appear, including before the first batch exists.
 *
 * Chunk COUNT grows mid-run (the scoring gate re-elects held-back duplicate
 * siblings into new batches), so the strip must absorb that by making its
 * segments narrower. It must never get taller.
 */
export const PROCESSING_STRIP_HEIGHT = 28;

/**
 * Six, and every surface draws its bar from this rather than from a literal.
 *
 * It lives HERE and not beside the hook on purpose: `ProcessingArea` is
 * presentational, and importing anything from `use-processing-snapshot.ts`
 * drags `FeedSyncIndicator` in, and through it `AppScheduler` and the
 * WatermelonDB singleton, which is instantiated at import time. A component
 * test then fails on `initializeJSI` with a stack that points at a constant.
 */
export const PROCESSING_TOTAL_STAGES = PROCESSING_STAGE_COUNT;

/** The square animation block inside the card, in points. */
export const PROCESSING_SCENE_SIZE = 120;

/** How long a rotating headline holds before the crossfade. */
export const PROCESSING_HEADLINE_CYCLE_MS = 5000;

/**
 * Beyond this many chunks the strip buckets rather than drawing one segment
 * each: at the card's width a 40-segment strip is a grey smear.
 */
export const PROCESSING_MAX_CHUNK_SEGMENTS = 24;

/**
 * What one stage draws when no animation file exists for it.
 *
 * A UNION of kinds, and every consumer switches on it ABOVE the component
 * boundary, never inside one. `reactCompiler: true` is on, so a component that
 * branches on a union's `kind` and also calls `useSharedValue` has a
 * conditional hook; `MeraLogo.tsx` documents the same discipline. One component
 * per kind, each owning its own shared values, with a pure dispatcher above.
 */
export type StageFallbackKind =
  | 'converge'
  | 'descend'
  | 'merge'
  | 'sweep'
  | 'write'
  | 'stack';

/**
 * One row of the six-stage registry. Pure data: i18n KEY STRINGS only, never a
 * `t()` call and never JSX.
 *
 * The key fields are the LITERAL union of what the registry actually holds, not
 * `string`. i18n keys in this app are typed straight off `en.json` with no
 * codegen step, so a widened `string` here would force every call site through
 * the `tAny` escape hatch and throw away the one thing that catches a key
 * typo at compile time. `processing-stages.ts` derives this from its own `as
 * const` array, so adding a stage cannot forget to widen anything.
 */
export interface ProcessingStageDef<
  L extends string = string,
  H extends string = string,
> {
  readonly id: ProcessingStageId;
  /** `t()` key for the stage's own short label. */
  readonly labelKey: L;
  /** `t()` key for the rotating headline pool. Resolves to an ARRAY. */
  readonly headlinesKey: H;
  /** Drawn when `animation-registry.ts` has no entry for this stage. */
  readonly fallback: StageFallbackKind;
}

/** Everything the presentational components need, in one object. Produced by
 *  `use-processing-snapshot.ts` and by nothing else. */
export interface ProcessingSnapshot {
  /** False when the area must not render at all. */
  readonly visible: boolean;
  /** null only when `visible` is false. */
  readonly stage: ProcessingStageId | null;
  readonly stageIndex: number;
  /** 0..100 within the current stage, for the progress bar's active segment. */
  readonly stageValue: number;
  readonly chunks: readonly ChunkState[];
  readonly chunksReady: number;
  readonly chunksTotal: number;
  /** Articles hydrated of total, for the downloading stage's own line. */
  readonly hydrationCompleted: number;
  readonly hydrationTotal: number;
  /** Articles analysed of total, for the analysing stage's own line. */
  readonly analysedDone: number;
  readonly analysedTotal: number;
  /** Reduce Motion, or the app's own "Static background" setting. */
  readonly isStatic: boolean;
  /** Focused and foregrounded: whether anyone is actually looking. */
  readonly animationsActive: boolean;
}
