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
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { isReadHeld, useReadHold } from '@/lib/subscription/read-hold';
import { useProcessingMode } from '@/lib/stores/mera-protocol-store';
import { useForYouScoringError, useForYouUnscoredCount } from '@/lib/stores/selectors';
import { useEffect, useReducer } from 'react';
import { AppState } from 'react-native';

const HOLD_RECHECK_MS = 60_000;

export function useFeedStatusMode(): FeedStatusMode {
    const schedulerRunning = useFeedSyncRunning();
    const isFeedProcessing = useIsFeedProcessing();
    const scoringError = useForYouScoringError();
    const unscoredCount = useForYouUnscoredCount();
    const processingMode = useProcessingMode();
    const hold = useReadHold();
    const [, recheck] = useReducer((n: number) => n + 1, 0);

    // The hold ends on a jittered device-clock instant that emits nothing, so
    // while one is set, look again every minute and when the app comes back.
    const holding = hold.resetAt != null;
    useEffect(() => {
        if (!holding) return;
        const timer = setInterval(recheck, HOLD_RECHECK_MS);
        const sub = AppState.addEventListener('change', (s) => {
            if (s === 'active') recheck();
        });
        return () => {
            clearInterval(timer);
            sub.remove();
        };
    }, [holding]);

    // On-device reading is never held (see read-hold.ts).
    const held = processingMode !== ProcessingMode.OnDevice && holding && isReadHeld(Date.now());

    if (held) return 'limited';
    if (schedulerRunning || isFeedProcessing) return 'processing';
    if (scoringError !== null) return 'error';
    if (unscoredCount > 0) return 'deferred';
    return 'idle';
}
