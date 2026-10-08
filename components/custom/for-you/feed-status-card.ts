// The Feed's ONE counts card (owner): wherever it shows (the empty Feed's
// card, the daily-limit card, or the card the Mera status icon asks for), its
// open/closed state lives here, so the icon can act on it. The icon never
// draws a second card or an overlay:
//   open      -> nothing but a scroll to it
//   collapsed -> expand it, scroll to it
//   absent    -> show it as the first item under the title row, open, scroll
// A requested card stays until the reader leaves the Feed page.

import { create } from 'zustand';

export type CardPresence = 'open' | 'collapsed' | 'absent';
export type IconTapAction = 'scroll' | 'expand' | 'show';

/** The icon-tap rule, pure. */
export function statusIconTap(presence: CardPresence): IconTapAction {
    if (presence === 'open') return 'scroll';
    if (presence === 'collapsed') return 'expand';
    return 'show';
}

interface FeedStatusCardState {
    /** The icon asked for the card on a Feed that has cards. */
    readonly requested: boolean;
    readonly expanded: boolean;
    /** Counts cards currently mounted (0 or 1 by construction). */
    readonly mounted: number;
    /** Bumped to ask the mounted list to scroll to its top. */
    readonly scrollSignal: number;
}

export const useFeedStatusCard = create<FeedStatusCardState>()(() => ({
    requested: false,
    expanded: true,
    mounted: 0,
    scrollSignal: 0,
}));

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
        scrollSignal: s.scrollSignal + 1,
    });
}

/** The reader left the Feed page: drop a requested card, reopen the next. */
export function resetStatusCard(): void {
    useFeedStatusCard.setState({ requested: false, expanded: true });
}
