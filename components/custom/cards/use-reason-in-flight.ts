import {
    REASON_WRITING_BACKSTOP_MS,
    noteReasonInFlight,
    pruneReasonsInFlight,
} from '@/components/custom/cards/pending-since';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useEffect, useState } from 'react';

let pruneInstalled = false;

/** Forget an id's first sight the moment it leaves the in-flight set, whether or not its row is mounted. */
function installPrune(): void {
    if (pruneInstalled) return;
    pruneInstalled = true;
    useForYouStore.subscribe((s, prev) => {
        if (s.reasonsInFlightIds !== prev.reasonsInFlightIds) pruneReasonsInFlight(s.reasonsInFlightIds);
    });
}

/**
 * Whether the Feed card for suggestion `id` may say "Writing a note" right now.
 *
 * True only while BOTH hold:
 *  - the row's reasons are in flight (`reasonsInFlightIds`, the scoring
 *    pipeline's own projection of its live batches, pushed through
 *    `pushUiProgress`; ids are article_suggestions ids, i.e.
 *    `ForYouSuggestion._id`, never `articleId`), and
 *  - less than `REASON_WRITING_BACKSTOP_MS` has passed since this process first
 *    saw it in flight since it last entered the set.
 *
 * The in-flight set is the real end signal: when a batch finishes, fails or
 * expires at the gateway, the id leaves the set and the card stops claiming
 * work at once. The backstop only covers a batch that never settles.
 *
 * Reads the store, so it belongs to the Feed ROW (FeedScreen), never to the
 * card: the card graph must stay free of store imports that reach the
 * database at module scope.
 */
export function useReasonWriting(id: string): boolean {
    installPrune();
    const inFlight = useForYouStore((s) => s.reasonsInFlightIds.has(id));
    const anchor = inFlight ? noteReasonInFlight(id) : null;
    // The anchor that expired, not the id: a re-entry gets a new anchor and starts fresh.
    const [expiredAnchor, setExpiredAnchor] = useState<number | null>(null);
    const expired =
        anchor !== null &&
        (expiredAnchor === anchor || Date.now() - anchor >= REASON_WRITING_BACKSTOP_MS);

    useEffect(() => {
        if (anchor === null || expired) return;
        // One-shot, no polling: flips once when the backstop passes.
        const timer = setTimeout(
            () => setExpiredAnchor(anchor),
            anchor + REASON_WRITING_BACKSTOP_MS - Date.now(),
        );
        return () => clearTimeout(timer);
    }, [anchor, expired, id]);

    return inFlight && !expired;
}
