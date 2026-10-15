import type { FeedSyncState, SyncErrorCode } from '@/lib/scheduler/feed-sync/feed-sync-types';
import { cardState, hasIssue, joinClauses, MARK_MAX, MARK_MIN, markSizeFor, markTone, readHoldSentenceKey, syncFailureKey, type CardStateInput, type SyncFailure } from '@/components/custom/for-you/card-state';

const base: CardStateInput = {
  mode: 'idle',
  noFacts: false,
  offline: false,
  articleCount: 120,
  analysedCount: 40,
  relevantCount: 6,
  syncFailure: null,
};

const failed = (failedAtState?: FeedSyncState, errorCode?: SyncErrorCode): SyncFailure => ({ kind: 'failed', failedAtState, errorCode });

describe('cardState', () => {
  it('says nothing special when every count is there', () => {
    expect(cardState(base)).toBeNull();
  });

  it('names the first zero', () => {
    expect(cardState({ ...base, articleCount: 0, analysedCount: 0, relevantCount: 0 })).toBe('fetched');
    expect(cardState({ ...base, analysedCount: 0, relevantCount: 0 })).toBe('analysed');
    expect(cardState({ ...base, relevantCount: 0 })).toBe('relevant');
  });

  it('never says "couldn\'t analyse" while articles wait to be', () => {
    expect(cardState({ ...base, mode: 'deferred', analysedCount: 0, relevantCount: 0 })).toBeNull();
    expect(cardState({ ...base, mode: 'deferred', relevantCount: 0 })).toBe('relevant');
  });

  it('leads with the daily limit and the error over everything', () => {
    expect(cardState({ ...base, mode: 'limited' })).toBe('limited');
    expect(cardState({ ...base, mode: 'limited', articleCount: 0, offline: true, noFacts: true })).toBe('limited');
    expect(cardState({ ...base, mode: 'error' })).toBe('error');
    expect(cardState({ ...base, mode: 'error', relevantCount: 0, offline: true })).toBe('error');
  });

  it('stays out of runs and the no-facts card', () => {
    expect(cardState({ ...base, mode: 'processing', articleCount: 0 })).toBeNull();
    expect(cardState({ ...base, noFacts: true, articleCount: 0 })).toBeNull();
  });

  it('blames the connection when offline', () => {
    expect(cardState({ ...base, offline: true, articleCount: 0 })).toBe('offline');
    expect(cardState({ ...base, offline: true })).toBeNull();
  });
});

describe('syncFailureKey', () => {
  it.each([
    [failed('idle', 'unknown'), 'feed.syncFailed.start'],
    [failed(undefined, 'unknown'), 'feed.syncFailed.start'],
    [failed('fetching-topic-ids', 'server-unreachable'), 'feed.syncFailed.fetch'],
    [failed('diffing', 'unknown'), 'feed.syncFailed.check'],
    [failed('hydrating', 'server-unreachable'), 'feed.syncFailed.download'],
    [failed('persisting', 'unknown'), 'feed.syncFailed.download'],
    [failed('scoring', 'scoring-unavailable'), 'feed.syncFailed.score'],
    [failed('hydrating', 'storage-error'), 'feed.syncFailed.storage'],
    [failed('scoring', 'storage-error'), 'feed.syncFailed.storage'],
    [failed('fetching-topic-ids', 'storage-error'), 'feed.syncFailed.fetch'],
    [failed('diffing', 'auth-expired'), 'feed.syncFailed.session'],
    [failed('hydrating', 'offline'), 'common.offlineBannerOffline'],
    [{ kind: 'paused-offline' } as SyncFailure, 'common.offlineBannerOffline'],
    [failed('fetching-topic-ids', 'unknown'), 'feed.syncFailed.fetch'],
    [failed('idle', 'no-topics-configured'), null],
    [null, null],
  ])('%j -> %s', (f, key) => {
    expect(syncFailureKey(f)).toBe(key);
  });
});

describe('cardState with a failed refresh', () => {
  const syncFailure = failed('hydrating', 'server-unreachable');
  it('beats the counts and the zero states', () => {
    expect(cardState({ ...base, syncFailure })).toBe('syncFailed');
    expect(cardState({ ...base, articleCount: 0, analysedCount: 0, relevantCount: 0, offline: true, syncFailure })).toBe('syncFailed');
    expect(cardState({ ...base, mode: 'processing', syncFailure })).toBe('syncFailed');
  });
  it('loses to the limit and the error', () => {
    expect(cardState({ ...base, mode: 'limited', syncFailure })).toBe('limited');
    expect(cardState({ ...base, mode: 'error', syncFailure })).toBe('error');
  });
  it('stays out when another surface owns the failure', () => {
    expect(cardState({ ...base, syncFailure: failed('idle', 'unknown') })).toBe('syncFailed');
  });
  it('is an alert', () => {
    expect(markTone('syncFailed')).toBe('alert');
  });
});

describe('markSizeFor', () => {
  it('is the sentence block less 4pt, at 90%, in 0.5pt steps', () => {
    expect(markSizeFor(40)).toBe(32.5);
    expect(markSizeFor(44)).toBe(36);
  });
  it('never shrinks below the one-line size nor grows past the column', () => {
    expect(markSizeFor(0)).toBe(MARK_MIN);
    expect(markSizeFor(20)).toBe(MARK_MIN);
    expect(markSizeFor(60)).toBe(MARK_MAX);
    expect(markSizeFor(200)).toBe(MARK_MAX);
  });
});

describe('markTone', () => {
  it('is orange only when Mera is stuck', () => {
    for (const s of ['fetched', 'limited', 'analysed', 'error'] as const) expect(markTone(s)).toBe('alert');
  });
  it('keeps the ink everywhere else', () => {
    for (const s of ['relevant', 'offline', null] as const) expect(markTone(s)).toBe('normal');
  });
});

describe('joinClauses', () => {
  const parts = ['公開されました。', 'ただ、分析できませんでした。'];
  it('joins Japanese and Chinese with no space after their punctuation', () => {
    expect(joinClauses(parts, 'ja')).toBe('公開されました。ただ、分析できませんでした。');
    expect(joinClauses(['已发布，', '但尚未分析。'], 'zh-CN')).toBe('已发布，但尚未分析。');
    expect(joinClauses(['已發布，', '但尚未分析。'], 'zh-TW')).toBe('已發布，但尚未分析。');
  });
  it('joins every other language with one space', () => {
    expect(joinClauses(['5 articles were published,', '3 were analysed.'], 'en')).toBe(
      '5 articles were published, 3 were analysed.',
    );
    expect(joinClauses(['a', 'b'], 'th')).toBe('a b');
    expect(joinClauses(['a', 'b'], undefined)).toBe('a b');
  });
});

describe('hasIssue', () => {
  const failedAt = (failedAtState: FeedSyncState, errorCode?: SyncErrorCode): SyncFailure => ({ kind: 'failed', failedAtState, errorCode });
  it.each([
    ['idle, no failure', 'idle', null, false],
    ['limited', 'limited', null, true],
    ['error', 'error', null, true],
    ['failed at hydrating', 'idle', failedAt('hydrating', 'server-unreachable'), true],
    ['paused offline', 'idle', { kind: 'paused-offline' }, true],
    ['unknown failure, idle', 'idle', failedAt('fetching-topic-ids', 'unknown'), true],
    ['no-topics-configured failure, idle', 'idle', failedAt('fetching-topic-ids', 'no-topics-configured'), false],
  ] as const)('%s', (_name, mode, failure, expected) => {
    expect(hasIssue(mode, failure)).toBe(expected);
  });
});

describe('readHoldSentenceKey', () => {
  it('names the unread articles only when some are known to wait', () => {
    expect(readHoldSentenceKey('today', 4)).toBe('feed.readHold.waitingToday');
    expect(readHoldSentenceKey('tomorrow', 1)).toBe('feed.readHold.waitingTomorrow');
  });

  it('falls back to the count-less sentence for zero or unknown', () => {
    expect(readHoldSentenceKey('today', null)).toBe('feed.readHold.bodyToday');
    expect(readHoldSentenceKey('tomorrow', 0)).toBe('feed.readHold.bodyTomorrow');
  });
});
