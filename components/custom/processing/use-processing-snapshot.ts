import { useReducedMotion } from 'react-native-reanimated';

import { useFeedSyncRunning, useIsFeedProcessing } from '@/components/custom/FeedSyncIndicator';
import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import {
  processingStageIndex,
  resolveProcessingStage,
  type ProcessingStageId,
} from '@/lib/services/processing-stage';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import {
  useForYouAsyncJobPhase,
  useForYouBatchProgress,
  useForYouChunkStates,
  useForYouDeviceProcessing,
  useForYouHydrationProgress,
  useForYouLastProcessingRunFinishedAt,
  useForYouSyncStatusMessage,
} from '@/lib/stores/selectors';
import type { ProcessingSnapshot } from './types';

const EMPTY_CHUNKS: readonly [] = [];

/**
 * The stage high-water mark, MODULE-LEVEL and shared by every caller.
 *
 * It was a `useRef` and that was a bug with a comment claiming the opposite.
 * This hook is called three times in a live run — the card, the panel's
 * headline, the panel's chunk row — so a per-mount ref gave each surface its
 * OWN mark. A panel opened mid-run starts at `null`, so the moment
 * `asyncJobPhase` drops to idle while `syncState` is still `hydrating`, the
 * panel resolves `downloading` while the card holds `summarising`: same run,
 * two different steps, on screen together. The mark is a property of the RUN,
 * not of a component instance, so it belongs where the run does.
 *
 * `runToken` closes the gap a bare module variable leaves. Both callers can be
 * unmounted across a run boundary (the card renders only on an empty list, the
 * panel only while expanded), so nothing would clear a stale high mark and the
 * next run would start part-way down its own bar.
 * `lastProcessingRunFinishedAt` changes exactly when a run ends, so comparing
 * it is a free run identity.
 *
 * Written during render, which is safe here for the same reason the arrival
 * diff in `FeedScreen` is: it is a monotonic max released only by `null`, so a
 * double render under StrictMode computes the identical value.
 */
const mark: { stage: ProcessingStageId | null; runToken: number | null } = {
  stage: null,
  runToken: null,
};

/** Test seam. Nothing in the app calls this; the mark is released by the area
 *  going invisible or by a new run. */
export function _resetProcessingStageMarkForTests(): void {
  mark.stage = null;
  mark.runToken = null;
}

/**
 * The one subscription layer under the processing area. Every other component
 * in this directory is presentational and reads only this.
 *
 * All the DECISIONS live in `lib/services/processing-stage.ts`; this file wires
 * stores to that pure function and holds one ref. Keeping the split honest is
 * what lets the stage table be tested row by row without a renderer.
 *
 * ## Visibility
 *
 * `useFeedSyncRunning() || useIsFeedProcessing()` — exactly what
 * `FeedSyncIndicator` already ORs together, and not a fork of it. The scheduler
 * flag lights on the same JS tick as the pull because `reserveTask` is a
 * synchronous `set()`, which is what makes the area appear on the same frame as
 * a pull-to-refresh rather than seconds later when the first status message is
 * finally published.
 *
 * ## The high-water ref
 *
 * Held here rather than in the pure function because it is per-mount state, and
 * released the moment the area goes invisible so the next run starts from the
 * top. A ref and not state: it never drives a render on its own, it only
 * clamps the value this render already computed.
 */
export function useProcessingSnapshot(): ProcessingSnapshot {
  const schedulerRunning = useFeedSyncRunning();
  const isFeedProcessing = useIsFeedProcessing();
  const syncStatusMessage = useForYouSyncStatusMessage();
  const asyncJobPhase = useForYouAsyncJobPhase();
  const { isDeviceProcessing } = useForYouDeviceProcessing();
  const chunkStates = useForYouChunkStates();
  const batchProgress = useForYouBatchProgress();
  const { hydrationCompleted, hydrationTotal } = useForYouHydrationProgress();
  const lastRunFinishedAt = useForYouLastProcessingRunFinishedAt();

  const reduceMotion = useReducedMotion();
  const staticGradient = useDisplayPrefsStore((s) => s.staticGradient);
  const animationsActive = useAnimationsActive();

  if (mark.runToken !== lastRunFinishedAt) {
    mark.runToken = lastRunFinishedAt;
    mark.stage = null;
  }

  const visible = schedulerRunning || isFeedProcessing;
  const stage = visible
    ? resolveProcessingStage({
        syncState: syncStatusMessage?.state ?? null,
        schedulerRunning,
        isFeedProcessing,
        asyncJobPhase,
        isDeviceProcessing,
        chunks: chunkStates?.chunks ?? null,
        previousStage: mark.stage,
      })
    : null;

  mark.stage = stage;

  const stageIndex = stage ? processingStageIndex(stage) : 0;

  return {
    visible: visible && stage !== null,
    stage,
    stageIndex,
    stageValue: stageValueFor(stage, {
      hydrationCompleted,
      hydrationTotal,
      analysedDone: batchProgress?.done ?? 0,
      analysedTotal: batchProgress?.total ?? 0,
      chunksReady: chunkStates?.ready ?? 0,
      chunksTotal: chunkStates?.total ?? 0,
    }),
    chunks: chunkStates?.chunks ?? EMPTY_CHUNKS,
    chunksReady: chunkStates?.ready ?? 0,
    chunksTotal: chunkStates?.total ?? 0,
    hydrationCompleted,
    hydrationTotal,
    analysedDone: batchProgress?.done ?? 0,
    analysedTotal: batchProgress?.total ?? 0,
    isStatic: reduceMotion || staticGradient,
    animationsActive,
  };
}

interface StageValueInput {
  hydrationCompleted: number;
  hydrationTotal: number;
  analysedDone: number;
  analysedTotal: number;
  chunksReady: number;
  chunksTotal: number;
}

/**
 * How far through the CURRENT stage we are, 0..100, for the progress bar's
 * active segment.
 *
 * Only three of the six stages have an honest numerator, and the other three
 * report 0 rather than inventing one. A fabricated percentage is worse than no
 * percentage: the segment ahead of it still fills when the stage advances, so
 * the reader loses nothing, and the bar never claims to know something it does
 * not.
 */
function stageValueFor(
  stage: ProcessingStageId | null,
  input: StageValueInput,
): number {
  if (!stage) return 0;
  const pct = (done: number, total: number) =>
    total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
  switch (stage) {
    case 'downloading':
      return pct(input.hydrationCompleted, input.hydrationTotal);
    case 'analysing':
    case 'summarising':
      return pct(input.analysedDone, input.analysedTotal);
    case 'grouping':
      return pct(input.chunksReady, input.chunksTotal);
    case 'fetching':
    case 'preparing':
      return 0;
  }
}
