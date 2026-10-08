// The Feed's ONE counts card (owner) lives in the Feed tab's HEADER
// accessory, under the View chip, and hides with the header. It shows
// COLLAPSED (the day's counts sentence) whenever the Feed has suggestions
// (`hasRows`), EXPANDED for an empty Feed (`emptyWants`), at the daily limit,
// or when the Mera status icon asks for it. Its open/closed state lives here so
// the icon can act on it; the icon first reveals the header, then:
//   open      -> nothing more
//   collapsed -> expand it
//   absent    -> show it, open
// A requested card stays until the reader leaves the Feed page.

import { create } from 'zustand';

export type CardPresence = 'open' | 'collapsed' | 'absent';
export type IconTapAction = 'reveal' | 'expand' | 'show';

/** The icon-tap rule, pure. */
export function statusIconTap(presence: CardPresence): IconTapAction {
    if (presence === 'open') return 'reveal';
    if (presence === 'collapsed') return 'expand';
    return 'show';
}

interface FeedStatusCardState {
    /** The icon asked for the card on a Feed that has cards. */
    readonly requested: boolean;
    readonly expanded: boolean;
    /** Counts cards currently mounted (0 or 1 by construction). */
    readonly mounted: number;
    /** The mounted Feed view is empty and its state needs the card (open). */
    readonly emptyWants: boolean;
    /** The mounted Feed view has suggestions: the card shows, collapsed. */
    readonly hasRows: boolean;
    /** Bumped to ask the Feed page to reveal its header. */
    readonly revealSignal: number;
}

export const useFeedStatusCard = create<FeedStatusCardState>()(() => ({
    requested: false,
    expanded: false,
    mounted: 0,
    emptyWants: false,
    hasRows: false,
    revealSignal: 0,
}));

/** The mounted Feed view says whether its empty state needs the card. An
 *  empty Feed shows it open (each time the view reports it, i.e. on arrival);
 *  when the first suggestions land it folds back to the collapsed counts. */
export function setEmptyWantsCard(emptyWants: boolean): void {
    const was = useFeedStatusCard.getState().emptyWants;
    if (emptyWants) useFeedStatusCard.setState({ emptyWants, expanded: true });
    else if (was) useFeedStatusCard.setState({ emptyWants, expanded: false });
}

/** The mounted Feed view says whether it has suggestions. */
export function setFeedHasRows(hasRows: boolean): void {
    if (useFeedStatusCard.getState().hasRows !== hasRows) useFeedStatusCard.setState({ hasRows });
}

/** A counts card mounts / unmounts. Returns the unregister. */
export function registerStatusCard(): () => void {
    useFeedStatusCard.setState((s) => ({ mounted: s.mounted + 1 }));
    return () => useFeedStatusCard.setState((s) => ({ mounted: Math.max(0, s.mounted - 1) }));
}

export function setStatusCardExpanded(expanded: boolean): void {
    useFeedStatusCard.setState({ expanded });
}

/** The Mera status icon was tapped. */
export function tapStatusIcon(): void {
    const s = useFeedStatusCard.getState();
    const presence: CardPresence = s.mounted === 0 ? 'absent' : s.expanded ? 'open' : 'collapsed';
    const action = statusIconTap(presence);
    useFeedStatusCard.setState({
        ...(action === 'show' ? { requested: true, expanded: true } : null),
        ...(action === 'expand' ? { expanded: true } : null),
        revealSignal: s.revealSignal + 1,
    });
}

/** The reader left the Feed page: drop a requested card; over suggestions
 *  the card comes back collapsed (an empty Feed reopens it on arrival). */
export function resetStatusCard(): void {
    useFeedStatusCard.setState({ requested: false, expanded: false });
}
