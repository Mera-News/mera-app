import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

interface TopicSyncState {
    isSyncing: boolean;
    total: number;
    completed: number;
    error: string | null;
    startSync: (total: number) => void;
    incrementCompleted: () => void;
    setError: (error: string) => void;
    finishSync: () => void;
    reset: () => void;
}

export const useTopicSyncStore = create<TopicSyncState>((set) => ({
    isSyncing: false,
    total: 0,
    completed: 0,
    error: null,
    startSync: (total) => set({ isSyncing: true, total, completed: 0, error: null }),
    incrementCompleted: () => set((state) => ({ completed: state.completed + 1 })),
    setError: (error) => set({ error }),
    finishSync: () => set({ isSyncing: false }),
    reset: () => set({ isSyncing: false, total: 0, completed: 0, error: null }),
}));

export const useTopicSyncIsSyncing = () => useTopicSyncStore((state) => state.isSyncing);
export const useTopicSyncProgress = () =>
    useTopicSyncStore(useShallow((state) => ({ total: state.total, completed: state.completed })));
export const useTopicSyncError = () => useTopicSyncStore((state) => state.error);
