// topic-sync-store has no external dependencies — no mocks needed beyond
// what jest.setup.js already provides.

import { renderHook } from '@testing-library/react-native';
import {
    useTopicSyncStore,
    useTopicSyncIsSyncing,
    useTopicSyncProgress,
    useTopicSyncError,
} from '../topic-sync-store';

// ──────────────────────────────────────────────────────────────────────────────
// Reset helper
// ──────────────────────────────────────────────────────────────────────────────

const initialState = {
    isSyncing: false,
    total: 0,
    completed: 0,
    error: null as string | null,
};

describe('useTopicSyncStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useTopicSyncStore.getState().reset();
    });

    // ── initial state ─────────────────────────────────────────────────────────

    it('starts with isSyncing=false, all counts zero, no error', () => {
        const state = useTopicSyncStore.getState();
        expect(state.isSyncing).toBe(false);
        expect(state.total).toBe(0);
        expect(state.completed).toBe(0);
        expect(state.error).toBeNull();
    });

    // ── startSync ─────────────────────────────────────────────────────────────

    it('startSync sets isSyncing=true, total, and resets completed/error', () => {
        useTopicSyncStore.setState({ completed: 5, error: 'old error' });
        useTopicSyncStore.getState().startSync(10);

        const state = useTopicSyncStore.getState();
        expect(state.isSyncing).toBe(true);
        expect(state.total).toBe(10);
        expect(state.completed).toBe(0);
        expect(state.error).toBeNull();
    });

    it('startSync with zero total is valid', () => {
        useTopicSyncStore.getState().startSync(0);
        expect(useTopicSyncStore.getState().total).toBe(0);
        expect(useTopicSyncStore.getState().isSyncing).toBe(true);
    });

    it('startSync with large total works correctly', () => {
        useTopicSyncStore.getState().startSync(9999);
        expect(useTopicSyncStore.getState().total).toBe(9999);
    });

    // ── incrementCompleted ────────────────────────────────────────────────────

    it('incrementCompleted increases completed by 1', () => {
        useTopicSyncStore.getState().startSync(5);
        useTopicSyncStore.getState().incrementCompleted();
        expect(useTopicSyncStore.getState().completed).toBe(1);
    });

    it('incrementCompleted is cumulative across multiple calls', () => {
        useTopicSyncStore.getState().startSync(10);
        useTopicSyncStore.getState().incrementCompleted();
        useTopicSyncStore.getState().incrementCompleted();
        useTopicSyncStore.getState().incrementCompleted();
        expect(useTopicSyncStore.getState().completed).toBe(3);
    });

    it('incrementCompleted can exceed total (no clamping)', () => {
        useTopicSyncStore.getState().startSync(2);
        useTopicSyncStore.getState().incrementCompleted();
        useTopicSyncStore.getState().incrementCompleted();
        useTopicSyncStore.getState().incrementCompleted(); // exceeds total
        expect(useTopicSyncStore.getState().completed).toBe(3);
    });

    // ── setError ──────────────────────────────────────────────────────────────

    it('setError stores the error message', () => {
        useTopicSyncStore.getState().setError('sync failed: network');
        expect(useTopicSyncStore.getState().error).toBe('sync failed: network');
    });

    it('setError can overwrite a previous error', () => {
        useTopicSyncStore.getState().setError('first error');
        useTopicSyncStore.getState().setError('second error');
        expect(useTopicSyncStore.getState().error).toBe('second error');
    });

    it('setError does not change isSyncing', () => {
        useTopicSyncStore.getState().startSync(5);
        useTopicSyncStore.getState().setError('something went wrong');
        expect(useTopicSyncStore.getState().isSyncing).toBe(true);
    });

    // ── finishSync ────────────────────────────────────────────────────────────

    it('finishSync sets isSyncing=false', () => {
        useTopicSyncStore.getState().startSync(3);
        useTopicSyncStore.getState().finishSync();
        expect(useTopicSyncStore.getState().isSyncing).toBe(false);
    });

    it('finishSync does not reset total or completed', () => {
        useTopicSyncStore.getState().startSync(5);
        useTopicSyncStore.getState().incrementCompleted();
        useTopicSyncStore.getState().incrementCompleted();
        useTopicSyncStore.getState().finishSync();

        const state = useTopicSyncStore.getState();
        expect(state.total).toBe(5);
        expect(state.completed).toBe(2);
    });

    it('finishSync does not clear error', () => {
        useTopicSyncStore.getState().startSync(5);
        useTopicSyncStore.getState().setError('error during sync');
        useTopicSyncStore.getState().finishSync();
        expect(useTopicSyncStore.getState().error).toBe('error during sync');
    });

    // ── reset ─────────────────────────────────────────────────────────────────

    it('reset restores all fields to initial values', () => {
        useTopicSyncStore.getState().startSync(20);
        useTopicSyncStore.getState().incrementCompleted();
        useTopicSyncStore.getState().setError('some error');
        useTopicSyncStore.getState().reset();

        const state = useTopicSyncStore.getState();
        expect(state.isSyncing).toBe(false);
        expect(state.total).toBe(0);
        expect(state.completed).toBe(0);
        expect(state.error).toBeNull();
    });

    it('reset is idempotent (multiple calls do not throw)', () => {
        useTopicSyncStore.getState().reset();
        useTopicSyncStore.getState().reset();
        expect(useTopicSyncStore.getState().isSyncing).toBe(false);
    });

    // ── combined sync flow ────────────────────────────────────────────────────

    it('full sync flow: start → increment → finish', () => {
        useTopicSyncStore.getState().startSync(3);

        expect(useTopicSyncStore.getState().isSyncing).toBe(true);
        expect(useTopicSyncStore.getState().total).toBe(3);

        useTopicSyncStore.getState().incrementCompleted();
        useTopicSyncStore.getState().incrementCompleted();
        useTopicSyncStore.getState().incrementCompleted();

        expect(useTopicSyncStore.getState().completed).toBe(3);

        useTopicSyncStore.getState().finishSync();

        const state = useTopicSyncStore.getState();
        expect(state.isSyncing).toBe(false);
        expect(state.total).toBe(3);
        expect(state.completed).toBe(3);
        expect(state.error).toBeNull();
    });

    it('error flow: start → setError → finishSync', () => {
        useTopicSyncStore.getState().startSync(5);
        useTopicSyncStore.getState().incrementCompleted();
        useTopicSyncStore.getState().setError('timeout');
        useTopicSyncStore.getState().finishSync();

        const state = useTopicSyncStore.getState();
        expect(state.isSyncing).toBe(false);
        expect(state.completed).toBe(1);
        expect(state.error).toBe('timeout');
    });

    it('second sync starts fresh after reset', () => {
        useTopicSyncStore.getState().startSync(5);
        useTopicSyncStore.getState().incrementCompleted();
        useTopicSyncStore.getState().finishSync();
        useTopicSyncStore.getState().reset();

        useTopicSyncStore.getState().startSync(8);

        const state = useTopicSyncStore.getState();
        expect(state.total).toBe(8);
        expect(state.completed).toBe(0);
        expect(state.isSyncing).toBe(true);
    });

    // ── boundary cases ────────────────────────────────────────────────────────

    it('startSync replaces previous sync state when called again without finish', () => {
        useTopicSyncStore.getState().startSync(10);
        useTopicSyncStore.getState().incrementCompleted();
        useTopicSyncStore.getState().startSync(20); // restart

        const state = useTopicSyncStore.getState();
        expect(state.total).toBe(20);
        expect(state.completed).toBe(0);
        expect(state.error).toBeNull();
    });

    // ── selector hooks ────────────────────────────────────────────────────────

    it('useTopicSyncIsSyncing returns current isSyncing value', () => {
        useTopicSyncStore.getState().startSync(5);
        const { result } = renderHook(() => useTopicSyncIsSyncing());
        expect(result.current).toBe(true);
    });

    it('useTopicSyncIsSyncing returns false when not syncing', () => {
        useTopicSyncStore.getState().reset();
        const { result } = renderHook(() => useTopicSyncIsSyncing());
        expect(result.current).toBe(false);
    });

    it('useTopicSyncProgress returns total and completed', () => {
        useTopicSyncStore.getState().startSync(10);
        useTopicSyncStore.getState().incrementCompleted();
        useTopicSyncStore.getState().incrementCompleted();
        const { result } = renderHook(() => useTopicSyncProgress());
        expect(result.current.total).toBe(10);
        expect(result.current.completed).toBe(2);
    });

    it('useTopicSyncError returns current error value', () => {
        useTopicSyncStore.getState().setError('network timeout');
        const { result } = renderHook(() => useTopicSyncError());
        expect(result.current).toBe('network timeout');
    });

    it('useTopicSyncError returns null when no error', () => {
        useTopicSyncStore.getState().reset();
        const { result } = renderHook(() => useTopicSyncError());
        expect(result.current).toBeNull();
    });
});
