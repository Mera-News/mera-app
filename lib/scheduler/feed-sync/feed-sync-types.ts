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
