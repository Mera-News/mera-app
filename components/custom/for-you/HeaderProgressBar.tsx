import type { FeedSyncState, SyncStatusMessage } from '@/lib/scheduler/feed-sync/feed-sync-types';
import MultiStepProgressBar from '@/components/custom/MultiStepProgressBar';
import React, { useRef, useMemo } from 'react';
import { View } from 'react-native';

// The five stages that map 1-to-1 with FeedSyncState pipeline steps.
const SYNC_STAGES: FeedSyncState[] = [
    'fetching-topic-ids',
    'diffing',
    'hydrating',
    'persisting',
    'scoring',
];

const TRACK = 'bg-lime-100/20 h-[2px]';
const FILL_OK = 'bg-green-800 h-[2px]';
const FILL_ERR = 'bg-red-500 h-[2px]';
const FILL_PAUSE = 'bg-amber-500 h-[2px]';

interface HeaderProgressBarProps {
    syncStatusMessage: SyncStatusMessage | null;
    /** True during the 2-second "done" flash after sync completes and
     *  syncStatusMessage has already been cleared to null. Shows the fully
     *  green bar during that window. */
    isDoneFlash?: boolean;
}

const HeaderProgressBar: React.FC<HeaderProgressBarProps> = ({
    syncStatusMessage,
    isDoneFlash = false,
}) => {
    // Tracks the last active stage so paused-offline can freeze on the
    // correct segment without requiring a separate store field.
    const lastActiveRef = useRef<FeedSyncState | null>(null);

    const state = syncStatusMessage?.state ?? 'idle';

    const isActive =
        state !== 'idle' &&
        state !== 'done' &&
        state !== 'failed' &&
        state !== 'paused-offline';
    if (isActive) lastActiveRef.current = state;

    const { currentStage, stageValue, fillClassNames } = useMemo(() => {
        // Done or 2s post-done flash — all segments green
        if (state === 'done' || isDoneFlash) {
            return {
                currentStage: SYNC_STAGES.length,
                stageValue: 0,
                fillClassNames: SYNC_STAGES.map(() => FILL_OK),
            };
        }

        // Failed — segments before failedAtState are green, failedAtState is red
        if (state === 'failed') {
            const failedAt = syncStatusMessage?.failedAtState;
            const failedIdx = failedAt ? SYNC_STAGES.indexOf(failedAt) : -1;
            const safeIdx = failedIdx >= 0 ? failedIdx : SYNC_STAGES.length - 1;
            return {
                currentStage: safeIdx,
                stageValue: 100,
                fillClassNames: SYNC_STAGES.map((_, i) =>
                    i === safeIdx ? FILL_ERR : FILL_OK,
                ),
            };
        }

        // Paused — freeze on the last active stage in amber
        if (state === 'paused-offline') {
            const pausedAt = syncStatusMessage?.pausedAtState ?? lastActiveRef.current;
            const pausedIdx = pausedAt ? SYNC_STAGES.indexOf(pausedAt) : 0;
            const safeIdx = Math.max(0, pausedIdx >= 0 ? pausedIdx : 0);
            return {
                currentStage: safeIdx,
                stageValue: 30,
                fillClassNames: SYNC_STAGES.map((_, i) =>
                    i === safeIdx ? FILL_PAUSE : FILL_OK,
                ),
            };
        }

        // Active stage — current segment at partial fill, prior segments full
        const stageIdx = SYNC_STAGES.indexOf(state as FeedSyncState);
        if (stageIdx < 0) {
            return { currentStage: 0, stageValue: 0, fillClassNames: SYNC_STAGES.map(() => FILL_OK) };
        }

        let sv = 50;
        if (state === 'hydrating' && syncStatusMessage?.progress) {
            const { current, total } = syncStatusMessage.progress;
            sv = total > 0 ? Math.round((current / total) * 100) : 50;
        }

        return {
            currentStage: stageIdx,
            stageValue: sv,
            fillClassNames: SYNC_STAGES.map(() => FILL_OK),
        };
    }, [state, syncStatusMessage, isDoneFlash]);

    if (state === 'idle' && !isDoneFlash) return null;

    return (
        <View
            pointerEvents="box-none"
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
        >
            <MultiStepProgressBar
                totalStages={SYNC_STAGES.length}
                currentStage={currentStage}
                stageValue={stageValue}
                progressClassName={TRACK}
                progressFilledClassName={FILL_OK}
                progressFilledClassNames={fillClassNames}
            />
        </View>
    );
};

export default HeaderProgressBar;
