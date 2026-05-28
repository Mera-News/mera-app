// Zustand slice for the "Processing news on your device — please keep the app
// open" banner that appears when Mera Protocol scoring is running in the
// foreground.

import { create } from 'zustand';

interface State {
  visible: boolean;
  show: () => void;
  hide: () => void;
}

export const useOnDeviceBannerStore = create<State>((set) => ({
  visible: false,
  show: () => set({ visible: true }),
  hide: () => set({ visible: false }),
}));
