import { useForYouStore } from '@/lib/stores/for-you-store';
import type { FeedSyncState, SyncErrorCode, SyncStatusMessage } from './feed-sync-types';
import { InvalidTransitionError } from './feed-sync-types';

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
  // `headlineKey` HAS NO RENDERER, for EVERY entry below. This function always
  // publishes `state: 'failed'`; the only live read of `syncStatusMessage.headlineKey`
  // is `components/custom/for-you/FeedStatusDetails.tsx`, gated on `isSyncActive`,
  // which excludes `'failed'`. `NewsPollingBanner` and `MeraProtocolProcessingStatus`
  // have no importers anywhere in the app.
  //
  // Sync failures reach the reader through the Feed counts card instead:
  // `syncFailureKey` in `components/custom/for-you/card-state.ts` picks a
  // `feed.syncFailed.*` line from `errorCode` and `failedAtState`, so the step that
  // failed is named there.
  //
  // WHY NOTHING IS DELETED. The `sync.*` keys stay in 20 locale dictionaries and the
  // entries stay here: removing them is a 20-locale pass for strings no user can
  // see. The comment exists so the next person does not write, translate and review
  // new copy for an invisible string. If you need a failure message visible, add or
  // change a `feed.syncFailed.*` line; do not rewrite these and assume it shipped.
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
  // ALSO ABOVE THE SUBSTRING HEURISTICS, for the same reason. An
  // InvalidTransitionError's message embeds STATE NAMES, and
  // 'fetching-topic-ids' contains the substring 'fetch' — so
  // "Invalid FeedSyncMachine transition: fetching-topic-ids → scoring" was
  // classified `server-unreachable` and shown to the user as a red "can't reach
  // the server" banner, for a fault that is entirely internal and has nothing to
  // do with the network.
  if (err instanceof InvalidTransitionError) return 'unknown';

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
    if ((err as { code?: string }).code === 'no-topics-configured') {
      return 'no-topics-configured';
    }
    if ((err as { code?: string }).code === 'no-push-token') {
      return 'scoring-unavailable';
    }
  }
  return 'unknown';
}
