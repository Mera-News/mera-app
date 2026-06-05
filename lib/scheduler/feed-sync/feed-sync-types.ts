export type FeedSyncState =
  | 'idle'
  | 'fetching-topic-ids'
  | 'diffing'
  | 'hydrating'
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
  | 'storage-error'
  | 'unknown';

export interface SyncStatusMessage {
  state: FeedSyncState;
  headlineKey: string;
  detailKey?: string;
  progress?: { current: number; total: number };
  errorCode?: SyncErrorCode;
  isRecoverable: boolean;
  retryAt?: number;
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
