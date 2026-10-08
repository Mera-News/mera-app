// The Feed's ONE counts card (owner) lives in the Feed tab's HEADER
// accessory, under the View chip, and hides with the header. It shows for an
// empty Feed (the view says so through `emptyWants`), at the daily limit, or
// when the Mera status icon asks for it. Its open/closed state lives here so
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
    /** The mounted Feed view is empty and its state needs the card. */
    readonly emptyWants: boolean;
    /** Bumped to ask the Feed page to reveal its header. */
    readonly revealSignal: number;
}

export const useFeedStatusCard = create<FeedStatusCardState>()(() => ({
    requested: false,
    expanded: true,
    mounted: 0,
    emptyWants: false,
    revealSignal: 0,
}));

/** The mounted Feed view says whether its empty state needs the card. */
export function setEmptyWantsCard(emptyWants: boolean): void {
    if (useFeedStatusCard.getState().emptyWants !== emptyWants) useFeedStatusCard.setState({ emptyWants });
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

/** The reader left the Feed page: drop a requested card, reopen the next. */
export function resetStatusCard(): void {
    useFeedStatusCard.setState({ requested: false, expanded: true });
}
