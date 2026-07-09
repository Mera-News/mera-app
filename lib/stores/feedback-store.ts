import { create } from 'zustand';

// Controls visibility of the "Report a Bug" feedback modal (FeedbackWidgetModal).
// The two triggers (FeedbackFab + Preferences row) both route through
// showFeedback() in lib/feedback.ts, which flips `visible` here. Kept as a tiny
// in-memory store so the modal can live at the app_container layout without prop
// drilling through the tab tree.
interface FeedbackState {
    visible: boolean;
    show: () => void;
    hide: () => void;
}

export const useFeedbackStore = create<FeedbackState>((set) => ({
    visible: false,
    show: () => set({ visible: true }),
    hide: () => set({ visible: false }),
}));

export const useFeedbackVisible = () => useFeedbackStore((state) => state.visible);
