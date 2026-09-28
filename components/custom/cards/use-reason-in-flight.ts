import {
    REASON_WRITING_BACKSTOP_MS,
    noteReasonInFlight,
} from '@/components/custom/cards/pending-since';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useEffect, useState } from 'react';

/**
 * Whether the Feed card for suggestion `id` may say "Writing a note" right now.
 *
 * True only while BOTH hold:
 *  - the row's reasons are in flight (`reasonsInFlightIds`, the scoring
 *    pipeline's own projection of its live batches, pushed through
 *    `pushUiProgress`; ids are article_suggestions ids, i.e.
 *    `ForYouSuggestion._id`, never `articleId`), and
 *  - less than `REASON_WRITING_BACKSTOP_MS` has passed since this process first
 *    saw it in flight.
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
    const inFlight = useForYouStore((s) => s.reasonsInFlightIds.has(id));
    const anchor = inFlight ? noteReasonInFlight(id) : null;
    const [expiredFor, setExpiredFor] = useState<string | null>(null);
    const expired =
        anchor !== null &&
        (expiredFor === id || Date.now() - anchor >= REASON_WRITING_BACKSTOP_MS);

    useEffect(() => {
        if (anchor === null || expired) return;
        // One-shot, no polling: flips once when the backstop passes.
        const timer = setTimeout(
            () => setExpiredFor(id),
            anchor + REASON_WRITING_BACKSTOP_MS - Date.now(),
        );
        return () => clearTimeout(timer);
    }, [anchor, expired, id]);

    return inFlight && !expired;
}
