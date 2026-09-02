import { useForYouStore } from '@/lib/stores/for-you-store';
import { isNotSubscribedError } from '@/lib/subscription/not-subscribed-error';
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
  // THESE HEADLINES CANNOT CURRENTLY RENDER. Verified, and it applies to EVERY
  // entry below, not just one or two of them.
  //
  // The chain: this function always publishes `state: 'failed'`; the only live
  // render of `syncStatusMessage.headlineKey` is
  // `components/custom/for-you/FeedStatusDetails.tsx:106`, and it is gated on
  // `isSyncActive`, which explicitly excludes `'failed'` (:89-94). The only two
  // other components reading `headlineKey` — `NewsPollingBanner` and
  // `MeraProtocolProcessingStatus` — have no importers anywhere in the app.
  //
  // So the strings this map names are unreachable through this path. The
  // daily-cap notice the user actually sees is driven separately, off
  // `dailyLimitResetAt` in that same component.
  //
  // WHY NOTHING IS DELETED. The keys stay in 20 locale dictionaries and the
  // entries stay here: removing them is a 20-locale pass for something no user
  // can see, and this is one gate change away from mattering again. The comment
  // exists so the next person does not write, translate and review new copy for
  // an invisible string — which nearly happened during free-tier-v2 for
  // `sync.noTopics` and `sync.dailyLimitReached`. If you need one of these
  // visible, fix the `isSyncActive` gate; do not rewrite the copy and assume it
  // shipped.
  const headlineMap: Record<SyncErrorCode, string> = {
    offline:               'sync.waitingForConnection',
    'server-unreachable':  'sync.serverUnavailable',
    'auth-expired':        'sync.sessionExpired',
    'no-topics-configured': 'sync.noTopics',
    'daily-limit':         'sync.dailyLimitReached',
    'storage-error':       'sync.storageFull',
    'scoring-unavailable': 'sync.syncFailed',
    // Present only to satisfy exhaustiveness. FeedSyncMachine routes this code
    // to a quiet `idle` and never reaches publishSyncError with it — Mera
    // News Free must not paint red sync chrome.
    'not-subscribed':      '',
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
  // FIRST, above the `instanceof Error` guard and above every substring
  // heuristic below. Apollo v4's CombinedGraphQLErrors IS an Error subclass, so
  // a 402 falls straight into that block, and its message routinely contains
  // "session" or "fetch" — it would be misfiled as auth-expired or
  // server-unreachable and painted as a red sync failure, which is the exact
  // outcome Mera News Free exists to avoid.
  if (isNotSubscribedError(err)) return 'not-subscribed';

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
