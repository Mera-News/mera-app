// run-inference-handler.test.ts — unit tests for runBackgroundCycle

const mockGetPendingAsyncJob = jest.fn();
const mockSubmitInferenceJob = jest.fn();
const mockReconcileAsyncJobResults = jest.fn();
const mockSubmitOrphanedReasonJob = jest.fn();
const mockContextForCycleReason = jest.fn();
const mockCaptureException = jest.fn();
const mockWarn = jest.fn();
const mockInfo = jest.fn();

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: (...args: any[]) => mockCaptureException(...args),
    warn: (...args: any[]) => mockWarn(...args),
    info: (...args: any[]) => mockInfo(...args),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@/lib/database/services/async-job-service', () => ({
  getPendingAsyncJob: (...args: any[]) => mockGetPendingAsyncJob(...args),
}));

jest.mock('@/lib/llm/submitInferenceJob', () => ({
  submitInferenceJob: (...args: any[]) => mockSubmitInferenceJob(...args),
}));

jest.mock('@/lib/services/async-job-reconciler', () => ({
  reconcileAsyncJobResults: (...args: any[]) => mockReconcileAsyncJobResults(...args),
  submitOrphanedReasonJob: (...args: any[]) => mockSubmitOrphanedReasonJob(...args),
}));

jest.mock('@/lib/llm/execution-context', () => ({
  contextForCycleReason: (...args: any[]) => mockContextForCycleReason(...args),
}));

import { runBackgroundCycle } from '../run-inference-handler';
import type { CycleReason } from '../run-inference-handler';

function makePendingJob(overrides: Record<string, any> = {}) {
  return {
    requestId: 'req-abc',
    phase: 'relevance',
    submittedAt: Date.now() - 1000,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockContextForCycleReason.mockReturnValue('foreground');
  mockGetPendingAsyncJob.mockResolvedValue(null);
  mockSubmitInferenceJob.mockResolvedValue('submitted');
  mockReconcileAsyncJobResults.mockResolvedValue('completed');
  mockSubmitOrphanedReasonJob.mockResolvedValue('skipped-empty');
});

describe('runBackgroundCycle — phase1-done', () => {
  it('returns no-work when no pending job on phase1-done', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    const result = await runBackgroundCycle('phase1-done');
    expect(result).toBe('no-work');
    expect(mockReconcileAsyncJobResults).not.toHaveBeenCalled();
  });

  it('reconciles pending job on phase1-done and maps completed → reconciled-new-data', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(makePendingJob());
    mockReconcileAsyncJobResults.mockResolvedValue('completed');

    const result = await runBackgroundCycle('phase1-done');

    expect(result).toBe('reconciled-new-data');
    expect(mockReconcileAsyncJobResults).toHaveBeenCalledWith('foreground', 'req-abc');
  });

  it('maps pending reconcile → reconciled-pending', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(makePendingJob());
    mockReconcileAsyncJobResults.mockResolvedValue('pending');

    const result = await runBackgroundCycle('phase1-done');
    expect(result).toBe('reconciled-pending');
  });

  it('maps stale reconcile → reconciled-stale', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(makePendingJob());
    mockReconcileAsyncJobResults.mockResolvedValue('stale');

    const result = await runBackgroundCycle('phase1-done');
    expect(result).toBe('reconciled-stale');
  });

  it('maps error reconcile → error', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(makePendingJob());
    mockReconcileAsyncJobResults.mockResolvedValue('error');

    const result = await runBackgroundCycle('phase1-done');
    expect(result).toBe('error');
  });
});

describe('runBackgroundCycle — phase2-done', () => {
  it('returns no-work when no pending job on phase2-done', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    const result = await runBackgroundCycle('phase2-done');
    expect(result).toBe('no-work');
  });

  it('reconciles and maps completed → reconciled-new-data on phase2-done', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(makePendingJob());
    mockReconcileAsyncJobResults.mockResolvedValue('completed');

    const result = await runBackgroundCycle('phase2-done');
    expect(result).toBe('reconciled-new-data');
  });
});

describe('runBackgroundCycle — silent-push', () => {
  it('returns no-work when no pending job on silent-push', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    const result = await runBackgroundCycle('silent-push');
    expect(result).toBe('no-work');
    expect(mockSubmitInferenceJob).not.toHaveBeenCalled();
  });

  it('reconciles pending job on silent-push', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(makePendingJob());
    mockReconcileAsyncJobResults.mockResolvedValue('completed');

    const result = await runBackgroundCycle('silent-push');
    expect(result).toBe('reconciled-new-data');
    expect(mockSubmitInferenceJob).not.toHaveBeenCalled();
  });
});

describe('runBackgroundCycle — app-resume', () => {
  it('returns no-work when no pending job on app-resume', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    const result = await runBackgroundCycle('app-resume');
    expect(result).toBe('no-work');
    expect(mockSubmitInferenceJob).not.toHaveBeenCalled();
  });

  it('reconciles pending job on app-resume', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(makePendingJob());
    mockReconcileAsyncJobResults.mockResolvedValue('stale');

    const result = await runBackgroundCycle('app-resume');
    expect(result).toBe('reconciled-stale');
    expect(mockSubmitInferenceJob).not.toHaveBeenCalled();
  });
});

describe('runBackgroundCycle — scoring-pass (submit or reconcile)', () => {
  it('reconciles when a pending job exists', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(makePendingJob());
    mockReconcileAsyncJobResults.mockResolvedValue('completed');

    const result = await runBackgroundCycle('scoring-pass');
    expect(result).toBe('reconciled-new-data');
    expect(mockSubmitInferenceJob).not.toHaveBeenCalled();
  });

  it('submits when no pending job (submitted → submitted)', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockSubmitInferenceJob.mockResolvedValue('submitted');

    const result = await runBackgroundCycle('scoring-pass');
    expect(result).toBe('submitted');
    expect(mockSubmitInferenceJob).toHaveBeenCalled();
  });

  it('tries orphaned reason job when submitInferenceJob returns skipped-empty', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockSubmitInferenceJob.mockResolvedValue('skipped-empty');
    mockSubmitOrphanedReasonJob.mockResolvedValue('submitted');

    const result = await runBackgroundCycle('scoring-pass');
    expect(result).toBe('submitted');
    expect(mockSubmitOrphanedReasonJob).toHaveBeenCalledWith('foreground');
  });

  it('returns no-work when orphaned reason job is also skipped-empty', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockSubmitInferenceJob.mockResolvedValue('skipped-empty');
    mockSubmitOrphanedReasonJob.mockResolvedValue('skipped-empty');

    const result = await runBackgroundCycle('scoring-pass');
    expect(result).toBe('no-work');
  });

  it('returns skipped-no-token when submitInferenceJob returns skipped-no-token', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockSubmitInferenceJob.mockResolvedValue('skipped-no-token');

    const result = await runBackgroundCycle('scoring-pass');
    expect(result).toBe('skipped-no-token');
  });

  it('returns skipped-pending when submitInferenceJob returns skipped-pending', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockSubmitInferenceJob.mockResolvedValue('skipped-pending');

    const result = await runBackgroundCycle('scoring-pass');
    expect(result).toBe('skipped-pending');
  });

  it('returns skipped-pending when submitInferenceJob returns skipped-stale-pending', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockSubmitInferenceJob.mockResolvedValue('skipped-stale-pending');

    const result = await runBackgroundCycle('scoring-pass');
    expect(result).toBe('skipped-pending');
  });

  it('returns error when submitInferenceJob returns error', async () => {
    mockGetPendingAsyncJob.mockResolvedValue(null);
    mockSubmitInferenceJob.mockResolvedValue('error');

    const result = await runBackgroundCycle('scoring-pass');
    expect(result).toBe('error');
  });
});

describe('runBackgroundCycle — error handling', () => {
  it('catches exceptions and returns error', async () => {
    const err = new Error('network failure');
    mockGetPendingAsyncJob.mockRejectedValue(err);

    const result = await runBackgroundCycle('scoring-pass');

    expect(result).toBe('error');
    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ service: 'run-background-cycle', reason: 'scoring-pass' }),
      }),
    );
  });

  it('tags keychain errors with kind=keychain-unavailable', async () => {
    const keychainErr = new Error('SecItem errSecInteractionNotAllowed keychain locked');
    mockGetPendingAsyncJob.mockRejectedValue(keychainErr);

    const result = await runBackgroundCycle('silent-push');

    expect(result).toBe('error');
    expect(mockCaptureException).toHaveBeenCalledWith(
      keychainErr,
      expect.objectContaining({
        tags: expect.objectContaining({ kind: 'keychain-unavailable' }),
      }),
    );
  });

  it('tags generic errors with kind=generic', async () => {
    const genericErr = new Error('some random failure');
    mockGetPendingAsyncJob.mockRejectedValue(genericErr);

    await runBackgroundCycle('app-resume');

    expect(mockCaptureException).toHaveBeenCalledWith(
      genericErr,
      expect.objectContaining({
        tags: expect.objectContaining({ kind: 'generic' }),
      }),
    );
  });

  it('handles non-Error thrown values', async () => {
    mockGetPendingAsyncJob.mockRejectedValue('string error');

    const result = await runBackgroundCycle('phase1-done');
    expect(result).toBe('error');
    expect(mockCaptureException).toHaveBeenCalled();
  });
});

describe('runBackgroundCycle — context derivation', () => {
  it('calls contextForCycleReason with the provided reason', async () => {
    mockContextForCycleReason.mockReturnValue('background');
    mockGetPendingAsyncJob.mockResolvedValue(null);

    await runBackgroundCycle('silent-push');

    expect(mockContextForCycleReason).toHaveBeenCalledWith('silent-push');
  });

  it('uses background context for silent-push when contextForCycleReason returns background', async () => {
    mockContextForCycleReason.mockReturnValue('background');
    mockGetPendingAsyncJob.mockResolvedValue(makePendingJob());
    mockReconcileAsyncJobResults.mockResolvedValue('completed');

    await runBackgroundCycle('silent-push');

    expect(mockReconcileAsyncJobResults).toHaveBeenCalledWith('background', 'req-abc');
  });
});

export {};
