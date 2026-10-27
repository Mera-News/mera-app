import { create } from 'zustand';

// Controls visibility of the "Report a Bug" feedback modal (FeedbackWidgetModal).
// The Preferences "Report a Bug" row routes through showFeedback() in
// lib/feedback.ts, which flips `visible` here. Kept as a tiny in-memory store so
// the modal can live at the app-wide logged-in layout (showing over any screen)
// without prop drilling through the tab tree.
interface FeedbackState {
    visible: boolean;
    /** The widget is in the tree: open, or closing and not yet gone. */
    mounted: boolean;
    show: () => void;
    hide: () => void;
    /** The sheet has fully gone: unmount the widget. */
    unmount: () => void;
}

export const useFeedbackStore = create<FeedbackState>((set) => ({
    visible: false,
    mounted: false,
    show: () => set({ visible: true, mounted: true }),
    hide: () => set({ visible: false }),
    unmount: () => set({ mounted: false }),
}));

export const useFeedbackVisible = () => useFeedbackStore((state) => state.visible);
