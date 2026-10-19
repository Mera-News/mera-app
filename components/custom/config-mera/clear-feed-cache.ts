// Clears the on-device feed cache (every article suggestion, its fact links and
// the feed's counts) and starts a fresh sync. Facts, topics and settings stay.
//
// The order is load-bearing:
// - clearData first: it deletes the suggestion rows and resets the For You store.
// - the persisted feed order points at the deleted rows, so it is reset.
// - the scoring run is aborted AFTER clearData (clearData nulls the finished stamp the
//   abort writes) and BEFORE the sync, or its orphaned batches keep the pipeline
//   reading 'running' and every feed sync bails (the clear-feed deadlock).
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import * as scoringPipeline from '@/lib/services/scoring-pipeline';
import { useForYouStore } from '@/lib/stores';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';

export async function clearFeedCacheAndResync(): Promise<void> {
    await useForYouStore.getState().clearData();
    useFeedOrderStore.getState().reset();
    await scoringPipeline.abortRun('cache-clear');
    if (!useSchedulerStore.getState().isRunning('feed-sync')) {
        void AppScheduler.trigger('feed-sync');
    }
}
