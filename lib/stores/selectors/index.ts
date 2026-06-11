import { useShallow } from 'zustand/react/shallow';
import { useForYouStore } from '../for-you-store';
import { useUserStore } from '../user-store';

/**
 * Optimized selectors for Zustand stores
 *
 * These selectors use shallow equality comparison to prevent unnecessary re-renders
 * when subscribing to multiple state properties.
 *
 * Usage patterns:
 * 1. For single primitive values: use direct selector (no shallow needed)
 *    const suggestions = useForYouStore(state => state.suggestions);
 *
 * 2. For multiple values: use shallow equality
 *    const { endCursor, hasNextPage } = useForYouPagination();
 *
 * 3. For actions: use getState() to avoid re-renders
 *    const actions = useForYouStore.getState();
 *    actions.setSuggestions(data);
 */

// ============================================
// ForYouStore Selectors
// ============================================

/** Get suggestions array (reactive) */
export const useForYouSuggestions = () =>
    useForYouStore((state) => state.suggestions);

/** Get hasGeneratedTopics flag (reactive) */
export const useForYouHasGeneratedTopics = () =>
    useForYouStore((state) => state.hasGeneratedTopics);

/** Get article counts (reactive, shallow equality) */
export const useForYouCounts = () =>
    useForYouStore(
        useShallow((state) => ({
            articleCount: state.articleCount,
            relevantArticleCount: state.relevantArticleCount,
        }))
    );

/** Get pagination state (reactive, shallow equality) */
export const useForYouPagination = () =>
    useForYouStore(
        useShallow((state) => ({
            endCursor: state.endCursor,
            hasNextPage: state.hasNextPage,
        }))
    );

/** Get unscored count for mera protocol (reactive) */
export const useForYouUnscoredCount = () =>
    useForYouStore((state) => state.unscoredCount);

/** Get device processing state for mera protocol (reactive, shallow equality) */
export const useForYouDeviceProcessing = () =>
    useForYouStore(
        useShallow((state) => ({
            isDeviceProcessing: state.isDeviceProcessing,
            deviceProcessProgress: state.deviceProcessProgress,
            deviceProcessedCount: state.deviceProcessedCount,
            deviceTotalCount: state.deviceTotalCount,
        }))
    );

/** Reactive selector for the cloud async-inference phase
 *  ('idle' | 'relevance' | 'reasons'). */
export const useForYouAsyncJobPhase = () =>
    useForYouStore((state) => state.asyncJobPhase);

/** Cumulative number of synced ids the sweep has finished processing
 *  (monotonic across batches). Drives the numerator of the
 *  "Sifting through X/Y" spinner text. */
export const useForYouAsyncJobProcessedCount = () =>
    useForYouStore((state) => state.asyncJobProcessedCount);

/** Total synced ids in the current server snapshot. Drives the denominator
 *  of the "Sifting through X/Y" spinner text. */
export const useForYouAsyncJobTotalCount = () =>
    useForYouStore((state) => state.asyncJobTotalCount);

/** Epoch ms of the last finished processing run (cloud or on-device).
 *  null when no run has ever finished on this device. */
export const useForYouLastProcessingRunFinishedAt = () =>
    useForYouStore((state) => state.lastProcessingRunFinishedAt);

/** Hydration progress for syncFeed's id-by-id chunked fetch
 *  (article-suggestion records pulled from the server). Drives the
 *  per-chunk progress bar in the For You header. Both fields are 0
 *  when no hydration is in flight. */
export const useForYouHydrationProgress = () =>
    useForYouStore(
        useShallow((state) => ({
            hydrationCompleted: state.hydrationCompleted,
            hydrationTotal: state.hydrationTotal,
        })),
    );

/** Number of article_suggestions discarded as pure-noise in the latest sync.
 *  Drives the "X decoy articles filtered out" line on the ForYou header. */
export const useForYouNoisyDiscardedCount = () =>
    useForYouStore((state) => (state as { noisyDiscardedCount?: number }).noisyDiscardedCount);

/** Get sync status message (reactive) */
export const useForYouSyncStatusMessage = () =>
    useForYouStore((s) => s.syncStatusMessage);

/** Get all ForYouStore actions (non-reactive, stable references) */
export const getForYouActions = () => {
    const state = useForYouStore.getState();
    return {
        setSuggestions: state.setSuggestions,
        appendSuggestions: state.appendSuggestions,
        setPagination: state.setPagination,
        setCounts: state.setCounts,
        setHasGeneratedTopics: state.setHasGeneratedTopics,
        setUnscoredCount: state.setUnscoredCount,
        startDeviceProcessing: state.startDeviceProcessing,
        updateDeviceProgress: state.updateDeviceProgress,
        finishDeviceProcessing: state.finishDeviceProcessing,
        clearData: state.clearData,
        setLastSyncAt: state.setLastSyncAt,
    };
};

// ============================================
// UserStore Selectors
// ============================================

/** Get user persona (reactive) */
export const useUserPersona = () =>
    useUserStore((state) => state.userPersona);

/** Get all UserStore actions (non-reactive, stable references) */
export const getUserActions = () => {
    const state = useUserStore.getState();
    return {
        setUserId: state.setUserId,
        setUserPersona: state.setUserPersona,
        fetchUserPersona: state.fetchUserPersona,
        clearUser: state.clearUser,
    };
};
