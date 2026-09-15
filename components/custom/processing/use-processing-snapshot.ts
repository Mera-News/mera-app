import { useRef } from 'react';
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
  useForYouSyncStatusMessage,
} from '@/lib/stores/selectors';
import type { ProcessingSnapshot } from './types';

const EMPTY_CHUNKS: readonly [] = [];

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

  const reduceMotion = useReducedMotion();
  const staticGradient = useDisplayPrefsStore((s) => s.staticGradient);
  const animationsActive = useAnimationsActive();

  const highWater = useRef<ProcessingStageId | null>(null);

  const visible = schedulerRunning || isFeedProcessing;
  const stage = visible
    ? resolveProcessingStage({
        syncState: syncStatusMessage?.state ?? null,
        schedulerRunning,
        isFeedProcessing,
        asyncJobPhase,
        isDeviceProcessing,
        chunks: chunkStates?.chunks ?? null,
        previousStage: highWater.current,
      })
    : null;

  highWater.current = stage;

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
