// async-job-service unit tests
// Mocks: setting-service (WatermelonDB), expo-secure-store, logger

const mockGetSetting = jest.fn((..._args: any[]): Promise<string | null> => Promise.resolve(null));
const mockSetSetting = jest.fn((..._args: any[]): Promise<void> => Promise.resolve());
const mockDeleteSetting = jest.fn((..._args: any[]): Promise<void> => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  setSetting: (...args: unknown[]) => mockSetSetting(...args),
  deleteSetting: (...args: unknown[]) => mockDeleteSetting(...args),
}));

const mockSecureStoreGetItem = jest.fn((..._args: any[]): Promise<string | null> => Promise.resolve(null));
const mockSecureStoreSetItem = jest.fn((..._args: any[]): Promise<void> => Promise.resolve());
const mockSecureStoreDeleteItem = jest.fn((..._args: any[]): Promise<void> => Promise.resolve());

jest.mock('@/lib/utils/secure-store-adapter', () => ({
  secureStore: {
    getItemAsync: (...args: unknown[]) => mockSecureStoreGetItem(...args),
    setItemAsync: (...args: unknown[]) => mockSecureStoreSetItem(...args),
    deleteItemAsync: (...args: unknown[]) => mockSecureStoreDeleteItem(...args),
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn() },
}));

import {
  getCycleState,
  setCycleState,
  getNotifDispatchedFor,
  setNotifDispatchedFor,
  getPendingAsyncJob,
  setPendingAsyncJob,
  clearPendingAsyncJob,
  getLastNudgeAt,
  setLastNudgeAt,
  PendingJobStaleError,
} from '../async-job-service';
import type { PendingAsyncJob, InferenceCycleState } from '../async-job-service';
import logger from '@/lib/logger';

function makePendingJob(overrides: Partial<PendingAsyncJob> = {}): PendingAsyncJob {
  return {
    requestId: 'req-123',
    phase: 'relevance',
    candidateIds: ['c1', 'c2'],
    callIds: ['score:0'],
    submittedAt: 1700000000000,
    expoPushToken: 'ExpoPushToken[xxx]',
    modelCalls: 1,
    clientPrivKeyHex: 'aabbccdd',
    idempotencyKey: 'key-abc',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getCycleState
// ---------------------------------------------------------------------------

describe('getCycleState', () => {
  it('returns idle when no setting exists', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    const result = await getCycleState();
    expect(result).toBe('idle');
  });

  it('returns the stored cycle state', async () => {
    mockGetSetting.mockResolvedValueOnce('submitting-relevance');
    const result = await getCycleState();
    expect(result as InferenceCycleState).toBe('submitting-relevance');
  });

  it('calls getSetting with the correct key', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    await getCycleState();
    expect(mockGetSetting).toHaveBeenCalledWith('inference_cycle_state');
  });
});

// ---------------------------------------------------------------------------
// setCycleState
// ---------------------------------------------------------------------------

describe('setCycleState', () => {
  it('calls setSetting with the correct key and value', async () => {
    await setCycleState('waiting-for-relevance');
    expect(mockSetSetting).toHaveBeenCalledWith(
      'inference_cycle_state',
      'waiting-for-relevance',
    );
  });
});

// ---------------------------------------------------------------------------
// getNotifDispatchedFor
// ---------------------------------------------------------------------------

describe('getNotifDispatchedFor', () => {
  it('returns null when no setting exists', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    const result = await getNotifDispatchedFor();
    expect(result).toBeNull();
  });

  it('returns the stored idempotency key', async () => {
    mockGetSetting.mockResolvedValueOnce('some-idempotency-key');
    const result = await getNotifDispatchedFor();
    expect(result).toBe('some-idempotency-key');
  });
});

// ---------------------------------------------------------------------------
// setNotifDispatchedFor
// ---------------------------------------------------------------------------

describe('setNotifDispatchedFor', () => {
  it('calls setSetting with the correct key', async () => {
    await setNotifDispatchedFor('my-key');
    expect(mockSetSetting).toHaveBeenCalledWith(
      'inference_cycle_notif_dispatched_for',
      'my-key',
    );
  });
});

// ---------------------------------------------------------------------------
// getPendingAsyncJob
// ---------------------------------------------------------------------------

describe('getPendingAsyncJob', () => {
  it('returns null when no pending job exists', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    const result = await getPendingAsyncJob();
    expect(result).toBeNull();
  });

  it('returns null and deletes stale row when inline clientPrivKeyHex is present (legacy)', async () => {
    const legacyJob = {
      requestId: 'req-1',
      phase: 'reasons',
      candidateIds: [],
      callIds: ['reason:x'],
      submittedAt: 1234,
      expoPushToken: null,
      modelCalls: 1,
      clientPrivKeyHex: 'inline-secret-should-not-be-here',
    };
    mockGetSetting.mockResolvedValueOnce(JSON.stringify(legacyJob));
    const result = await getPendingAsyncJob();
    expect(result).toBeNull();
    expect(mockDeleteSetting).toHaveBeenCalledWith('async_inference_pending_job');
    expect(mockSecureStoreDeleteItem).toHaveBeenCalledWith('async_inference_pending_job_privkey');
  });

  it('migrates legacy calls[] format to callIds[] on read', async () => {
    const legacyJob = {
      requestId: 'req-2',
      phase: 'relevance',
      candidateIds: ['c1'],
      calls: [{ id: 'score:0' }, { id: 'score:1' }],
      submittedAt: 1234,
      expoPushToken: null,
      modelCalls: 1,
      // No clientPrivKeyHex in top-level (new-style secret location)
    };
    mockGetSetting.mockResolvedValueOnce(JSON.stringify(legacyJob));
    // Secure store returns the key
    mockSecureStoreGetItem.mockResolvedValueOnce('secret-hex-key');

    const result = await getPendingAsyncJob();
    expect(result).not.toBeNull();
    expect(result!.callIds).toEqual(['score:0', 'score:1']);
    expect(result!.clientPrivKeyHex).toBe('secret-hex-key');
  });

  it('returns null and clears both stores when privkey is missing', async () => {
    const job = {
      requestId: 'req-3',
      phase: 'relevance',
      candidateIds: [],
      callIds: [],
      submittedAt: 1234,
      expoPushToken: null,
      modelCalls: 1,
    };
    mockGetSetting.mockResolvedValueOnce(JSON.stringify(job));
    mockSecureStoreGetItem.mockResolvedValueOnce(null); // missing key

    const result = await getPendingAsyncJob();
    expect(result).toBeNull();
    expect(mockDeleteSetting).toHaveBeenCalledWith('async_inference_pending_job');
    expect(mockSecureStoreDeleteItem).toHaveBeenCalledWith('async_inference_pending_job_privkey');
  });

  it('returns the full job with privkey merged in from secure store', async () => {
    const job = {
      requestId: 'req-ok',
      phase: 'relevance',
      candidateIds: ['c1'],
      callIds: ['score:0'],
      submittedAt: 1700000000000,
      expoPushToken: 'token',
      modelCalls: 1,
      idempotencyKey: 'idem-1',
    };
    mockGetSetting.mockResolvedValueOnce(JSON.stringify(job));
    mockSecureStoreGetItem.mockResolvedValueOnce('privkey-hex');

    const result = await getPendingAsyncJob();
    expect(result).not.toBeNull();
    expect(result!.requestId).toBe('req-ok');
    expect(result!.clientPrivKeyHex).toBe('privkey-hex');
  });

  it('returns null and clears row when JSON is invalid', async () => {
    mockGetSetting.mockResolvedValueOnce('not valid json {{{');
    const result = await getPendingAsyncJob();
    expect(result).toBeNull();
    expect(logger.captureException).toHaveBeenCalledTimes(1);
    expect(mockDeleteSetting).toHaveBeenCalledWith('async_inference_pending_job');
  });

  it('captures exception when deleteSetting rejects during legacy-key cleanup', async () => {
    const legacyJob = {
      requestId: 'req-legacy-err',
      phase: 'relevance',
      candidateIds: [],
      callIds: [],
      submittedAt: 1234,
      expoPushToken: null,
      modelCalls: 1,
      clientPrivKeyHex: 'inline-secret',
    };
    mockGetSetting.mockResolvedValueOnce(JSON.stringify(legacyJob));
    mockDeleteSetting.mockRejectedValueOnce(new Error('deleteSetting failed'));
    mockSecureStoreDeleteItem.mockRejectedValueOnce(new Error('deleteItemAsync failed'));
    const result = await getPendingAsyncJob();
    expect(result).toBeNull();
    // Both errors should be captured; order depends on Promise execution
    expect(logger.captureException).toHaveBeenCalled();
  });

  it('captures exception when deleteSetting rejects during missing-privkey cleanup', async () => {
    const job = {
      requestId: 'req-missing-key',
      phase: 'relevance',
      candidateIds: [],
      callIds: [],
      submittedAt: 1234,
      expoPushToken: null,
      modelCalls: 1,
    };
    mockGetSetting.mockResolvedValueOnce(JSON.stringify(job));
    mockSecureStoreGetItem.mockResolvedValueOnce(null); // privkey missing
    mockDeleteSetting.mockRejectedValueOnce(new Error('cleanup failed'));
    mockSecureStoreDeleteItem.mockRejectedValueOnce(new Error('cleanup failed 2'));
    const result = await getPendingAsyncJob();
    expect(result).toBeNull();
    expect(logger.captureException).toHaveBeenCalled();
  });

  it('captures exception when deleteSetting rejects during corrupted-JSON cleanup', async () => {
    mockGetSetting.mockResolvedValueOnce('{invalid json}}}');
    mockDeleteSetting.mockRejectedValueOnce(new Error('delete failed'));
    mockSecureStoreDeleteItem.mockRejectedValueOnce(new Error('secure delete failed'));
    const result = await getPendingAsyncJob();
    expect(result).toBeNull();
    // captureException called at least once for the JSON parse error, plus cleanup errors
    expect(logger.captureException).toHaveBeenCalled();
  });

  it('returns null when secure store throws (transient keychain error)', async () => {
    const job = {
      requestId: 'req-transient',
      phase: 'relevance',
      candidateIds: [],
      callIds: [],
      submittedAt: 1234,
      expoPushToken: null,
      modelCalls: 1,
    };
    mockGetSetting.mockResolvedValueOnce(JSON.stringify(job));
    mockSecureStoreGetItem.mockRejectedValueOnce(new Error('keychain locked'));

    const result = await getPendingAsyncJob();
    expect(result).toBeNull();
    // Should NOT clear the setting — want to retry on next foreground
    expect(mockDeleteSetting).not.toHaveBeenCalled();
    expect(logger.captureException).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// setPendingAsyncJob
// ---------------------------------------------------------------------------

describe('setPendingAsyncJob', () => {
  it('writes privkey to secure store and metadata to settings', async () => {
    const job = makePendingJob({ clientPrivKeyHex: 'my-priv-key' });
    await setPendingAsyncJob(job);

    expect(mockSecureStoreSetItem).toHaveBeenCalledWith(
      'async_inference_pending_job_privkey',
      'my-priv-key',
    );
    expect(mockSetSetting).toHaveBeenCalledWith(
      'async_inference_pending_job',
      expect.any(String),
    );
    // clientPrivKeyHex must NOT appear in the stored JSON
    const storedJson = mockSetSetting.mock.calls[0][1] as string;
    expect(storedJson).not.toContain('my-priv-key');
  });

  it('omits clientPrivKeyHex from the persisted JSON', async () => {
    const job = makePendingJob({ clientPrivKeyHex: 'secret' });
    await setPendingAsyncJob(job);
    const storedJson = mockSetSetting.mock.calls[0][1] as string;
    const parsed = JSON.parse(storedJson);
    expect(parsed.clientPrivKeyHex).toBeUndefined();
  });

  it('CAS: throws PendingJobStaleError when existing requestId differs', async () => {
    // getPendingAsyncJob will read setting → returns existing job with different requestId
    const existingJob = {
      requestId: 'req-existing',
      phase: 'relevance',
      candidateIds: [],
      callIds: [],
      submittedAt: 1234,
      expoPushToken: null,
      modelCalls: 1,
    };
    mockGetSetting.mockResolvedValueOnce(JSON.stringify(existingJob));
    mockSecureStoreGetItem.mockResolvedValueOnce('some-key');

    const job = makePendingJob({ requestId: 'req-new' });
    await expect(
      setPendingAsyncJob(job, { expectedRequestId: 'req-different' }),
    ).rejects.toThrow(PendingJobStaleError);
  });

  it('CAS: succeeds when expectedRequestId matches current requestId', async () => {
    const existingJob = {
      requestId: 'req-match',
      phase: 'relevance',
      candidateIds: [],
      callIds: [],
      submittedAt: 1234,
      expoPushToken: null,
      modelCalls: 1,
    };
    mockGetSetting.mockResolvedValueOnce(JSON.stringify(existingJob));
    mockSecureStoreGetItem.mockResolvedValueOnce('some-key');

    const job = makePendingJob({ requestId: 'req-match', clientPrivKeyHex: 'newkey' });
    await expect(
      setPendingAsyncJob(job, { expectedRequestId: 'req-match' }),
    ).resolves.toBeUndefined();
    expect(mockSecureStoreSetItem).toHaveBeenCalledWith(
      'async_inference_pending_job_privkey',
      'newkey',
    );
  });

  it('CAS: throws PendingJobStaleError when expectedRequestId is null but a job exists', async () => {
    const existingJob = {
      requestId: 'req-already-here',
      phase: 'relevance',
      candidateIds: [],
      callIds: [],
      submittedAt: 1234,
      expoPushToken: null,
      modelCalls: 1,
    };
    mockGetSetting.mockResolvedValueOnce(JSON.stringify(existingJob));
    mockSecureStoreGetItem.mockResolvedValueOnce('some-key');

    const job = makePendingJob();
    await expect(
      setPendingAsyncJob(job, { expectedRequestId: null }),
    ).rejects.toThrow(PendingJobStaleError);
  });

  it('CAS: succeeds when expectedRequestId is null and no job currently exists', async () => {
    mockGetSetting.mockResolvedValueOnce(null); // no existing job

    const job = makePendingJob({ clientPrivKeyHex: 'privkey' });
    await expect(
      setPendingAsyncJob(job, { expectedRequestId: null }),
    ).resolves.toBeUndefined();
    expect(mockSecureStoreSetItem).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// clearPendingAsyncJob
// ---------------------------------------------------------------------------

describe('clearPendingAsyncJob', () => {
  it('deletes setting and secure-store key unconditionally', async () => {
    await clearPendingAsyncJob();
    expect(mockDeleteSetting).toHaveBeenCalledWith('async_inference_pending_job');
    expect(mockSecureStoreDeleteItem).toHaveBeenCalledWith('async_inference_pending_job_privkey');
  });

  it('CAS: throws PendingJobStaleError when requestId does not match', async () => {
    const existingJob = {
      requestId: 'req-existing',
      phase: 'relevance',
      candidateIds: [],
      callIds: [],
      submittedAt: 1234,
      expoPushToken: null,
      modelCalls: 1,
    };
    mockGetSetting.mockResolvedValueOnce(JSON.stringify(existingJob));
    mockSecureStoreGetItem.mockResolvedValueOnce('some-key');

    await expect(
      clearPendingAsyncJob({ expectedRequestId: 'req-wrong' }),
    ).rejects.toThrow(PendingJobStaleError);
  });

  it('CAS: succeeds and clears both stores when requestId matches', async () => {
    const existingJob = {
      requestId: 'req-match',
      phase: 'relevance',
      candidateIds: [],
      callIds: [],
      submittedAt: 1234,
      expoPushToken: null,
      modelCalls: 1,
    };
    mockGetSetting.mockResolvedValueOnce(JSON.stringify(existingJob));
    mockSecureStoreGetItem.mockResolvedValueOnce('some-key');

    await clearPendingAsyncJob({ expectedRequestId: 'req-match' });
    expect(mockDeleteSetting).toHaveBeenCalledWith('async_inference_pending_job');
    expect(mockSecureStoreDeleteItem).toHaveBeenCalledWith('async_inference_pending_job_privkey');
  });

  it('swallows errors from secure store deleteItemAsync', async () => {
    mockSecureStoreDeleteItem.mockRejectedValueOnce(new Error('keychain error'));
    await expect(clearPendingAsyncJob()).resolves.toBeUndefined();
    expect(logger.captureException).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PendingJobStaleError
// ---------------------------------------------------------------------------

describe('PendingJobStaleError', () => {
  it('has the correct name and message', () => {
    const err = new PendingJobStaleError('expected-id', 'actual-id');
    expect(err.name).toBe('PendingJobStaleError');
    expect(err.message).toContain('expected=expected-id');
    expect(err.message).toContain('actual=actual-id');
    expect(err.expected).toBe('expected-id');
    expect(err.actual).toBe('actual-id');
  });

  it('formats null expected and actual as "null"', () => {
    const err = new PendingJobStaleError(null, null);
    expect(err.message).toContain('expected=null');
    expect(err.message).toContain('actual=null');
  });

  it('is an instanceof Error', () => {
    const err = new PendingJobStaleError(null, null);
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// getLastNudgeAt
// ---------------------------------------------------------------------------

describe('getLastNudgeAt', () => {
  it('returns null when no setting exists', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    const result = await getLastNudgeAt();
    expect(result).toBeNull();
  });

  it('returns the timestamp as a number', async () => {
    mockGetSetting.mockResolvedValueOnce('1700000000000');
    const result = await getLastNudgeAt();
    expect(result).toBe(1700000000000);
  });

  it('returns null for non-finite values', async () => {
    mockGetSetting.mockResolvedValueOnce('not-a-number');
    const result = await getLastNudgeAt();
    expect(result).toBeNull();
  });

  it('calls getSetting with the correct key', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    await getLastNudgeAt();
    expect(mockGetSetting).toHaveBeenCalledWith('async_inference_last_nudge');
  });
});

// ---------------------------------------------------------------------------
// setLastNudgeAt
// ---------------------------------------------------------------------------

describe('setLastNudgeAt', () => {
  it('calls setSetting with the timestamp as a string', async () => {
    await setLastNudgeAt(1700000000000);
    expect(mockSetSetting).toHaveBeenCalledWith(
      'async_inference_last_nudge',
      '1700000000000',
    );
  });
});
