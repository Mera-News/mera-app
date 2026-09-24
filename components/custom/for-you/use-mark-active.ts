// Whether the Mera mark (Feed and Dashboard) grows and animates.
//
// Owner: it animates while the phone works AND while the server scores the
// reader's articles. In cloud mode the local phase is under 1.5s while 15+
// server batches run for minutes, so a local-only gate almost never showed
// the animation (captured). The narration keeps `useIsFeedProcessing`.
//
// One guard: a cloud batch that makes no progress (phase, counts and batch
// states all unchanged) for MARK_STALE_MS stops animating the mark, so a
// wedged batch never animates for the pipeline's whole stale window. Progress
// is observed here, from the store the pipeline already pushes to
// (`pushUiProgress`), because the store keeps no progress timestamp; the clock
// starts when this hook first sees the phase, so a batch restored from the
// persisted run after a relaunch gets one full window before it goes still.

import { useIsFeedWorkingLocally } from '@/components/custom/FeedSyncIndicator';
import {
    useForYouAsyncJobPhase,
    useForYouAsyncJobProcessedCount,
    useForYouAsyncJobTotalCount,
    useForYouChunkStates,
} from '@/lib/stores/selectors';
import { useEffect, useState } from 'react';

/** The scoring pipeline's own stale bound (BATCH_STALE_MS / STALE_RUN_GUARD_MS
 *  in lib/services/scoring-pipeline.ts, 15 min). Mirrored, not imported: that
 *  module reaches the database at import time, which no header should. */
export const MARK_STALE_MS = 15 * 60_000;

/** Hysteresis: once active, the mark stays active until "not active" has held
 *  this long. Captured: mid-run it shrank and regrew within ~0.8s in the gap
 *  between two server batches. Only going STILL is delayed, never starting. */
export const MARK_OFF_HOLD_MS = 2500;

export function useIsFeedMarkActive(): boolean {
    const local = useIsFeedWorkingLocally();
    const phase = useForYouAsyncJobPhase();
    const done = useForYouAsyncJobProcessedCount();
    const total = useForYouAsyncJobTotalCount();
    const chunks = useForYouChunkStates();

    // When the server side last moved. Re-stamped on any progress signal.
    const [lastProgressAt, setLastProgressAt] = useState(() => Date.now());
    useEffect(() => {
        setLastProgressAt(Date.now());
    }, [phase, done, total, chunks]);

    // Re-render once when the window runs out, so the mark goes still on its
    // own rather than at the next unrelated render.
    const [, setTick] = useState(0);
    useEffect(() => {
        if (phase === 'idle') return;
        const left = lastProgressAt + MARK_STALE_MS - Date.now();
        if (left <= 0) return;
        const id = setTimeout(() => setTick((n) => n + 1), left + 1);
        return () => clearTimeout(id);
    }, [phase, lastProgressAt]);

    const serverScoring = phase !== 'idle' && Date.now() - lastProgressAt < MARK_STALE_MS;
    const raw = local || serverScoring;

    // When `raw` last went false while the mark was active; null otherwise.
    const [offSince, setOffSince] = useState<number | null>(null);
    const [shown, setShown] = useState(raw);
    useEffect(() => {
        if (raw) {
            setShown(true);
            setOffSince(null);
        } else if (shown && offSince === null) {
            setOffSince(Date.now());
        }
    }, [raw, shown, offSince]);
    useEffect(() => {
        if (raw || offSince === null) return;
        const left = offSince + MARK_OFF_HOLD_MS - Date.now();
        if (left <= 0) {
            setShown(false);
            setOffSince(null);
            return;
        }
        const id = setTimeout(() => {
            setShown(false);
            setOffSince(null);
        }, left);
        return () => clearTimeout(id);
    }, [raw, offSince]);

    return raw || shown;
}
