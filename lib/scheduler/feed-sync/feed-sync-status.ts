import { useForYouStore } from '@/lib/stores/for-you-store';
import type { FeedSyncState, SyncErrorCode, SyncStatusMessage } from './feed-sync-types';

function makeMessage(
  state: FeedSyncState,
  overrides?: Partial<SyncStatusMessage>,
): SyncStatusMessage {
  const defaults: Record<FeedSyncState, Pick<SyncStatusMessage, 'headlineKey' | 'isRecoverable'>> = {
    idle:                  { headlineKey: '',                          isRecoverable: true },
    'fetching-topic-ids':  { headlineKey: 'sync.fetchingTopics',       isRecoverable: false },
    diffing:               { headlineKey: 'sync.checkingForUpdates',   isRecoverable: false },
    hydrating:             { headlineKey: 'sync.downloadingArticles',  isRecoverable: false },
    persisting:            { headlineKey: 'sync.savingArticles',       isRecoverable: false },
    scoring:               { headlineKey: 'sync.analyzingRelevance',   isRecoverable: false },
    done:                  { headlineKey: 'sync.upToDate',             isRecoverable: true },
    'paused-offline':      { headlineKey: 'sync.waitingForConnection', isRecoverable: true },
    failed:                { headlineKey: 'sync.syncFailed',           isRecoverable: false },
  };

  return { state, ...defaults[state], ...overrides };
}

export function publishSyncStatus(
  state: FeedSyncState,
  overrides?: Partial<SyncStatusMessage>,
): void {
  if (state === 'idle') {
    useForYouStore.getState().setSyncStatusMessage(null);
    return;
  }
  useForYouStore.getState().setSyncStatusMessage(makeMessage(state, overrides));
}

export function publishSyncError(
  errorCode: SyncErrorCode,
  retryAt?: number,
  failedAtState?: FeedSyncState,
): void {
  const headlineMap: Record<SyncErrorCode, string> = {
    offline:               'sync.waitingForConnection',
    'server-unreachable':  'sync.serverUnavailable',
    'auth-expired':        'sync.sessionExpired',
    'no-topics-configured': 'sync.noTopics',
    'daily-limit':         'sync.dailyLimitReached',
    'storage-error':       'sync.storageFull',
    'scoring-unavailable': 'sync.syncFailed',
    unknown:               'sync.syncFailed',
  };

  useForYouStore.getState().setSyncStatusMessage({
    state: 'failed',
    headlineKey: headlineMap[errorCode] ?? 'sync.syncFailed',
    errorCode,
    isRecoverable: errorCode === 'offline' || errorCode === 'server-unreachable',
    retryAt,
    failedAtState,
  });
}

export function classifyError(err: unknown): SyncErrorCode {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('no-topics-configured') || msg === 'no-topics-configured') {
      return 'no-topics-configured';
    }
    if (msg.includes('network') || msg.includes('fetch') || msg.includes('timeout')) {
      return 'server-unreachable';
    }
    if (msg.includes('unauthenticated') || msg.includes('401') || msg.includes('session')) {
      return 'auth-expired';
    }
    if (msg.includes('storage') || msg.includes('disk')) {
      return 'storage-error';
    }
    if (
      (err as { code?: string }).code === 'daily-limit' ||
      msg === 'daily-limit'
    ) {
      return 'daily-limit';
    }
    if ((err as { code?: string }).code === 'no-topics-configured') {
      return 'no-topics-configured';
    }
    if ((err as { code?: string }).code === 'no-push-token') {
      return 'scoring-unavailable';
    }
  }
  return 'unknown';
}
