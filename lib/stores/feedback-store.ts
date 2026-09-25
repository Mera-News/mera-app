import { create } from 'zustand';

// Controls visibility of the "Report a Bug" feedback modal (FeedbackWidgetModal).
// The Preferences "Report a Bug" row routes through showFeedback() in
// lib/feedback.ts, which flips `visible` here. Kept as a tiny in-memory store so
// the modal can live at the app-wide logged-in layout (showing over any screen)
// without prop drilling through the tab tree.
interface FeedbackState {
    visible: boolean;
    /** A line shown above the form, set by a caller that attaches something
     *  to the report (the chat bug button: "Your chat with Mera will be
     *  attached to this report."). Cleared on every hide. */
    attachmentNote: string | null;
    show: (opts?: { attachmentNote?: string }) => void;
    hide: () => void;
}

export const useFeedbackStore = create<FeedbackState>((set) => ({
    visible: false,
    attachmentNote: null,
    show: (opts) => set({ visible: true, attachmentNote: opts?.attachmentNote ?? null }),
    hide: () => set({ visible: false, attachmentNote: null }),
}));

export const useFeedbackVisible = () => useFeedbackStore((state) => state.visible);
