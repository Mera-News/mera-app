// feed-sync-status.test.ts — tests for feed-sync-status helpers

const mockSetSyncStatusMessage = jest.fn();

jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: {
    getState: jest.fn(() => ({
      setSyncStatusMessage: mockSetSyncStatusMessage,
    })),
  },
}));

import {
  publishSyncStatus,
  publishSyncError,
  classifyError,
} from '../feed-sync-status';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('publishSyncStatus', () => {
  it('calls setSyncStatusMessage(null) when state is idle', () => {
    publishSyncStatus('idle');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(null);
  });

  it('publishes fetching-topic-ids message with correct headlineKey', () => {
    publishSyncStatus('fetching-topic-ids');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'fetching-topic-ids',
        headlineKey: 'sync.fetchingTopics',
        isRecoverable: false,
      }),
    );
  });

  it('publishes diffing message', () => {
    publishSyncStatus('diffing');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'diffing',
        headlineKey: 'sync.checkingForUpdates',
      }),
    );
  });

  it('publishes hydrating message', () => {
    publishSyncStatus('hydrating');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'hydrating',
        headlineKey: 'sync.downloadingArticles',
      }),
    );
  });

  it('publishes persisting message', () => {
    publishSyncStatus('persisting');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'persisting',
        headlineKey: 'sync.savingArticles',
      }),
    );
  });

  it('publishes scoring message', () => {
    publishSyncStatus('scoring');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'scoring',
        headlineKey: 'sync.analyzingRelevance',
      }),
    );
  });

  it('publishes done message with isRecoverable=true', () => {
    publishSyncStatus('done');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'done',
        headlineKey: 'sync.upToDate',
        isRecoverable: true,
      }),
    );
  });

  it('publishes paused-offline message with isRecoverable=true', () => {
    publishSyncStatus('paused-offline');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'paused-offline',
        headlineKey: 'sync.waitingForConnection',
        isRecoverable: true,
      }),
    );
  });

  it('publishes failed message with isRecoverable=false', () => {
    publishSyncStatus('failed');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'failed',
        headlineKey: 'sync.syncFailed',
        isRecoverable: false,
      }),
    );
  });

  it('merges overrides into the message', () => {
    publishSyncStatus('hydrating', { progress: { current: 5, total: 10 } });
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'hydrating',
        progress: { current: 5, total: 10 },
      }),
    );
  });

  it('sets pausedAtState override for paused-offline', () => {
    publishSyncStatus('paused-offline', { pausedAtState: 'fetching-topic-ids' });
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        pausedAtState: 'fetching-topic-ids',
      }),
    );
  });
});

describe('publishSyncError', () => {
  it('publishes offline error with isRecoverable=true', () => {
    publishSyncError('offline');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'failed',
        errorCode: 'offline',
        isRecoverable: true,
        headlineKey: 'sync.waitingForConnection',
      }),
    );
  });

  it('publishes server-unreachable error with isRecoverable=true', () => {
    publishSyncError('server-unreachable');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'server-unreachable',
        isRecoverable: true,
        headlineKey: 'sync.serverUnavailable',
      }),
    );
  });

  it('publishes auth-expired error with isRecoverable=false', () => {
    publishSyncError('auth-expired');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'auth-expired',
        isRecoverable: false,
        headlineKey: 'sync.sessionExpired',
      }),
    );
  });

  it('publishes no-topics-configured error', () => {
    publishSyncError('no-topics-configured');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'no-topics-configured',
        headlineKey: 'sync.noTopics',
        isRecoverable: false,
      }),
    );
  });

  it('publishes storage-error', () => {
    publishSyncError('storage-error');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'storage-error',
        headlineKey: 'sync.storageFull',
        isRecoverable: false,
      }),
    );
  });

  it('publishes scoring-unavailable error', () => {
    publishSyncError('scoring-unavailable');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'scoring-unavailable',
        headlineKey: 'sync.syncFailed',
        isRecoverable: false,
      }),
    );
  });

  it('publishes unknown error', () => {
    publishSyncError('unknown');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'unknown',
        headlineKey: 'sync.syncFailed',
        isRecoverable: false,
      }),
    );
  });

  it('includes retryAt when provided', () => {
    publishSyncError('offline', 12345);
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({ retryAt: 12345 }),
    );
  });

  it('includes failedAtState when provided', () => {
    publishSyncError('unknown', undefined, 'hydrating');
    expect(mockSetSyncStatusMessage).toHaveBeenCalledWith(
      expect.objectContaining({ failedAtState: 'hydrating' }),
    );
  });
});

describe('classifyError', () => {
  it('returns unknown for non-Error value (string)', () => {
    expect(classifyError('some string')).toBe('unknown');
  });

  it('returns unknown for non-Error value (null)', () => {
    expect(classifyError(null)).toBe('unknown');
  });

  it('returns unknown for non-Error value (object)', () => {
    expect(classifyError({ foo: 'bar' })).toBe('unknown');
  });

  it('returns no-topics-configured for matching message', () => {
    expect(classifyError(new Error('no-topics-configured'))).toBe('no-topics-configured');
  });

  it('returns no-topics-configured when message includes no-topics-configured', () => {
    expect(classifyError(new Error('Error: no-topics-configured for user'))).toBe('no-topics-configured');
  });

  it('returns server-unreachable for network error message', () => {
    expect(classifyError(new Error('network request failed'))).toBe('server-unreachable');
  });

  it('returns server-unreachable for fetch error message', () => {
    expect(classifyError(new Error('fetch failed'))).toBe('server-unreachable');
  });

  it('returns server-unreachable for timeout error message', () => {
    expect(classifyError(new Error('request timeout'))).toBe('server-unreachable');
  });

  it('returns auth-expired for unauthenticated error message', () => {
    expect(classifyError(new Error('unauthenticated user'))).toBe('auth-expired');
  });

  it('returns auth-expired for 401 error message', () => {
    expect(classifyError(new Error('401 Unauthorized'))).toBe('auth-expired');
  });

  it('returns auth-expired for session error message', () => {
    expect(classifyError(new Error('session expired'))).toBe('auth-expired');
  });

  it('returns storage-error for storage error message', () => {
    expect(classifyError(new Error('storage quota exceeded'))).toBe('storage-error');
  });

  it('returns storage-error for disk error message', () => {
    expect(classifyError(new Error('disk full'))).toBe('storage-error');
  });

  it('returns no-topics-configured when err.code is no-topics-configured', () => {
    const err = Object.assign(new Error('some error'), { code: 'no-topics-configured' });
    expect(classifyError(err)).toBe('no-topics-configured');
  });

  it('returns scoring-unavailable when err.code is no-push-token', () => {
    const err = Object.assign(new Error('some error'), { code: 'no-push-token' });
    expect(classifyError(err)).toBe('scoring-unavailable');
  });

  it('returns unknown for generic error with no matching patterns', () => {
    expect(classifyError(new Error('some completely unrelated error'))).toBe('unknown');
  });

  it('message matching is case-insensitive (Network uppercase)', () => {
    expect(classifyError(new Error('Network Error'))).toBe('server-unreachable');
  });
});

export {};
