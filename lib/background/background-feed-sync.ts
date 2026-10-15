// Step (b) of the `mera-background` run: fetch just enough fresh articles for
// the next open, persist them, and hand them to the bounded background submit.
//
// It drives the ordinary FeedSyncMachine in BACKGROUND MODE (see
// `BackgroundSyncHooks`) rather than a copy of it, so the persist, link and
// gate rules stay in one place.
//
// What makes a background wake different, and why each guard exists:
//   - Nothing is hydrated. `mera-protocol-store` would report CLOUD for an
//     on-device user, and `for-you-store`'s metadata setters write
//     `metaFromState(get())`, which from an unhydrated store overwrites the
//     saved feed metadata with defaults. Both are hydrated first.
//   - The fetch is sized by the open-ready target, not by what the server has:
//     the ids are prefiltered by ObjectId insert time and capped at BG_RUN_CAP
//     BEFORE hydrate. Every article fetched here is then read in the cloud,
//     which spends the reader's daily reading.
//   - Store refreshes only matter when someone is looking. A refresh is owed
//     (the dirty flag) and paid once the run settles, if the app is then
//     active, or on the next activation otherwise.

import { AppState, type AppStateStatus } from 'react-native';

import logger from '@/lib/logger';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import type { DiffResult } from '@/lib/scheduler/feed-sync/feed-sync-steps';
import type { BackgroundSyncHooks } from '@/lib/scheduler/feed-sync/feed-sync-types';
import type { TaskContext } from '@/lib/scheduler/scheduler-types';

import { readLastForegroundAt } from './bg-refresh-settings';
import {
  BG_RUN_CAP,
  isInsertedWithinWindow,
  measureOpenReadiness,
  plannedFetch,
} from './open-ready-target';

/** No fetch when the reader has not opened the app for this long: a user who
 *  never opens would otherwise be refilled every window, indefinitely. */
export const NO_FOREGROUND_SKIP_MS = 24 * 60 * 60 * 1000;

/** Most scoring batches one background run submits. */
export const BG_MAX_BATCHES = 3;

export type BackgroundFeedSyncStop =
  | 'no-foreground'
  | 'deadline'
  | 'error'
  | 'done';

export interface BackgroundFeedSyncResult {
  stoppedBy: BackgroundFeedSyncStop;
  /** Articles the run was allowed to hydrate (0 when it skipped, or when only followed stories ran). */
  fetchBudget: number;
}

// --- Store refresh owed to the reader ---------------------------------------

let refreshOwed = false;
let runsInFlight = 0;
let appStateSub: { remove: () => void } | null = null;

function requestRefresh(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require('@/lib/services/SuggestionSyncService') as typeof import('@/lib/services/SuggestionSyncService');
  return svc.requestSuggestionsRefresh();
}

/** Pay the owed refresh now if the app is active; otherwise leave it owed. */
function settleRefresh(): void {
  if (!refreshOwed) return;
  if (AppState.currentState !== 'active') return;
  // Never while a run is still saving rows: the refresh would show a partial
  // set and the flag would be gone before the rest landed.
  if (runsInFlight > 0) return;
  refreshOwed = false;
  requestRefresh().catch(() => {
    // The next foreground sync refreshes anyway.
  });
}

function ensureActivationListener(): void {
  if (appStateSub) return;
  appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') settleRefresh();
  });
}

/** Test seam. */
export function __resetBackgroundFeedSyncForTests(): void {
  refreshOwed = false;
  runsInFlight = 0;
  appStateSub?.remove();
  appStateSub = null;
}

export function isRefreshOwed(): boolean {
  return refreshOwed;
}

// --- The diff shaping --------------------------------------------------------

/**
 * Keep only ids inserted inside the freshness window, then cap the persona set
 * at `fetchBudget`. Order is preserved, and the persona ids arrive topics
 * first and headlines last, so a cap clips headlines before the reader's own
 * topics. Followed-story ids keep updating whatever the target says, with the
 * same per-run bound so one run stays small.
 */
export function shapeBackgroundDiff(
  diff: DiffResult,
  now: number,
  fetchBudget: number,
  storyBound: number = BG_RUN_CAP,
): DiffResult {
  const fresh = (id: string) => isInsertedWithinWindow(id, now);
  const storyIds = (diff.storyIds ?? []).filter(fresh).slice(0, storyBound);
  const personaIds = (diff.personaIds ?? diff.missingIds).filter(fresh).slice(0, fetchBudget);
  const keep = new Set([...storyIds, ...personaIds]);
  return {
    ...diff,
    missingIds: diff.missingIds.filter((id) => keep.has(id)),
    storyIds,
    personaIds,
  };
}

// --- The run -----------------------------------------------------------------

function makeTaskContext(signal: AbortSignal): TaskContext {
  return {
    jobId: 'mera-background',
    attempt: 1,
    signal,
    reportProgress: () => {},
    log: (message) => logger.debug(`[bg-feed-sync] ${message}`),
    markNoOp: () => {},
  };
}

async function hydrateRunPrerequisites(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useDatabaseStore } = require('@/lib/stores/database-store') as typeof import('@/lib/stores/database-store');
  // The foreground boot already hydrated both (it may be running in this same
  // process on an iOS wake).
  if (useDatabaseStore.getState().ready) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useMeraProtocolStore } = require('@/lib/stores/mera-protocol-store') as typeof import('@/lib/stores/mera-protocol-store');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useForYouStore } = require('@/lib/stores/for-you-store') as typeof import('@/lib/stores/for-you-store');
  await Promise.all([
    useMeraProtocolStore.getState().hydrateFromDb(),
    useForYouStore.getState().hydrateMetadataFromDb(),
  ]);
}

export async function runBackgroundFeedSync(opts: {
  deadlineAt: number;
  now?: number;
}): Promise<BackgroundFeedSyncResult> {
  const now = opts.now ?? Date.now();

  const lastForeground = await readLastForegroundAt();
  if (lastForeground === null || now - lastForeground > NO_FOREGROUND_SKIP_MS) {
    return { stoppedBy: 'no-foreground', fetchBudget: 0 };
  }

  await hydrateRunPrerequisites();

  // A met target stops only the persona ids. Followed stories keep updating
  // (owner ruling), so the run goes on with a budget of zero for the rest.
  const fetchBudget = plannedFetch(await measureOpenReadiness(now));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useMeraProtocolStore } = require('@/lib/stores/mera-protocol-store') as typeof import('@/lib/stores/mera-protocol-store');
  const onDevice = useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice;

  const controller = new AbortController();
  const remaining = Math.max(0, opts.deadlineAt - Date.now());
  const abortTimer = setTimeout(() => controller.abort(), remaining);

  const hooks: BackgroundSyncHooks = {
    shapeDiff: (diff) => shapeBackgroundDiff(diff, now, fetchBudget),
    // On-device mode fetches and persists only: scoring needs the local model,
    // which a background run never loads.
    submit: onDevice
      ? null
      : async (articleIds) => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const pipeline = require('@/lib/services/scoring-pipeline') as typeof import('@/lib/services/scoring-pipeline');
          await pipeline.submitScoringForBackground({
            deadlineAt: opts.deadlineAt,
            articleIds,
            maxBatches: BG_MAX_BATCHES,
          });
        },
    refreshStore: async () => {
      // Owed until the run settles, even if paid progressively here: a reader
      // who opened mid-run sees chunks land, and still gets the final refresh.
      refreshOwed = true;
      if (AppState.currentState === 'active') await requestRefresh();
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { feedSyncMachine } = require('@/lib/scheduler/feed-sync/FeedSyncMachine') as typeof import('@/lib/scheduler/feed-sync/FeedSyncMachine');

  ensureActivationListener();
  runsInFlight += 1;
  const run = feedSyncMachine
    .start('', makeTaskContext(controller.signal), { background: hooks })
    .then(
      () => 'done' as const,
      (err: unknown) => {
        if (controller.signal.aborted) return 'deadline' as const;
        logger.addBreadcrumb('bg-feed-sync: run failed', 'background', { error: String(err) }, 'warning');
        return 'error' as const;
      },
    )
    .finally(() => {
      clearTimeout(abortTimer);
      runsInFlight -= 1;
      settleRefresh();
    });

  // The machine checks the signal between steps, but a request already on the
  // wire can outlive it. The OS window is not ours to hold, so the run returns
  // at the deadline and the machine unwinds on its own.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    deadlineTimer = setTimeout(() => resolve('deadline'), remaining);
  });
  const stoppedBy = await Promise.race([run, deadline]);
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  return { stoppedBy, fetchBudget };
}
