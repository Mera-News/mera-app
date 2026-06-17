import { useSchedulerStore } from '../scheduler-store';
import type { Job } from '../scheduler-types';

// Helper to make a minimal Job fixture
function makeJob(overrides: Partial<Job> = {}): Job {
    return {
        id: 'job-1',
        taskName: 'feed-sync',
        status: 'pending',
        attempt: 1,
        maxAttempts: 3,
        scheduledAt: 1000,
        ...overrides,
    };
}

describe('useSchedulerStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Full reset to initial state
        useSchedulerStore.setState({
            status: 'initializing',
            jobs: {},
            taskCurrentStatus: {},
            taskLastRun: {},
            taskProgress: {},
            runningCount: 0,
            failedCount: 0,
            pendingCount: 0,
        });
    });

    // ── initial state ──────────────────────────────────────────────────────
    it('starts with initializing status and empty collections', () => {
        const state = useSchedulerStore.getState();
        expect(state.status).toBe('initializing');
        expect(state.jobs).toEqual({});
        expect(state.runningCount).toBe(0);
        expect(state.failedCount).toBe(0);
        expect(state.pendingCount).toBe(0);
    });

    // ── setStatus ─────────────────────────────────────────────────────────
    it('setStatus transitions to running', () => {
        useSchedulerStore.getState().setStatus('running');
        expect(useSchedulerStore.getState().status).toBe('running');
    });

    it('setStatus transitions to paused', () => {
        useSchedulerStore.getState().setStatus('paused');
        expect(useSchedulerStore.getState().status).toBe('paused');
    });

    // ── addJob ────────────────────────────────────────────────────────────
    it('addJob stores the job and increments pendingCount', () => {
        const job = makeJob();
        useSchedulerStore.getState().addJob(job);
        const state = useSchedulerStore.getState();
        expect(state.jobs['job-1']).toMatchObject({ id: 'job-1', taskName: 'feed-sync' });
        expect(state.pendingCount).toBe(1);
    });

    it('addJob sets taskCurrentStatus for the task', () => {
        useSchedulerStore.getState().addJob(makeJob({ taskName: 'data-cleanup', status: 'pending' }));
        expect(useSchedulerStore.getState().taskCurrentStatus['data-cleanup']).toBe('pending');
    });

    it('addJob accumulates multiple jobs', () => {
        useSchedulerStore.getState().addJob(makeJob({ id: 'j1', taskName: 'task-a' }));
        useSchedulerStore.getState().addJob(makeJob({ id: 'j2', taskName: 'task-b' }));
        const state = useSchedulerStore.getState();
        expect(Object.keys(state.jobs)).toHaveLength(2);
        expect(state.pendingCount).toBe(2);
    });

    // ── reserveTask / clearTaskReservation ────────────────────────────────
    it('reserveTask marks the task as running so isRunning() reports true', () => {
        useSchedulerStore.getState().reserveTask('feed-sync');
        expect(useSchedulerStore.getState().isRunning('feed-sync')).toBe(true);
    });

    it('addJob preserves an existing running reservation (does not downgrade to pending)', () => {
        // reserveTask runs before createJob; addJob must not reopen the
        // exclusivity window by resetting the status back to 'pending'.
        useSchedulerStore.getState().reserveTask('feed-sync');
        useSchedulerStore.getState().addJob(makeJob({ taskName: 'feed-sync', status: 'pending' }));
        expect(useSchedulerStore.getState().isRunning('feed-sync')).toBe(true);
    });

    it('clearTaskReservation releases a reservation', () => {
        useSchedulerStore.getState().reserveTask('feed-sync');
        useSchedulerStore.getState().clearTaskReservation('feed-sync');
        expect(useSchedulerStore.getState().isRunning('feed-sync')).toBe(false);
    });

    it('clearTaskReservation is a no-op when the task is not reserved/running', () => {
        useSchedulerStore.getState().addJob(makeJob({ taskName: 'feed-sync', status: 'completed' }));
        useSchedulerStore.getState().clearTaskReservation('feed-sync');
        // Status must remain 'completed' — clear only affects a live reservation.
        expect(useSchedulerStore.getState().taskCurrentStatus['feed-sync']).toBe('completed');
    });

    // ── setJobRunning ─────────────────────────────────────────────────────
    it('setJobRunning transitions status to running and adjusts counts', () => {
        useSchedulerStore.getState().addJob(makeJob());
        useSchedulerStore.getState().setJobRunning('job-1');
        const state = useSchedulerStore.getState();
        expect(state.jobs['job-1'].status).toBe('running');
        expect(state.runningCount).toBe(1);
        expect(state.pendingCount).toBe(0);
    });

    it('setJobRunning stamps startedAt', () => {
        const before = Date.now();
        useSchedulerStore.getState().addJob(makeJob());
        useSchedulerStore.getState().setJobRunning('job-1');
        const startedAt = useSchedulerStore.getState().jobs['job-1'].startedAt!;
        expect(startedAt).toBeGreaterThanOrEqual(before);
    });

    it('setJobRunning is a no-op for unknown jobId', () => {
        useSchedulerStore.getState().setJobRunning('nonexistent');
        expect(useSchedulerStore.getState().runningCount).toBe(0);
    });

    it('setJobRunning clamps pendingCount at 0', () => {
        // Already 0 pending, ensure no underflow
        useSchedulerStore.getState().addJob(makeJob());
        // Manually set pendingCount to 0 to simulate edge case
        useSchedulerStore.setState({ pendingCount: 0 });
        useSchedulerStore.getState().setJobRunning('job-1');
        expect(useSchedulerStore.getState().pendingCount).toBe(0);
    });

    // ── setJobCompleted ───────────────────────────────────────────────────
    it('setJobCompleted transitions status and updates taskLastRun', () => {
        useSchedulerStore.getState().addJob(makeJob());
        useSchedulerStore.getState().setJobRunning('job-1');
        useSchedulerStore.getState().setJobCompleted('job-1', 9999);
        const state = useSchedulerStore.getState();
        expect(state.jobs['job-1'].status).toBe('completed');
        expect(state.jobs['job-1'].completedAt).toBe(9999);
        expect(state.taskLastRun['feed-sync']).toBe(9999);
        expect(state.runningCount).toBe(0);
    });

    it('setJobCompleted is a no-op for unknown jobId', () => {
        useSchedulerStore.getState().setJobCompleted('ghost', 0);
        expect(useSchedulerStore.getState().runningCount).toBe(0);
    });

    it('setJobCompleted clamps runningCount at 0', () => {
        useSchedulerStore.getState().addJob(makeJob());
        useSchedulerStore.setState({ runningCount: 0 });
        useSchedulerStore.getState().setJobCompleted('job-1', 1);
        expect(useSchedulerStore.getState().runningCount).toBe(0);
    });

    // ── setJobFailed ──────────────────────────────────────────────────────
    it('setJobFailed with exhausted=true sets status to failed and increments failedCount', () => {
        useSchedulerStore.getState().addJob(makeJob());
        useSchedulerStore.getState().setJobRunning('job-1');
        useSchedulerStore.getState().setJobFailed('job-1', true);
        const state = useSchedulerStore.getState();
        expect(state.jobs['job-1'].status).toBe('failed');
        expect(state.failedCount).toBe(1);
        expect(state.runningCount).toBe(0);
    });

    it('setJobFailed with exhausted=false sets status to retrying and does not increment failedCount', () => {
        useSchedulerStore.getState().addJob(makeJob());
        useSchedulerStore.getState().setJobRunning('job-1');
        useSchedulerStore.getState().setJobFailed('job-1', false, 5000);
        const state = useSchedulerStore.getState();
        expect(state.jobs['job-1'].status).toBe('retrying');
        expect(state.jobs['job-1'].retryAt).toBe(5000);
        expect(state.failedCount).toBe(0);
    });

    it('setJobFailed is a no-op for unknown jobId', () => {
        useSchedulerStore.getState().setJobFailed('ghost', true);
        expect(useSchedulerStore.getState().failedCount).toBe(0);
    });

    it('setJobFailed clamps runningCount at 0', () => {
        useSchedulerStore.getState().addJob(makeJob());
        useSchedulerStore.setState({ runningCount: 0 });
        useSchedulerStore.getState().setJobFailed('job-1', true);
        expect(useSchedulerStore.getState().runningCount).toBe(0);
    });

    // ── updateProgress ────────────────────────────────────────────────────
    it('updateProgress stores progress on the job and in taskProgress', () => {
        useSchedulerStore.getState().addJob(makeJob());
        useSchedulerStore.getState().setJobRunning('job-1');
        useSchedulerStore.getState().updateProgress('job-1', { step: 'fetching', current: 3, total: 10 });
        const state = useSchedulerStore.getState();
        expect(state.jobs['job-1'].progress).toEqual({ step: 'fetching', current: 3, total: 10 });
        expect(state.taskProgress['feed-sync']).toEqual({ step: 'fetching', current: 3, total: 10 });
    });

    it('updateProgress is a no-op for unknown jobId', () => {
        useSchedulerStore.getState().updateProgress('ghost', { current: 1 });
        expect(useSchedulerStore.getState().taskProgress).toEqual({});
    });

    // ── isRunning ─────────────────────────────────────────────────────────
    it('isRunning returns true when taskCurrentStatus is "running"', () => {
        useSchedulerStore.getState().addJob(makeJob());
        useSchedulerStore.getState().setJobRunning('job-1');
        expect(useSchedulerStore.getState().isRunning('feed-sync')).toBe(true);
    });

    it('isRunning returns false when task is not running', () => {
        expect(useSchedulerStore.getState().isRunning('feed-sync')).toBe(false);
    });

    it('isRunning returns false after job completes', () => {
        useSchedulerStore.getState().addJob(makeJob());
        useSchedulerStore.getState().setJobRunning('job-1');
        useSchedulerStore.getState().setJobCompleted('job-1', Date.now());
        expect(useSchedulerStore.getState().isRunning('feed-sync')).toBe(false);
    });

    // ── getLastRun ────────────────────────────────────────────────────────
    it('getLastRun returns null for unseen task', () => {
        expect(useSchedulerStore.getState().getLastRun('unknown-task')).toBeNull();
    });

    it('getLastRun returns the stored timestamp after completion', () => {
        useSchedulerStore.getState().addJob(makeJob());
        useSchedulerStore.getState().setJobRunning('job-1');
        useSchedulerStore.getState().setJobCompleted('job-1', 12345);
        expect(useSchedulerStore.getState().getLastRun('feed-sync')).toBe(12345);
    });

    // ── setLastRun ────────────────────────────────────────────────────────
    it('setLastRun stores the timestamp for a given task', () => {
        useSchedulerStore.getState().setLastRun('feed-sync', 99999);
        expect(useSchedulerStore.getState().taskLastRun['feed-sync']).toBe(99999);
    });

    it('setLastRun overwrites an existing timestamp', () => {
        useSchedulerStore.getState().setLastRun('feed-sync', 1);
        useSchedulerStore.getState().setLastRun('feed-sync', 2);
        expect(useSchedulerStore.getState().taskLastRun['feed-sync']).toBe(2);
    });

    // ── loadLastRunTimes ──────────────────────────────────────────────────
    it('loadLastRunTimes merges multiple task timestamps', () => {
        useSchedulerStore.getState().setLastRun('existing-task', 100);
        useSchedulerStore.getState().loadLastRunTimes({
            'feed-sync': 500,
            'data-cleanup': 600,
        });
        const { taskLastRun } = useSchedulerStore.getState();
        expect(taskLastRun['feed-sync']).toBe(500);
        expect(taskLastRun['data-cleanup']).toBe(600);
        expect(taskLastRun['existing-task']).toBe(100);
    });

    it('loadLastRunTimes overwrites existing timestamps', () => {
        useSchedulerStore.getState().setLastRun('feed-sync', 1);
        useSchedulerStore.getState().loadLastRunTimes({ 'feed-sync': 999 });
        expect(useSchedulerStore.getState().taskLastRun['feed-sync']).toBe(999);
    });

    it('loadLastRunTimes is safe with an empty object', () => {
        useSchedulerStore.getState().loadLastRunTimes({});
        expect(useSchedulerStore.getState().taskLastRun).toEqual({});
    });

    // ── full job lifecycle ────────────────────────────────────────────────
    it('tracks a complete job lifecycle: pending → running → completed', () => {
        const job = makeJob({ id: 'lifecycle-job', taskName: 'push-check' });
        useSchedulerStore.getState().addJob(job);
        expect(useSchedulerStore.getState().pendingCount).toBe(1);

        useSchedulerStore.getState().setJobRunning('lifecycle-job');
        expect(useSchedulerStore.getState().runningCount).toBe(1);
        expect(useSchedulerStore.getState().pendingCount).toBe(0);

        useSchedulerStore.getState().setJobCompleted('lifecycle-job', 2000);
        expect(useSchedulerStore.getState().runningCount).toBe(0);
        expect(useSchedulerStore.getState().taskLastRun['push-check']).toBe(2000);
    });

    it('tracks a job lifecycle through failure with retry', () => {
        const job = makeJob({ id: 'retry-job', taskName: 'inference-recover' });
        useSchedulerStore.getState().addJob(job);
        useSchedulerStore.getState().setJobRunning('retry-job');
        useSchedulerStore.getState().setJobFailed('retry-job', false, 3000);

        const state = useSchedulerStore.getState();
        expect(state.jobs['retry-job'].status).toBe('retrying');
        expect(state.jobs['retry-job'].retryAt).toBe(3000);
        expect(state.failedCount).toBe(0);
        expect(state.runningCount).toBe(0);
    });
});
