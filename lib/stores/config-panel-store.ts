import { create } from 'zustand';

type ConfigPanelTab = 'persona' | 'sources' | 'preferences';

interface ConfigPanelState {
    // State
    isOpen: boolean;
    activeTab: ConfigPanelTab;

    // Actions
    openPanel: () => void;
    closePanel: () => void;
    setActiveTab: (tab: ConfigPanelTab) => void;
}

export const useConfigPanelStore = create<ConfigPanelState>((set) => ({
    isOpen: false,
    activeTab: 'persona',

    openPanel: () => set({ isOpen: true }),

    closePanel: () => set({ isOpen: false }),

    setActiveTab: (tab) => set({ activeTab: tab }),
}));

// Selector hooks for optimized subscriptions
export const useConfigPanelIsOpen = () => useConfigPanelStore((state) => state.isOpen);
export const useConfigPanelActiveTab = () => useConfigPanelStore((state) => state.activeTab);
