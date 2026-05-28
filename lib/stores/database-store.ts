import { create } from 'zustand';

/**
 * In-memory gating for WatermelonDB. Both flags are process-local on purpose —
 * a crash resets them to false on cold start, which is exactly what we want:
 *   - `ready` is only true AFTER migrations have run (the first DB access in
 *     hydrateAllStores is what triggers them). Callers that hit the DB should
 *     bail if this is false.
 *   - `syncInProgress` replaces the old DB-backed SYNC_LOCK_KEY. Lives purely
 *     in memory so a mid-sync crash can't leave a stuck "true" lock behind.
 */
interface DatabaseState {
  ready: boolean;
  syncInProgress: boolean;
  setReady: (value: boolean) => void;
  setSyncInProgress: (value: boolean) => void;
}

export const useDatabaseStore = create<DatabaseState>((set) => ({
  ready: false,
  syncInProgress: false,
  setReady: (value) => set({ ready: value }),
  setSyncInProgress: (value) => set({ syncInProgress: value }),
}));

export const useDatabaseReady = () => useDatabaseStore((s) => s.ready);
export const useSyncInProgress = () => useDatabaseStore((s) => s.syncInProgress);
