// publishSyncStatus / publishSyncError / classifyError through the real for-you store: what a
// reader's header can read back (`syncStatusMessage`), and which error code each fault maps to.
// Replaces lib/scheduler/feed-sync/__tests__/feed-sync-status.test.ts (mock of the store's setter).
import { classifyError, publishSyncError, publishSyncStatus } from '@/lib/scheduler/feed-sync/feed-sync-status';
import { InvalidTransitionError, type FeedSyncState, type SyncErrorCode } from '@/lib/scheduler/feed-sync/feed-sync-types';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { resetFeedSyncMemory } from '../steps/support';

beforeEach(resetFeedSyncMemory);

const message = () => useForYouStore.getState().syncStatusMessage;

describe('publishSyncStatus', () => {
  it('starts with no message, and idle clears one that is showing', () => {
    expect(message()).toBeNull();
    publishSyncStatus('hydrating');
    expect(message()).not.toBeNull();

    publishSyncStatus('idle');

    expect(message()).toBeNull();
  });

  it.each<[FeedSyncState, string, boolean]>([
    ['fetching-topic-ids', 'sync.fetchingTopics', false],
    ['diffing', 'sync.checkingForUpdates', false],
    ['hydrating', 'sync.downloadingArticles', false],
    ['persisting', 'sync.savingArticles', false],
    ['scoring', 'sync.analyzingRelevance', false],
    ['done', 'sync.upToDate', true],
    ['paused-offline', 'sync.waitingForConnection', true],
    ['failed', 'sync.syncFailed', false],
  ])('publishes %s with headline %s and isRecoverable %s', (state, headlineKey, isRecoverable) => {
    publishSyncStatus(state);

    expect(message()).toEqual({ state, headlineKey, isRecoverable });
  });

  it('merges overrides into the message: progress while hydrating, the frozen segment while paused', () => {
    publishSyncStatus('hydrating', { progress: { current: 5, total: 10 } });
    expect(message()).toEqual(
      expect.objectContaining({ state: 'hydrating', headlineKey: 'sync.downloadingArticles', progress: { current: 5, total: 10 } }),
    );

    publishSyncStatus('paused-offline', { pausedAtState: 'fetching-topic-ids' });
    expect(message()).toEqual(expect.objectContaining({ state: 'paused-offline', pausedAtState: 'fetching-topic-ids' }));
  });

  it('replaces the previous message whole: nothing of the last one survives', () => {
    publishSyncStatus('hydrating', { progress: { current: 5, total: 10 } });

    publishSyncStatus('scoring');

    expect(message()).toEqual({ state: 'scoring', headlineKey: 'sync.analyzingRelevance', isRecoverable: false });
  });
});

describe('publishSyncError', () => {
  it.each<[SyncErrorCode, string, boolean]>([
    ['offline', 'sync.waitingForConnection', true],
    ['server-unreachable', 'sync.serverUnavailable', true],
    ['auth-expired', 'sync.sessionExpired', false],
    ['no-topics-configured', 'sync.noTopics', false],
    ['daily-limit', 'sync.dailyLimitReached', false],
    ['storage-error', 'sync.storageFull', false],
    ['scoring-unavailable', 'sync.syncFailed', false],
    ['unknown', 'sync.syncFailed', false],
  ])('%s publishes headline %s, recoverable %s, and the code', (errorCode, headlineKey, isRecoverable) => {
    publishSyncError(errorCode);

    expect(message()).toEqual({
      state: 'failed',
      headlineKey,
      errorCode,
      isRecoverable,
      retryAt: undefined,
      failedAtState: undefined,
    });
  });

  // KNOWN DEAD RENDER PATH (owned by feed at the render gate; not a ledger entry here). Every code
  // is published as `state: 'failed'`, and the only live render of `headlineKey` is gated on
  // `isSyncActive`, which excludes 'failed'. Pinned as a fact so the day the gate is fixed, this is
  // the line that changes.
  it('publishes EVERY code as state failed, so no error headline can render today', () => {
    const codes: SyncErrorCode[] = [
      'offline',
      'server-unreachable',
      'auth-expired',
      'no-topics-configured',
      'daily-limit',
      'storage-error',
      'scoring-unavailable',
      'unknown',
    ];
    for (const code of codes) {
      publishSyncError(code);
      expect(message()?.state).toBe('failed');
    }
  });

  it('falls back to the generic failure headline for a code it has no headline for', () => {
    publishSyncError('not-a-code' as SyncErrorCode);

    expect(message()).toEqual(expect.objectContaining({ errorCode: 'not-a-code', headlineKey: 'sync.syncFailed', isRecoverable: false }));
  });

  it('carries the daily-limit reset time as retryAt', () => {
    publishSyncError('daily-limit', 1781827200000);

    expect(message()).toEqual(expect.objectContaining({ errorCode: 'daily-limit', retryAt: 1781827200000 }));
  });

  it('carries retryAt and the state the machine failed at', () => {
    publishSyncError('offline', 12345, 'hydrating');

    expect(message()).toEqual(expect.objectContaining({ retryAt: 12345, failedAtState: 'hydrating' }));
  });
});

describe('classifyError', () => {
  it.each<[string, unknown, SyncErrorCode]>([
    ['a string', 'some string', 'unknown'],
    ['null', null, 'unknown'],
    ['a plain object', { foo: 'bar' }, 'unknown'],
    ['a generic Error', new Error('some completely unrelated error'), 'unknown'],
    ['the no-topics message', new Error('no-topics-configured'), 'no-topics-configured'],
    ['a message containing no-topics-configured', new Error('Error: no-topics-configured for user'), 'no-topics-configured'],
    ['code no-topics-configured', Object.assign(new Error('some error'), { code: 'no-topics-configured' }), 'no-topics-configured'],
    ['code daily-limit', Object.assign(new Error('daily-limit'), { code: 'daily-limit' }), 'daily-limit'],
    ['the daily-limit message', new Error('daily-limit'), 'daily-limit'],
    ['a network message', new Error('network request failed'), 'server-unreachable'],
    ['a fetch message', new Error('fetch failed'), 'server-unreachable'],
    ['a timeout message', new Error('request timeout'), 'server-unreachable'],
    ['an upper-case Network message', new Error('Network Error'), 'server-unreachable'],
    ['an unauthenticated message', new Error('unauthenticated user'), 'auth-expired'],
    ['a 401 message', new Error('401 Unauthorized'), 'auth-expired'],
    ['a session message', new Error('session expired'), 'auth-expired'],
    ['a storage message', new Error('storage quota exceeded'), 'storage-error'],
    ['a disk message', new Error('disk full'), 'storage-error'],
    ['code no-push-token', Object.assign(new Error('some error'), { code: 'no-push-token' }), 'scoring-unavailable'],
  ])('maps %s to %s', (_label, error, code) => {
    expect(classifyError(error)).toBe(code);
  });

  // The message embeds STATE NAMES and 'fetching-topic-ids' contains 'fetch': before the type check
  // sat above the substring heuristics, an internal fault was shown as "can't reach the server".
  it.each<[FeedSyncState, FeedSyncState]>([
    ['fetching-topic-ids', 'scoring'],
    ['paused-offline', 'hydrating'],
    ['idle', 'fetching-topic-ids'],
  ])('classifies an invalid transition %s -> %s as unknown, never server-unreachable', (from, to) => {
    expect(classifyError(new InvalidTransitionError(from, to))).toBe('unknown');
  });
});
