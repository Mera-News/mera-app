// track-proposal-store — global open/close state for the TrackProposalSheet.
//
// The "Track story" button lives inside several action rows/sheets we must not
// couple to a modal (CompactActionsSheet, ArticleActionsRow, detail screens).
// Rather than thread a sheet through each, the shared `useTrackedSubject` hook's
// track path calls `open(subject, onTracked)` and a single <TrackProposalSheet/>
// mounted at the logged-in root renders it. `onTracked` lets the initiating hook
// flip its optimistic "tracked" state only once the user actually accepts a
// proposal (the untrack path stays immediate and never touches this store).

import { create } from 'zustand';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';

interface TrackProposalState {
  visible: boolean;
  subject: FeedbackSubject | null;
  /** Fired once when the user accepts a proposal and the story is minted. */
  onTracked: (() => void) | null;
  open: (subject: FeedbackSubject, onTracked?: () => void) => void;
  close: () => void;
}

export const useTrackProposalStore = create<TrackProposalState>((set) => ({
  visible: false,
  subject: null,
  onTracked: null,
  open: (subject, onTracked) =>
    set({ visible: true, subject, onTracked: onTracked ?? null }),
  close: () => set({ visible: false, subject: null, onTracked: null }),
}));
