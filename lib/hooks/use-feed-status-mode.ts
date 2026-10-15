// The feed pipeline's status, derived once.
//
// This used to live inline in FeedStatusShimmer, which was the only thing that
// needed it, the bar owned both the "what state are we in" question and the
// "what do I draw" answer. The bar is gone, and the two halves it fused now live
// in different rows of the header: a compact glyph beside the screen title, and
// a detail panel below it. They must never disagree about which state they are
// describing, so the derivation is hoisted here and both read the SAME value,
// passed down from the screen, not two subscriptions that could tick apart
// mid-render.
//
// The `FeedStatusMode` type lives in lib/feed-status-mode instead of here,
// deliberately: this module reaches the scheduler and the for-you store, which
// instantiate a native SQLite adapter at import, and a purely presentational
// component must not pull that in behind a type. See that file's header.
//
// Precedence: the read hold ('limited') wins over processing, then error, and "rows waiting for the next batch" only surfaces when nothing
// else is happening.

import {
    useFeedSyncRunning,
    useIsFeedProcessing,
} from '@/components/custom/FeedSyncIndicator';
import { type FeedStatusMode } from '@/lib/feed-status-mode';
import { useReadHeld } from '@/components/custom/cards/use-read-held';
import { useForYouScoringError, useForYouUnscoredCount } from '@/lib/stores/selectors';

export function useFeedStatusMode(): FeedStatusMode {
    const schedulerRunning = useFeedSyncRunning();
    const isFeedProcessing = useIsFeedProcessing();
    const scoringError = useForYouScoringError();
    const unscoredCount = useForYouUnscoredCount();
    // On-device reading is never held; re-checked every minute and on
    // foreground while a hold is set (use-read-held.ts).
    const { held } = useReadHeld();

    if (held) return 'limited';
    if (schedulerRunning || isFeedProcessing) return 'processing';
    if (scoringError !== null) return 'error';
    if (unscoredCount > 0) return 'deferred';
    return 'idle';
}
