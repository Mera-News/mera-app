export type FeedSyncState =
  | 'idle'
  | 'fetching-topic-ids'
  | 'diffing'
  | 'hydrating'
  // `persisting` is no longer part of the machine's runtime flow — hydrate,
  // persist, and enqueue are merged into the single `hydrating` state (see
  // stepHydratePersistEnqueue). The literal is retained ONLY so existing UI
  // status/progress components (banners, progress bars) that still branch on it
  // keep type-checking; the machine never transitions into it.
  | 'persisting'
  | 'scoring'
  | 'done'
  | 'paused-offline'
  | 'failed';

export type SyncErrorCode =
  | 'offline'
  | 'server-unreachable'
  | 'auth-expired'
  | 'no-topics-configured'
  | 'daily-limit'
  | 'storage-error'
  | 'scoring-unavailable'
  | 'unknown';

export interface SyncStatusMessage {
  state: FeedSyncState;
  headlineKey: string;
  detailKey?: string;
  progress?: { current: number; total: number };
  errorCode?: SyncErrorCode;
  isRecoverable: boolean;
  retryAt?: number;
  /** The state the machine was in when it transitioned to 'failed'. Used by
   *  the progress bar to highlight the specific segment that failed in red. */
  failedAtState?: FeedSyncState;
  /** The state the machine was in when it transitioned to 'paused-offline'.
   *  Used by the progress bar to freeze on the correct segment in amber. */
  pausedAtState?: FeedSyncState;
}

export class InvalidTransitionError extends Error {
  constructor(from: FeedSyncState, to: FeedSyncState) {
    super(`Invalid FeedSyncMachine transition: ${from} → ${to}`);
  }
}

export const NETWORK_DEPENDENT_STATES: FeedSyncState[] = [
  'fetching-topic-ids',
  'hydrating',
];

/** Persisted snapshot of the machine in WatermelonDB `settings`. */
export interface FeedSyncMachineSnapshot {
  state: FeedSyncState;
  startedAt: number;
  errorCode?: SyncErrorCode;
}

export const FEED_SYNC_MACHINE_KEY = 'feed_sync_machine_state';
export const STALE_MACHINE_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * What a BACKGROUND run (the `mera-background` OS task, no UI, 60s budget)
 * does differently, injected by `lib/background/background-feed-sync.ts`.
 *
 * Passing this puts the machine in background mode: no keep-awake, no toasts,
 * no status publishes, no daily-limit notice stamp, no offline pause (a lost
 * link fails the run instead of parking it), no foreground drain, and the
 * scoring step is the bounded background submit instead of `stepScore`.
 */
export interface BackgroundSyncHooks {
  /** Trim the new-to-device ids before anything is hydrated: the 6h ObjectId
   *  prefilter and the metered budget. Nothing outside the result is charged. */
  shapeDiff: (diff: import('./feed-sync-steps').DiffResult) => import('./feed-sync-steps').DiffResult;
  /** Submit the persisted, scorable ids. Null in on-device mode, where a
   *  background run fetches and persists only. */
  submit: ((articleIds: string[]) => Promise<void>) | null;
  /** The allowance ledger, reserved before each metered request and corrected
   *  down after it answers. See `HydratePersistEnqueueOptions.reserveMetered`. */
  reserveMetered: (requested: number) => Promise<void>;
  settleMetered: (requested: number, granted: number) => Promise<void>;
  /** How the metered hydrate ended. Called on the daily-limit throw too, with
   *  nothing delivered. */
  onHydrated: (outcome: { meteredDelivered: number; dailyLimitReached: boolean }) => Promise<void>;
  /** The store refresh, which the caller runs only when a reader can see it. */
  refreshStore: () => Promise<void>;
}
