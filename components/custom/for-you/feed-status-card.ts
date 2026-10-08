// The Feed's ONE counts card (owner) is the FIRST item of the Feed list, in
// both views, so a page swipe carries it like any card. It shows whenever the
// Feed has suggestions, is empty past a run, or is at the daily limit, and
// ALWAYS starts collapsed (owner): only the reader's tap opens it. Its
// open/closed state lives here.

import { create } from 'zustand';

interface FeedStatusCardState {
    readonly expanded: boolean;
}

export const useFeedStatusCard = create<FeedStatusCardState>()(() => ({
    expanded: false,
}));

/** Whether the Feed list leads with the card. */
export function statsCardShown(i: { limited: boolean; empty: boolean; hasRows: boolean }): boolean {
    return i.limited || i.empty || i.hasRows;
}

export function setStatusCardExpanded(expanded: boolean): void {
    useFeedStatusCard.setState({ expanded });
}

/** The reader left the Feed page: the card comes back collapsed. */
export function resetStatusCard(): void {
    useFeedStatusCard.setState({ expanded: false });
}
