import { renderHook, act } from '@testing-library/react-native';
import { useDatabaseStore, useDatabaseReady } from '../database-store';

describe('useDatabaseStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useDatabaseStore.setState({ ready: false });
    });

    // ── initial state ──────────────────────────────────────────────────────
    it('starts with ready: false', () => {
        expect(useDatabaseStore.getState().ready).toBe(false);
    });

    // ── setReady ──────────────────────────────────────────────────────────
    it('setReady(true) sets ready to true', () => {
        useDatabaseStore.getState().setReady(true);
        expect(useDatabaseStore.getState().ready).toBe(true);
    });

    it('setReady(false) sets ready to false after it was true', () => {
        useDatabaseStore.getState().setReady(true);
        useDatabaseStore.getState().setReady(false);
        expect(useDatabaseStore.getState().ready).toBe(false);
    });

    it('setReady is idempotent when called with the same value', () => {
        useDatabaseStore.getState().setReady(true);
        useDatabaseStore.getState().setReady(true);
        expect(useDatabaseStore.getState().ready).toBe(true);
    });

    // ── useDatabaseReady selector ─────────────────────────────────────────
    it('useDatabaseReady selector returns current ready value', () => {
        const { result } = renderHook(() => useDatabaseReady());
        expect(result.current).toBe(false);
    });

    it('useDatabaseReady selector reflects updates', () => {
        const { result } = renderHook(() => useDatabaseReady());
        act(() => {
            useDatabaseStore.getState().setReady(true);
        });
        expect(result.current).toBe(true);
    });
});
