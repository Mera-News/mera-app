import { create } from 'zustand';

/**
 * In-memory gating for WatermelonDB. `ready` is only true AFTER migrations
 * have run. Callers that hit the DB should bail if this is false.
 * Process-local so a crash resets it to false on cold start.
 */
interface DatabaseState {
  ready: boolean;
  setReady: (value: boolean) => void;
}

export const useDatabaseStore = create<DatabaseState>((set) => ({
  ready: false,
  setReady: (value) => set({ ready: value }),
}));

export const useDatabaseReady = () => useDatabaseStore((s) => s.ready);
