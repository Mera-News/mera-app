// cycle-state-machine.test.ts — state-machine wrapper tests

const mockGetCycleState = jest.fn();
const mockGetPendingAsyncJob = jest.fn();
const mockSetCycleState = jest.fn();
const mockReconcileAsyncJobResults = jest.fn();
const mockSetAsyncJobPhase = jest.fn();
const mockCaptureException = jest.fn();
const mockWarn = jest.fn();
const mockInfo = jest.fn();

jest.mock('@/lib/database/services/async-job-service', () => ({
  getCycleState: (...args: any[]) => mockGetCycleState(...args),
  getPendingAsyncJob: (...args: any[]) => mockGetPendingAsyncJob(...args),
  setCycleState: (...args: any[]) => mockSetCycleState(...args),
}));

jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: {
    getState: jest.fn(() => ({
      setAsyncJobPhase: mockSetAsyncJobPhase,
    })),
  },
}));

jest.mock('@/lib/services/async-job-reconciler', () => ({
  reconcileAsyncJobResults: (...args: any[]) => mockReconcileAsyncJobResults(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    warn: (...args: any[]) => mockWarn(...args),
    info: (...args: any[]) => mockInfo(...args),
    captureException: (...args: any[]) => mockCaptureException(...args),
  },
}));

import { recoverCycle } from '../cycle-state-machine';

describe('recoverCycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetCycleState.mockResolvedValue(undefined);
    mockSetAsyncJobPhase.mockReturnValue(undefined);
  });

  it('returns idle immediately when state is idle and no pending job', async () => {
    mockGetCycleState.mockResolvedValue('idle');
    mockGetPendingAsyncJob.mockResolvedValue(null);

    const result = await recoverCycle();

    expect(result).toBe('idle');
    expect(mockReconcileAsyncJobResults).not.toHaveBeenCalled();
    expect(mockSetCycleState).not.toHaveBeenCalled();
  });

  it('resets orphaned cycle state (state=non-idle, no pending job) to idle', async () => {
    mockGetCycleState.mockResolvedValue('waiting-for-reason');
    mockGetPendingAsyncJob.mockResolvedValue(null);

    const result = await recoverCycle();

    expect(result).toBe('idle');
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('orphaned cycle state'),
    );
    expect(mockSetCycleState).toHaveBeenCalledWith('idle');
    expect(mockSetAsyncJobPhase).toHaveBeenCalledWith('idle');
    expect(mockReconcileAsyncJobResults).not.toHaveBeenCalled();
  });

  it('resets any non-idle orphaned state to idle', async () => {
    for (const orphanState of ['waiting-for-relevance', 'unpacking-relevance', 'submitting-reason']) {
      jest.clearAllMocks();
      mockSetCycleState.mockResolvedValue(undefined);
      mockGetCycleState.mockResolvedValue(orphanState);
      mockGetPendingAsyncJob.mockResolvedValue(null);

      const result = await recoverCycle();

      expect(result).toBe('idle');
      expect(mockSetCycleState).toHaveBeenCalledWith('idle');
    }
  });

  it('calls reconcileAsyncJobResults when state is non-idle with a pending job', async () => {
    const pendingJob = { requestId: 'req-123', submittedAt: Date.now() };
    mockGetCycleState
      .mockResolvedValueOnce('waiting-for-reason')
      .mockResolvedValueOnce('idle');
    mockGetPendingAsyncJob.mockResolvedValue(pendingJob);
    mockReconcileAsyncJobResults.mockResolvedValue('completed');

    const result = await recoverCycle();

    expect(mockReconcileAsyncJobResults).toHaveBeenCalledWith('foreground');
    expect(result).toBe('idle');
  });

  it('logs state transition when state changes after reconcile', async () => {
    const pendingJob = { requestId: 'req-456', submittedAt: Date.now() };
    mockGetCycleState
      .mockResolvedValueOnce('waiting-for-relevance')
      .mockResolvedValueOnce('idle');
    mockGetPendingAsyncJob.mockResolvedValue(pendingJob);
    mockReconcileAsyncJobResults.mockResolvedValue('completed');

    await recoverCycle();

    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining('waiting-for-relevance'),
    );
  });

  it('returns the current state after reconcile if still non-idle (pending gateway)', async () => {
    const pendingJob = { requestId: 'req-789', submittedAt: Date.now() };
    mockGetCycleState
      .mockResolvedValueOnce('waiting-for-reason')
      .mockResolvedValueOnce('waiting-for-reason');
    mockGetPendingAsyncJob.mockResolvedValue(pendingJob);
    mockReconcileAsyncJobResults.mockResolvedValue('pending');

    const result = await recoverCycle();

    expect(result).toBe('waiting-for-reason');
  });

  it('swallows reconciler exceptions and returns the current cycle state', async () => {
    const pendingJob = { requestId: 'req-err', submittedAt: Date.now() };
    const reconcileError = new Error('reconcile failed');
    mockGetCycleState
      .mockResolvedValueOnce('waiting-for-reason')
      .mockResolvedValueOnce('waiting-for-reason');
    mockGetPendingAsyncJob.mockResolvedValue(pendingJob);
    mockReconcileAsyncJobResults.mockRejectedValue(reconcileError);

    const result = await recoverCycle();

    expect(mockCaptureException).toHaveBeenCalledWith(reconcileError, expect.objectContaining({
      tags: expect.objectContaining({ service: 'cycle-state-machine' }),
    }));
    expect(result).toBe('waiting-for-reason');
  });

  it('handles idle state with a pending job by calling reconciler', async () => {
    const pendingJob = { requestId: 'req-idle', submittedAt: Date.now() };
    mockGetCycleState
      .mockResolvedValueOnce('idle')
      .mockResolvedValueOnce('idle');
    mockGetPendingAsyncJob.mockResolvedValue(pendingJob);
    mockReconcileAsyncJobResults.mockResolvedValue('completed');

    const result = await recoverCycle();

    // idle + pending: falls through to reconciler
    expect(mockReconcileAsyncJobResults).toHaveBeenCalledWith('foreground');
    expect(result).toBe('idle');
  });
});
