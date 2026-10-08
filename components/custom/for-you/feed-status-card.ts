// The Feed's ONE counts card (owner) is the FIRST item of the Feed list, in
// both views, so a page swipe carries it like any card. It shows COLLAPSED
// (the day's counts sentence) whenever the Feed has suggestions, EXPANDED for
// an empty Feed past a run (`emptyWants`), and at the daily limit. Its
// open/closed state lives here, so the empty Feed can open it.

import { create } from 'zustand';

interface FeedStatusCardState {
    readonly expanded: boolean;
    /** The mounted Feed view is empty past a run: the card opens. */
    readonly emptyWants: boolean;
}

export const useFeedStatusCard = create<FeedStatusCardState>()(() => ({
    expanded: false,
    emptyWants: false,
}));

/** Whether the Feed list leads with the card. */
export function statsCardShown(i: { limited: boolean; emptyWants: boolean; hasRows: boolean }): boolean {
    return i.limited || i.emptyWants || i.hasRows;
}

/** The mounted Feed view says whether its empty state needs the card. An
 *  empty Feed shows it open (each time the view reports it, i.e. on arrival);
 *  when the first suggestions land it folds back to the collapsed counts. */
export function setEmptyWantsCard(emptyWants: boolean): void {
    const was = useFeedStatusCard.getState().emptyWants;
    if (emptyWants) useFeedStatusCard.setState({ emptyWants, expanded: true });
    else if (was) useFeedStatusCard.setState({ emptyWants, expanded: false });
}

export function setStatusCardExpanded(expanded: boolean): void {
    useFeedStatusCard.setState({ expanded });
}

/** The reader left the Feed page: the card comes back collapsed (an empty
 *  Feed reopens it on arrival). */
export function resetStatusCard(): void {
    useFeedStatusCard.setState({ expanded: false });
}
