/**
 * Which of the six processing stages the feed is in, as a pure function.
 *
 * ── Why this lives in lib/ and not beside the hook ──────────────────────────
 *
 * It is the decision table the whole processing area is built on, it is the
 * shared question every surface would otherwise answer slightly differently,
 * and it belongs under the coverage gate honestly rather than being parked in
 * `components/` to dodge it. `use-processing-snapshot.ts` is the only
 * subscription layer over it and holds no decisions of its own.
 *
 * No React, no store reads, no `Date.now()`. Everything it needs arrives in one
 * struct, which is what makes the table testable row by row.
 *
 * ── The one trap ────────────────────────────────────────────────────────────
 *
 * **This must not be driven by `syncStatusMessage` alone.**
 * `FeedSyncIndicator.tsx` documents why in full: the first happy-path publish
 * is `'hydrating'`, i.e. AFTER the snapshot load, the keep-awake, the
 * pipeline-status check, two network round trips and the diff. And it is
 * skipped ENTIRELY on the `missingIds.length === 0` branch and when the scoring
 * pipeline is already running. So a stage resolver that reads only the message
 * appears seconds late, or never.
 *
 * The scheduler flag is therefore a first-class input and the fallback:
 * `reserveTask` is a synchronous `set()`, so `schedulerRunning` lights on the
 * same JS tick as the pull and resolution falls through to `fetching` while no
 * message has been published yet. That is the check the simulator pass is for.
 */
import type { FeedSyncState } from '@/lib/scheduler/feed-sync/feed-sync-types';
import type { ChunkState } from '@/lib/services/scoring-pipeline';

export const PROCESSING_STAGE_IDS = [
  'fetching',
  'downloading',
  'grouping',
  'analysing',
  'summarising',
  'preparing',
] as const;

export type ProcessingStageId = (typeof PROCESSING_STAGE_IDS)[number];

export interface ProcessingStageInput {
  /** `syncStatusMessage?.state`, or null when nothing has been published. */
  readonly syncState: FeedSyncState | null;
  /** `useFeedSyncRunning()` — the real scheduler job status. */
  readonly schedulerRunning: boolean;
  /** `useIsFeedProcessing()` — the composite "work in flight". */
  readonly isFeedProcessing: boolean;
  readonly asyncJobPhase: 'idle' | 'relevance' | 'reasons';
  readonly isDeviceProcessing: boolean;
  /** Per-batch state, or null when no run is active. */
  readonly chunks: readonly ChunkState[] | null;
  /** The last stage this area displayed, or null at the start of a run. */
  readonly previousStage: ProcessingStageId | null;
}

const STAGE_ORDER = new Map<ProcessingStageId, number>(
  PROCESSING_STAGE_IDS.map((id, i) => [id, i]),
);

/** Index of a stage in the six-step order, for the progress bar. */
export function processingStageIndex(id: ProcessingStageId): number {
  return STAGE_ORDER.get(id) ?? 0;
}

/**
 * The scoring gate elects ONE representative per duplicate story group and
 * holds its siblings back, and while it is doing that every non-terminal batch
 * is still `queued`. That window is the grouping stage: there is a run, and
 * nothing in it has been submitted yet.
 */
function isGrouping(chunks: readonly ChunkState[] | null): boolean {
  if (!chunks || chunks.length === 0) return false;
  const live = chunks.filter((c) => c !== 'ready' && c !== 'failed');
  return live.length > 0 && live.every((c) => c === 'queued');
}

function fromSyncState(state: FeedSyncState): ProcessingStageId | null {
  switch (state) {
    case 'fetching-topic-ids':
    case 'diffing':
      return 'fetching';
    case 'hydrating':
    // `persisting` is DEAD: feed-sync-types says the machine never transitions
    // into it, hydrate/persist/enqueue having been merged into `hydrating`. It
    // is here for exhaustiveness only. Never give it a stage of its own and
    // never test a UI path through it as if a user could reach it.
    case 'persisting':
      return 'downloading';
    case 'scoring':
      return 'analysing';
    case 'idle':
    case 'done':
    case 'paused-offline':
    case 'failed':
      return null;
  }
}

function rawStage(input: ProcessingStageInput): ProcessingStageId | null {
  const { syncState, schedulerRunning, isFeedProcessing } = input;

  // Cloud and on-device scoring outrank the sync machine's own state: the
  // pipeline can still be writing notes long after the machine has said `done`.
  if (input.asyncJobPhase === 'reasons') return 'summarising';
  if (input.asyncJobPhase === 'relevance' || input.isDeviceProcessing) return 'analysing';
  if (isGrouping(input.chunks)) return 'grouping';

  if (syncState) {
    const fromState = fromSyncState(syncState);
    if (fromState) return fromState;
  }

  // Nothing above is active. The scheduler flag alone is enough to show the
  // area, and it is the ONLY signal on the `missingIds.length === 0` branch.
  if (schedulerRunning && !syncState) return 'fetching';
  if (schedulerRunning || isFeedProcessing) return 'preparing';
  return null;
}

/**
 * Resolve the stage, monotonically within a run.
 *
 * Once stage N has been reached the area never displays a lower one, even if a
 * signal briefly drops out. Without this, `hydrating` clearing before the
 * pipeline publishes `relevance` visibly walks the reader backwards, which
 * reads as the app losing its place rather than as a gap in the telemetry.
 *
 * The high-water mark is released by returning `null`: when there is no work at
 * all the caller drops `previousStage` and the next run starts from the top.
 */
export function resolveProcessingStage(
  input: ProcessingStageInput,
): ProcessingStageId | null {
  const next = rawStage(input);
  if (next === null) return null;
  const { previousStage } = input;
  if (previousStage === null) return next;
  return processingStageIndex(next) >= processingStageIndex(previousStage)
    ? next
    : previousStage;
}
