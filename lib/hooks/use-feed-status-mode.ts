// The feed pipeline's status, derived once.
//
// This used to live inline in FeedStatusShimmer, which was the only thing that
// needed it — the bar owned both the "what state are we in" question and the
// "what do I draw" answer. The bar is gone, and the two halves it fused now live
// in different rows of the header: a compact glyph beside the screen title, and
// a detail panel below it. They must never disagree about which state they are
// describing, so the derivation is hoisted here and both read the SAME value,
// passed down from the screen — not two subscriptions that could tick apart
// mid-render.
//
// The `FeedStatusMode` type and `isStatusVisible` live in lib/feed-status-mode
// instead of here, deliberately: this module reaches the scheduler and the
// for-you store, which instantiate a native SQLite adapter at import. See that
// file's header.
//
// Precedence is unchanged from the bar: processing wins over error wins over the
// daily limit, and "rows waiting for the next batch" only surfaces when nothing
// else is happening.

import {
    useFeedSyncRunning,
    useIsFeedProcessing,
} from '@/components/custom/FeedSyncIndicator';
import { type FeedStatusMode } from '@/lib/feed-status-mode';
import {
    useForYouDailyLimitResetAt,
    useForYouScoringError,
    useForYouUnscoredCount,
} from '@/lib/stores/selectors';

export function useFeedStatusMode(): FeedStatusMode {
    const schedulerRunning = useFeedSyncRunning();
    const isFeedProcessing = useIsFeedProcessing();
    const scoringError = useForYouScoringError();
    const dailyLimitResetAt = useForYouDailyLimitResetAt();
    const unscoredCount = useForYouUnscoredCount();

    // Evaluated at render rather than off a ticking clock — the same trade-off
    // FeedStatusDetails already makes. The limit is sticky enough that the next
    // store-driven render clears it; a second 30s interval just to flip a glyph
    // is not worth the wakeups.
    const isDailyLimited = dailyLimitResetAt != null && Date.now() < dailyLimitResetAt;

    if (schedulerRunning || isFeedProcessing) return 'processing';
    if (scoringError !== null) return 'error';
    if (isDailyLimited) return 'limited';
    if (unscoredCount > 0) return 'deferred';
    return 'idle';
}
