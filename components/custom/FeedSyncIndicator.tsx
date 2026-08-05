// FeedSyncIndicator — the ONE feed-sync status surface, shared by the Feed tab
// (components/custom/feed/FeedScreen) and the Dashboard (for_you /
// components/custom/for-you/ForYouScreen). Both headers used to hand-roll their
// own chrome: the Dashboard mounted FeedStatusShimmer + a copy-pasted offline
// row, and the Feed tab had no sync indicator at all. This component owns both
// so the two tabs can never drift again. (ReauthBanner is NOT here — it moved
// to app/logged-in/_layout.tsx so it covers every logged-in screen, not just
// the two feed surfaces.)
//
// ── Why the scheduler flag and not just the for-you store ──
// The Dashboard's old `isFeedProcessing` derivation is driven by
// `useForYouStore.syncStatusMessage`, which is only ever written by
// `publishSyncStatus`. Its FIRST happy-path call is `'hydrating'` (deep inside
// FeedSyncMachine) — i.e. after the snapshot load, the keep-awake, the
// pipeline-status check, two network round-trips and the diff. And it is
// skipped ENTIRELY on the deliberately-silent `missingIds.length === 0` branch
// and when the scoring pipeline is already running. So on a typical refresh the
// shimmer never appeared at all, and it could never satisfy "I want the loader
// on the same frame as my pull".
//
// `useSchedulerStore.taskCurrentStatus['feed-sync']` can: `AppScheduler.trigger`
// runs synchronously through `reserveTask(task.name)` (a plain zustand `set()`)
// BEFORE its first `await persistence.createJob(...)`, and feed-sync is
// `exclusive: true` so the reservation always fires. A subscriber therefore
// re-renders on the same JS tick as the pull.
//
// Visibility is `schedulerRunning || isFeedProcessing`: the scheduler flag gives
// instant on/off, the store-derived flag keeps the richer phase detail and
// covers the cloud/on-device scoring tail that outlives the scheduler job.

import FeedStatusShimmer from '@/components/custom/for-you/FeedStatusShimmer';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import logger from '@/lib/logger';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { useInjectNoise } from '@/lib/stores/mera-protocol-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { getAiAccess } from '@/lib/stores/subscription-store';
import {
    useForYouAsyncJobPhase,
    useForYouDailyLimitResetAt,
    useForYouDeviceProcessing,
    useForYouNoisyDiscardedCount,
    useForYouScoringError,
    useForYouSyncStatusMessage,
    useForYouUnscoredCount,
} from '@/lib/stores/selectors';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** The scheduler task both screens pull-to-refresh against. */
export const FEED_SYNC_TASK = 'feed-sync';

/**
 * Any client-visible fetch/scoring work still in flight, derived purely from the
 * for-you store. Lifted verbatim out of ForYouScreen/FeedScreen, which had
 * identical copies — both still need it for their empty-state chain
 * (FeedPreparingCard vs AllCaughtUpCard) and header auto-reveal, so it stays a
 * standalone hook rather than being buried in the component.
 *
 * Deliberately does NOT fold in the scheduler flag: the empty-state chain reads
 * this too, and "a scheduler job is enqueued" is not the same claim as "there is
 * feed work in flight". The scheduler flag is OR-ed in at the indicator only.
 *
 * Round-4 B note (preserved): the `unscoredCount > 0` term is intentionally
 * absent — deliberately-deferred rows (a sub-25 quantum waiting for the next
 * batch) are NOT "processing", so the shimmer must not spin while they wait.
 * They surface as a static note via FeedStatusShimmer's `unscoredCount` prop.
 */
export function useIsFeedProcessing(): boolean {
    const asyncJobPhase = useForYouAsyncJobPhase();
    const { isDeviceProcessing } = useForYouDeviceProcessing();
    const syncStatusMessage = useForYouSyncStatusMessage();

    const isAnySyncActive =
        syncStatusMessage !== null &&
        syncStatusMessage.state !== 'idle' &&
        syncStatusMessage.state !== 'done' &&
        syncStatusMessage.state !== 'failed' &&
        syncStatusMessage.state !== 'paused-offline';

    return isAnySyncActive || asyncJobPhase !== 'idle' || isDeviceProcessing;
}

/**
 * Reactive "the feed-sync scheduler job is running right now".
 *
 * `=== 'running'` and NOT truthiness: `taskCurrentStatus` is never reset to
 * `null` on success — it goes to `'completed'` / `'failed'` / `'retrying'`, all
 * of which are truthy. Also note this is a field selector, not the store's
 * `isRunning` METHOD: that one is `get()`-based and therefore non-reactive.
 */
export function useFeedSyncRunning(): boolean {
    return useSchedulerStore((s) => s.taskCurrentStatus[FEED_SYNC_TASK] === 'running');
}

export interface FeedSyncRefresh {
    /** Bind straight to `<RefreshControl refreshing={...} />`. */
    readonly refreshing: boolean;
    /** Bind straight to `<RefreshControl onRefresh={...} />`. */
    readonly onRefresh: () => void;
}

/**
 * The shared pull-to-refresh handler for both feed surfaces.
 *
 * `refreshing` tracks the REAL scheduler job, not local state, but only for a
 * pull the user actually made. Two separate requirements pull in opposite
 * directions here:
 *
 *  - The spinner must not collapse on a no-op. `AppScheduler.trigger` has four
 *    silent early-returns — task paused, already-running-and-exclusive,
 *    scheduler suspended, and the observationally identical FeedSyncMachine
 *    pipeline-running return — three of which resolve in the SAME tick. The old
 *    `setRefreshing(true); await trigger(); setRefreshing(false)` therefore
 *    flashed and vanished, and the user saw nothing. Hence the scheduler flag.
 *  - The spinner must not appear UNPROMPTED. feed-sync also runs on a 60s tick,
 *    on foreground, and on network reconnect. Binding the RefreshControl to the
 *    raw scheduler flag would drop the native spinner over the list during
 *    every one of those, mid-read, with no gesture behind it.
 *
 * So: `schedulerRunning && userPulled`. The header shimmer (which is ambient
 * chrome, not a modal overlay) still reflects every sync via the indicator's
 * own `useFeedSyncRunning()` — that is the "loader" the pull is meant to
 * confirm, and it lights on the same JS tick as `reserveTask`.
 *
 * The two guards below are read BEFORE calling `trigger()`. There is no TOCTOU
 * window because `reserveTask` is synchronous, so a concurrent trigger has
 * already flipped the flag by the time we look.
 *
 * @param onPullStart Fired on every pull, before any guard — the screens pass
 *   their collapsible-header `reveal()` so the status chrome is on screen even
 *   when the pull is a no-op.
 * @param onPullAccepted Fired only once the pull has cleared the offline +
 *   auth-paused guards — i.e. a sync really is going to run. The Feed tab hangs
 *   its force card-eviction sweep here so an offline pull can't wipe every card
 *   with no sync able to refill it.
 */
export function useFeedSyncRefresh(
    onPullStart?: () => void,
    onPullAccepted?: () => void,
): FeedSyncRefresh {
    const schedulerRunning = useFeedSyncRunning();
    const [userPulled, setUserPulled] = useState(false);

    // Release the spinner when the run this pull was waiting on ends. Keyed off
    // the scheduler flag rather than the trigger promise so a run that outlives
    // the promise (or was already in flight when the user pulled) still holds
    // the control down for its real duration.
    useEffect(() => {
        if (!schedulerRunning && userPulled) setUserPulled(false);
    }, [schedulerRunning, userPulled]);

    // Held in a ref so the RefreshControl's onRefresh identity is stable even if
    // a caller passes an inline closure.
    const onPullStartRef = useRef(onPullStart);
    onPullStartRef.current = onPullStart;

    // Same rationale as onPullStartRef — must not enter onRefresh's dep array.
    const onPullAcceptedRef = useRef(onPullAccepted);
    onPullAcceptedRef.current = onPullAccepted;

    const onRefresh = useCallback(() => {
        onPullStartRef.current?.();

        // `trigger()` deliberately bypasses `_conditionsMet`, so an offline pull
        // would enqueue and run a doomed job, fail it, and schedule a 30s retry
        // — pinning the spinner for the whole doomed attempt. Short-circuit to
        // the offline notice this component already renders.
        if (!useNetworkStore.getState().isConnected) {
            logger.info('[FeedSyncIndicator] pull-to-refresh skipped — offline');
            return;
        }

        // Companion mode. `trigger()` bypasses `_conditionsMet`, so the task's
        // own aiAccess condition does NOT cover this path — without the check
        // here, every pull would run a doomed sync that 402s. The companion
        // card pinned at the top of the list is the explanation; the spinner
        // has nothing to add.
        if (getAiAccess() === 'locked') {
            logger.info('[FeedSyncIndicator] pull-to-refresh skipped — companion mode');
            return;
        }

        // Paused means the auth-failure breaker took feed-sync offline. Spinning
        // silently would be a lie; the ReauthBanner mounted at the logged-in
        // layout root is the recovery path.
        if (AppScheduler.isPaused(FEED_SYNC_TASK)) {
            logger.info('[FeedSyncIndicator] pull-to-refresh skipped — feed-sync paused (auth breaker)');
            return;
        }

        // Past the guards, this pull owns the spinner until the run ends.
        setUserPulled(true);
        onPullAcceptedRef.current?.();

        // Already running: skip the trigger entirely — a sync genuinely is in
        // flight, so holding the control down is honest, and re-triggering
        // would be a no-op anyway (feed-sync is exclusive).
        if (useSchedulerStore.getState().isRunning(FEED_SYNC_TASK)) return;

        void AppScheduler.trigger(FEED_SYNC_TASK).catch((err: unknown) => {
            logger.captureException(err, {
                tags: { component: 'FeedSyncIndicator', method: 'pull-to-refresh' },
            });
        });
    }, []);

    return { refreshing: schedulerRunning && userPulled, onRefresh };
}

export interface FeedSyncIndicatorProps {
    /** Human relative label for the last finished run ("4 minutes ago"), shown
     *  in the expanded detail panel. The Dashboard already computes this for its
     *  header line against a 30s tick; the Feed tab omits it. */
    readonly lastProcessedLabel?: string | null;
}

/**
 * The header sync surface: an indeterminate status bar with an expandable detail
 * accordion (FeedStatusShimmer).
 *
 * The inline offline row that used to live here was removed: the global
 * OfflineBanner (mounted at the root layout) shows the same warning, in the same
 * style, at the same position, so the two stacked. It also covers /login and
 * /pin-lock, which this one never could. The `showConnectivityNotices` prop went
 * with it — its only purpose was hiding that row.
 *
 * Everything except `lastProcessedLabel` is self-subscribed, so mounting it is a
 * one-liner on either screen and the two can't drift.
 */
const FeedSyncIndicator: React.FC<FeedSyncIndicatorProps> = ({
    lastProcessedLabel = null,
}) => {
    const { t } = useTranslation();

    const schedulerRunning = useFeedSyncRunning();
    const isFeedProcessing = useIsFeedProcessing();

    const unscoredCount = useForYouUnscoredCount();
    const scoringError = useForYouScoringError();
    const dailyLimitResetAt = useForYouDailyLimitResetAt();
    const noisyDiscardedCount = useForYouNoisyDiscardedCount();
    const injectNoiseEnabled = useInjectNoise();
    const { articleCount, analysedCount, relevantCount } = useFeedCounts();

    // Evaluated at render rather than off a ticking clock — same trade-off
    // FeedStatusDetails already makes. The limit is sticky enough that the next
    // store-driven render clears it; hoisting a second 30s interval in here just
    // to flip a tint isn't worth the wakeups.
    const isDailyLimited = dailyLimitResetAt != null && Date.now() < dailyLimitResetAt;

    return (
        <>
            <FeedStatusShimmer
                processing={schedulerRunning || isFeedProcessing}
                error={scoringError !== null}
                dailyLimited={isDailyLimited}
                unscoredCount={unscoredCount}
                processedCount={articleCount}
                analysedCount={analysedCount}
                relevantCount={relevantCount}
                noiseRemovedCount={noisyDiscardedCount ?? 0}
                injectNoiseEnabled={injectNoiseEnabled}
                lastProcessedLabel={lastProcessedLabel}
            />
        </>
    );
};

export default FeedSyncIndicator;
