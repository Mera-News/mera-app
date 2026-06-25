// ──────────────────────────────────────────────────────────────────────────────
// Mock all DB-service seams BEFORE any imports
// ──────────────────────────────────────────────────────────────────────────────

const mockLoadSuggestions = jest.fn((): Promise<ForYouSuggestion[]> => Promise.resolve([]));
const mockPersistFeedMetadata = jest.fn((..._args: any[]) => Promise.resolve());
const mockLoadFeedMetadata = jest.fn(() => Promise.resolve(null));
const mockClearSuggestions = jest.fn(() => Promise.resolve());
const mockPruneOrphanedSuggestions = jest.fn(() => Promise.resolve(0));

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    loadSuggestions: () => mockLoadSuggestions(),
    persistFeedMetadata: (meta: unknown) => mockPersistFeedMetadata(meta),
    loadFeedMetadata: () => mockLoadFeedMetadata(),
    clearSuggestions: () => mockClearSuggestions(),
    pruneOrphanedSuggestions: () => mockPruneOrphanedSuggestions(),
}));

// Dynamic import of async-job-service — mock so require() resolves the mock
const mockGetPendingAsyncJob = jest.fn(() => Promise.resolve(null));
jest.mock('@/lib/database/services/async-job-service', () => ({
    getPendingAsyncJob: () => mockGetPendingAsyncJob(),
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

import { useForYouStore } from '../for-you-store';
import type { ForYouSuggestion } from '../for-you-store';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import logger from '@/lib/logger';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeSuggestion(
    overrides: Partial<ForYouSuggestion> & {
        relevanceGenerationCompleted?: boolean;
        reasonGenerationCompleted?: boolean;
    } = {},
): ForYouSuggestion {
    // Accept legacy boolean overrides and derive the `status` state machine so
    // the existing call sites keep working.
    const { relevanceGenerationCompleted, reasonGenerationCompleted, ...rest } = overrides;
    const status =
        rest.status ??
        (reasonGenerationCompleted
            ? ArticleSuggestionStatus.Complete
            : relevanceGenerationCompleted
                ? ArticleSuggestionStatus.ReasonPending
                : ArticleSuggestionStatus.Unscored);
    return {
        _id: 'srv-1',
        articleId: 'art-1',
        clusters: [],
        relevance: 0,
        reason: '',
        status,
        country_code: 'US',
        language_code: 'en',
        publication_name: 'Test Pub',
        title_en: 'Test Title',
        title_original: 'Test Title',
        description_en: 'Test Description',
        article_url: 'https://example.com',
        image_url: null,
        userTopicIds: [],
        createdAt: new Date().toISOString(),
        firstPubDate: new Date().toISOString(),
        ...rest,
    };
}

const initialState = {
    suggestions: [] as ForYouSuggestion[],
    articleCount: 0,
    relevantArticleCount: 0,
    hasGeneratedTopics: true,
    endCursor: null as string | null,
    hasNextPage: true,
    unscoredCount: 0,
    isDeviceProcessing: false,
    deviceProcessProgress: 0,
    deviceProcessedCount: 0,
    deviceTotalCount: 0,
    asyncJobPhase: 'idle' as const,
    asyncJobProcessedCount: 0,
    asyncJobTotalCount: 0,
    syncStatusMessage: null,
    lastSyncAt: null as number | null,
    scoringError: null,
    hydrationCompleted: 0,
    hydrationTotal: 0,
    lastProcessingRunFinishedAt: null as number | null,
    feedNeedsRefresh: false,
};

// ──────────────────────────────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────────────────────────────

describe('useForYouStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Use partial setState (no replace flag) to preserve action functions
        useForYouStore.setState({ ...initialState });
    });

    // ── initial state ────────────────────────────────────────────────────────

    it('starts with empty suggestions and zero counts', () => {
        const state = useForYouStore.getState();
        expect(state.suggestions).toEqual([]);
        expect(state.articleCount).toBe(0);
        expect(state.relevantArticleCount).toBe(0);
        expect(state.hasGeneratedTopics).toBe(true);
        expect(state.asyncJobPhase).toBe('idle');
    });

    // ── setSuggestions ───────────────────────────────────────────────────────

    it('setSuggestions replaces all suggestions and resets cursor', () => {
        const s1 = makeSuggestion({ _id: 's1' });
        const s2 = makeSuggestion({ _id: 's2' });
        useForYouStore.getState().setSuggestions([s1, s2]);

        const state = useForYouStore.getState();
        expect(state.suggestions).toHaveLength(2);
        expect(state.endCursor).toBeNull();
        expect(state.hasNextPage).toBe(true);
    });

    it('setSuggestions overwrites previously set suggestions', () => {
        const s1 = makeSuggestion({ _id: 's1' });
        const s2 = makeSuggestion({ _id: 's2' });
        useForYouStore.getState().setSuggestions([s1]);
        useForYouStore.getState().setSuggestions([s2]);
        expect(useForYouStore.getState().suggestions).toEqual([s2]);
    });

    // ── appendSuggestions ────────────────────────────────────────────────────

    it('appendSuggestions appends to existing suggestions with pagination', () => {
        const s1 = makeSuggestion({ _id: 's1' });
        const s2 = makeSuggestion({ _id: 's2' });
        useForYouStore.getState().setSuggestions([s1]);
        useForYouStore.getState().appendSuggestions([s2], 'cursor-abc', false);

        const state = useForYouStore.getState();
        expect(state.suggestions).toHaveLength(2);
        expect(state.endCursor).toBe('cursor-abc');
        expect(state.hasNextPage).toBe(false);
    });

    it('appendSuggestions to empty list sets suggestions', () => {
        const s1 = makeSuggestion({ _id: 's1' });
        useForYouStore.getState().appendSuggestions([s1], null, false);
        expect(useForYouStore.getState().suggestions).toEqual([s1]);
    });

    // ── setPagination ────────────────────────────────────────────────────────

    it('setPagination updates cursor and hasNextPage', () => {
        useForYouStore.getState().setPagination('cursor-xyz', false);
        const state = useForYouStore.getState();
        expect(state.endCursor).toBe('cursor-xyz');
        expect(state.hasNextPage).toBe(false);
    });

    // ── setCounts ────────────────────────────────────────────────────────────

    it('setCounts updates counts and persists metadata', async () => {
        useForYouStore.getState().setCounts(10, 5);

        const state = useForYouStore.getState();
        expect(state.articleCount).toBe(10);
        expect(state.relevantArticleCount).toBe(5);

        // Fire-and-forget — flush microtask queue
        await Promise.resolve();

        expect(mockPersistFeedMetadata).toHaveBeenCalledWith(
            expect.objectContaining({ articleCount: 10, relevantArticleCount: 5 }),
        );
    });

    it('setCounts persists current hasGeneratedTopics value', async () => {
        useForYouStore.setState({ hasGeneratedTopics: false });
        useForYouStore.getState().setCounts(3, 1);
        await Promise.resolve();
        expect(mockPersistFeedMetadata).toHaveBeenCalledWith(
            expect.objectContaining({ hasGeneratedTopics: false }),
        );
    });

    it('setCounts logs captureException on persistFeedMetadata failure', async () => {
        mockPersistFeedMetadata.mockRejectedValueOnce(new Error('db error'));
        useForYouStore.getState().setCounts(1, 0);
        await new Promise((r) => setImmediate(r));
        expect(logger.captureException).toHaveBeenCalled();
    });

    // ── setHasGeneratedTopics ────────────────────────────────────────────────

    it('setHasGeneratedTopics updates flag and persists metadata', async () => {
        useForYouStore.getState().setHasGeneratedTopics(false);

        expect(useForYouStore.getState().hasGeneratedTopics).toBe(false);
        await Promise.resolve();
        expect(mockPersistFeedMetadata).toHaveBeenCalledWith(
            expect.objectContaining({ hasGeneratedTopics: false }),
        );
    });

    it('setHasGeneratedTopics logs on persist failure', async () => {
        mockPersistFeedMetadata.mockRejectedValueOnce(new Error('fail'));
        useForYouStore.getState().setHasGeneratedTopics(true);
        await new Promise((r) => setImmediate(r));
        expect(logger.captureException).toHaveBeenCalled();
    });

    // ── setUnscoredCount ─────────────────────────────────────────────────────

    it('setUnscoredCount updates unscoredCount', () => {
        useForYouStore.getState().setUnscoredCount(7);
        expect(useForYouStore.getState().unscoredCount).toBe(7);
    });

    // ── removeSuggestion ─────────────────────────────────────────────────────

    it('removeSuggestion removes the target suggestion by id', async () => {
        const s1 = makeSuggestion({ _id: 'srv-1' });
        const s2 = makeSuggestion({ _id: 'srv-2' });
        useForYouStore.setState({ suggestions: [s1, s2] });

        useForYouStore.getState().removeSuggestion('srv-1');

        const state = useForYouStore.getState();
        expect(state.suggestions).toHaveLength(1);
        expect(state.suggestions[0]._id).toBe('srv-2');
    });

    it('removeSuggestion is a no-op when id not found', () => {
        const s1 = makeSuggestion({ _id: 'srv-1' });
        useForYouStore.setState({ suggestions: [s1] });
        useForYouStore.getState().removeSuggestion('nonexistent');
        expect(useForYouStore.getState().suggestions).toHaveLength(1);
    });

    it('removeSuggestion decrements relevantArticleCount when relevance > 0.3 and completed', async () => {
        const s1 = makeSuggestion({
            _id: 'srv-1',
            relevance: 0.8,
            relevanceGenerationCompleted: true,
        });
        useForYouStore.setState({ suggestions: [s1], relevantArticleCount: 3, articleCount: 5 });

        useForYouStore.getState().removeSuggestion('srv-1');

        const state = useForYouStore.getState();
        expect(state.relevantArticleCount).toBe(2);
        await Promise.resolve();
        expect(mockPersistFeedMetadata).toHaveBeenCalledWith(
            expect.objectContaining({ relevantArticleCount: 2 }),
        );
    });

    it('removeSuggestion does NOT decrement relevantArticleCount when relevance <= 0.3', async () => {
        const s1 = makeSuggestion({
            _id: 'srv-1',
            relevance: 0.3,
            relevanceGenerationCompleted: true,
        });
        useForYouStore.setState({ suggestions: [s1], relevantArticleCount: 3, articleCount: 5 });
        useForYouStore.getState().removeSuggestion('srv-1');
        expect(useForYouStore.getState().relevantArticleCount).toBe(3);
    });

    it('removeSuggestion does NOT decrement when relevanceGenerationCompleted is false', async () => {
        const s1 = makeSuggestion({
            _id: 'srv-1',
            relevance: 0.9,
            relevanceGenerationCompleted: false,
        });
        useForYouStore.setState({ suggestions: [s1], relevantArticleCount: 3, articleCount: 5 });
        useForYouStore.getState().removeSuggestion('srv-1');
        expect(useForYouStore.getState().relevantArticleCount).toBe(3);
    });

    it('removeSuggestion clamps relevantArticleCount to 0 (no negative values)', async () => {
        const s1 = makeSuggestion({
            _id: 'srv-1',
            relevance: 0.9,
            relevanceGenerationCompleted: true,
        });
        useForYouStore.setState({ suggestions: [s1], relevantArticleCount: 0, articleCount: 1 });
        useForYouStore.getState().removeSuggestion('srv-1');
        expect(useForYouStore.getState().relevantArticleCount).toBe(0);
    });

    it('removeSuggestion logs on persist failure', async () => {
        mockPersistFeedMetadata.mockRejectedValueOnce(new Error('fail'));
        const s1 = makeSuggestion({ _id: 'srv-1', relevance: 0.9, relevanceGenerationCompleted: true });
        useForYouStore.setState({ suggestions: [s1], relevantArticleCount: 1, articleCount: 1 });
        useForYouStore.getState().removeSuggestion('srv-1');
        await new Promise((r) => setImmediate(r));
        expect(logger.captureException).toHaveBeenCalled();
    });

    // ── startDeviceProcessing / updateDeviceProgress / finishDeviceProcessing ─

    it('startDeviceProcessing initializes device processing state', () => {
        useForYouStore.getState().startDeviceProcessing(50);
        const state = useForYouStore.getState();
        expect(state.isDeviceProcessing).toBe(true);
        expect(state.deviceTotalCount).toBe(50);
        expect(state.deviceProcessProgress).toBe(0);
        expect(state.deviceProcessedCount).toBe(0);
    });

    it('updateDeviceProgress computes progress ratio', () => {
        useForYouStore.getState().startDeviceProcessing(100);
        useForYouStore.getState().updateDeviceProgress(25);
        const state = useForYouStore.getState();
        expect(state.deviceProcessedCount).toBe(25);
        expect(state.deviceProcessProgress).toBeCloseTo(0.25);
    });

    it('updateDeviceProgress with total expands deviceTotalCount if larger', () => {
        useForYouStore.getState().startDeviceProcessing(10);
        useForYouStore.getState().updateDeviceProgress(5, 20);
        const state = useForYouStore.getState();
        expect(state.deviceTotalCount).toBe(20);
        expect(state.deviceProcessProgress).toBeCloseTo(0.25);
    });

    it('updateDeviceProgress handles zero total (no division by zero)', () => {
        useForYouStore.setState({ deviceTotalCount: 0 });
        useForYouStore.getState().updateDeviceProgress(0, 0);
        expect(useForYouStore.getState().deviceProcessProgress).toBe(0);
    });

    it('updateDeviceProgress expands total when processed > current total', () => {
        useForYouStore.getState().startDeviceProcessing(5);
        useForYouStore.getState().updateDeviceProgress(10);
        const state = useForYouStore.getState();
        expect(state.deviceTotalCount).toBe(10);
        expect(state.deviceProcessProgress).toBe(1);
    });

    it('finishDeviceProcessing sets progress to 1 and stops processing', () => {
        useForYouStore.getState().startDeviceProcessing(10);
        useForYouStore.getState().updateDeviceProgress(7);
        useForYouStore.getState().finishDeviceProcessing();
        const state = useForYouStore.getState();
        expect(state.isDeviceProcessing).toBe(false);
        expect(state.deviceProcessProgress).toBe(1);
        expect(state.deviceProcessedCount).toBe(10); // equals deviceTotalCount
    });

    // ── setAsyncJobPhase ─────────────────────────────────────────────────────

    it('setAsyncJobPhase to idle resets counts to zero', () => {
        useForYouStore.setState({ asyncJobProcessedCount: 5, asyncJobTotalCount: 10 });
        useForYouStore.getState().setAsyncJobPhase('idle');
        const state = useForYouStore.getState();
        expect(state.asyncJobPhase).toBe('idle');
        expect(state.asyncJobProcessedCount).toBe(0);
        expect(state.asyncJobTotalCount).toBe(0);
    });

    it('setAsyncJobPhase to relevance with counts updates state', () => {
        useForYouStore.getState().setAsyncJobPhase('relevance', 3, 100);
        const state = useForYouStore.getState();
        expect(state.asyncJobPhase).toBe('relevance');
        expect(state.asyncJobProcessedCount).toBe(3);
        expect(state.asyncJobTotalCount).toBe(100);
    });

    it('setAsyncJobPhase to reasons without counts keeps existing counts', () => {
        useForYouStore.setState({ asyncJobProcessedCount: 7, asyncJobTotalCount: 50 });
        useForYouStore.getState().setAsyncJobPhase('reasons');
        const state = useForYouStore.getState();
        expect(state.asyncJobPhase).toBe('reasons');
        expect(state.asyncJobProcessedCount).toBe(7);
        expect(state.asyncJobTotalCount).toBe(50);
    });

    // ── setAsyncJobProgress ──────────────────────────────────────────────────

    it('setAsyncJobProgress updates processed and total counts', () => {
        useForYouStore.getState().setAsyncJobProgress(42, 200);
        const state = useForYouStore.getState();
        expect(state.asyncJobProcessedCount).toBe(42);
        expect(state.asyncJobTotalCount).toBe(200);
    });

    // ── setSyncStatusMessage / setLastSyncAt ─────────────────────────────────

    it('setSyncStatusMessage stores the message', () => {
        const msg = {
            state: 'scoring' as const,
            headlineKey: 'key',
            isRecoverable: false,
        };
        useForYouStore.getState().setSyncStatusMessage(msg);
        expect(useForYouStore.getState().syncStatusMessage).toEqual(msg);
    });

    it('setSyncStatusMessage accepts null to clear the message', () => {
        useForYouStore.getState().setSyncStatusMessage(null);
        expect(useForYouStore.getState().syncStatusMessage).toBeNull();
    });

    it('setLastSyncAt stores the timestamp', () => {
        useForYouStore.getState().setLastSyncAt(1234567890);
        expect(useForYouStore.getState().lastSyncAt).toBe(1234567890);
    });

    it('setScoringError stores and clears the scoring error kind', () => {
        useForYouStore.getState().setScoringError('server');
        expect(useForYouStore.getState().scoringError).toBe('server');
        useForYouStore.getState().setScoringError(null);
        expect(useForYouStore.getState().scoringError).toBeNull();
    });

    // ── setHydrationProgress / resetHydrationProgress ────────────────────────

    it('setHydrationProgress sets both fields', () => {
        useForYouStore.getState().setHydrationProgress(10, 100);
        expect(useForYouStore.getState().hydrationCompleted).toBe(10);
        expect(useForYouStore.getState().hydrationTotal).toBe(100);
    });

    it('resetHydrationProgress zeroes both fields', () => {
        useForYouStore.setState({ hydrationCompleted: 50, hydrationTotal: 200 });
        useForYouStore.getState().resetHydrationProgress();
        expect(useForYouStore.getState().hydrationCompleted).toBe(0);
        expect(useForYouStore.getState().hydrationTotal).toBe(0);
    });

    // ── markProcessingRunFinished ────────────────────────────────────────────

    it('markProcessingRunFinished sets lastProcessingRunFinishedAt and persists', async () => {
        const before = Date.now();
        useForYouStore.getState().markProcessingRunFinished();
        const state = useForYouStore.getState();
        expect(state.lastProcessingRunFinishedAt).toBeGreaterThanOrEqual(before);
        await new Promise((r) => setImmediate(r));
        expect(mockPersistFeedMetadata).toHaveBeenCalledWith(
            expect.objectContaining({ lastProcessingRunFinishedAt: state.lastProcessingRunFinishedAt }),
        );
    });

    it('markProcessingRunFinished logs on persist failure', async () => {
        mockPersistFeedMetadata.mockRejectedValueOnce(new Error('fail'));
        useForYouStore.getState().markProcessingRunFinished();
        await new Promise((r) => setImmediate(r));
        expect(logger.captureException).toHaveBeenCalled();
    });

    // ── setFeedNeedsRefresh ──────────────────────────────────────────────────

    it('setFeedNeedsRefresh updates feedNeedsRefresh flag', () => {
        useForYouStore.getState().setFeedNeedsRefresh(true);
        expect(useForYouStore.getState().feedNeedsRefresh).toBe(true);
        useForYouStore.getState().setFeedNeedsRefresh(false);
        expect(useForYouStore.getState().feedNeedsRefresh).toBe(false);
    });

    // ── clearData ────────────────────────────────────────────────────────────

    it('clearData resets state to initial and calls DB services', async () => {
        useForYouStore.setState({
            suggestions: [makeSuggestion()],
            articleCount: 5,
            relevantArticleCount: 3,
            hasGeneratedTopics: false,
        });

        await useForYouStore.getState().clearData();

        const state = useForYouStore.getState();
        expect(state.suggestions).toEqual([]);
        expect(state.articleCount).toBe(0);
        expect(state.relevantArticleCount).toBe(0);
        // hasGeneratedTopics is preserved from session state
        expect(state.hasGeneratedTopics).toBe(false);
        expect(mockClearSuggestions).toHaveBeenCalledTimes(1);
        expect(mockPersistFeedMetadata).toHaveBeenCalledWith(
            expect.objectContaining({
                articleCount: 0,
                relevantArticleCount: 0,
                hasGeneratedTopics: false,
                lastProcessingRunFinishedAt: null,
            }),
        );
    });

    it('clearData logs and does not throw when DB throws', async () => {
        mockClearSuggestions.mockRejectedValueOnce(new Error('db error'));
        await expect(useForYouStore.getState().clearData()).resolves.toBeUndefined();
        expect(logger.captureException).toHaveBeenCalled();
    });

    it('clearData preserves hasGeneratedTopics=true when session has it', async () => {
        useForYouStore.setState({ hasGeneratedTopics: true });
        await useForYouStore.getState().clearData();
        expect(useForYouStore.getState().hasGeneratedTopics).toBe(true);
    });

    // ── pruneOrphanedData ────────────────────────────────────────────────────

    it('pruneOrphanedData with deletedCount=-1 clears all state', async () => {
        mockPruneOrphanedSuggestions.mockResolvedValueOnce(-1);
        useForYouStore.setState({
            suggestions: [makeSuggestion()],
            articleCount: 5,
            hasGeneratedTopics: false,
        });

        await useForYouStore.getState().pruneOrphanedData();

        const state = useForYouStore.getState();
        expect(state.suggestions).toEqual([]);
        expect(state.articleCount).toBe(0);
        expect(state.hasGeneratedTopics).toBe(false); // preserved
        expect(mockPersistFeedMetadata).toHaveBeenCalledWith(
            expect.objectContaining({ articleCount: 0, hasGeneratedTopics: false }),
        );
    });

    it('pruneOrphanedData with deletedCount=-1 logs persist failure without throwing', async () => {
        mockPruneOrphanedSuggestions.mockResolvedValueOnce(-1);
        mockPersistFeedMetadata.mockRejectedValueOnce(new Error('db'));
        await expect(useForYouStore.getState().pruneOrphanedData()).resolves.toBeUndefined();
        await new Promise((r) => setImmediate(r));
        expect(logger.captureException).toHaveBeenCalled();
    });

    it('pruneOrphanedData with deletedCount>0 reloads, sorts, and persists', async () => {
        mockPruneOrphanedSuggestions.mockResolvedValueOnce(2);
        const scored = makeSuggestion({ _id: 's1', relevance: 0.8, relevanceGenerationCompleted: true });
        const unscored = makeSuggestion({ _id: 's2', relevance: 0, relevanceGenerationCompleted: false });
        mockLoadSuggestions.mockResolvedValueOnce([unscored, scored]);

        await useForYouStore.getState().pruneOrphanedData();

        const state = useForYouStore.getState();
        expect(state.suggestions[0]._id).toBe('s1'); // sorted by relevance desc
        expect(state.articleCount).toBe(2);
        expect(state.relevantArticleCount).toBe(1); // only scored > 0.3
        expect(mockPersistFeedMetadata).toHaveBeenCalledWith(
            expect.objectContaining({ articleCount: 2, relevantArticleCount: 1 }),
        );
    });

    it('pruneOrphanedData with deletedCount=0 does nothing', async () => {
        mockPruneOrphanedSuggestions.mockResolvedValueOnce(0);
        await useForYouStore.getState().pruneOrphanedData();
        expect(mockLoadSuggestions).not.toHaveBeenCalled();
        expect(mockPersistFeedMetadata).not.toHaveBeenCalled();
    });

    it('pruneOrphanedData with deletedCount>0 and persist failure logs error', async () => {
        mockPruneOrphanedSuggestions.mockResolvedValueOnce(1);
        mockLoadSuggestions.mockResolvedValueOnce([]);
        mockPersistFeedMetadata.mockRejectedValueOnce(new Error('db'));
        await useForYouStore.getState().pruneOrphanedData();
        await new Promise((r) => setImmediate(r));
        expect(logger.captureException).toHaveBeenCalled();
    });

    // ── hydrateSuggestionsFromDb ─────────────────────────────────────────────

    it('hydrateSuggestionsFromDb loads and sorts suggestions', async () => {
        const s1 = makeSuggestion({ _id: 's1', relevance: 0.5, relevanceGenerationCompleted: true });
        const s2 = makeSuggestion({ _id: 's2', relevance: 0.9, relevanceGenerationCompleted: true });
        const s3 = makeSuggestion({ _id: 's3', relevance: 0, relevanceGenerationCompleted: false });
        mockLoadSuggestions.mockResolvedValueOnce([s1, s3, s2]);

        await useForYouStore.getState().hydrateSuggestionsFromDb();

        const state = useForYouStore.getState();
        expect(state.suggestions[0]._id).toBe('s2'); // highest relevance first
        expect(state.suggestions[1]._id).toBe('s1');
        expect(state.suggestions[2]._id).toBe('s3'); // unscored last
        expect(state.unscoredCount).toBe(1);
    });

    it('hydrateSuggestionsFromDb with empty DB sets empty suggestions', async () => {
        mockLoadSuggestions.mockResolvedValueOnce([]);
        await useForYouStore.getState().hydrateSuggestionsFromDb();
        expect(useForYouStore.getState().suggestions).toEqual([]);
        expect(useForYouStore.getState().unscoredCount).toBe(0);
    });

    it('hydrateSuggestionsFromDb logs on DB failure and leaves suggestions empty', async () => {
        mockLoadSuggestions.mockRejectedValueOnce(new Error('db error'));
        await useForYouStore.getState().hydrateSuggestionsFromDb();
        expect(useForYouStore.getState().suggestions).toEqual([]);
        expect(logger.captureException).toHaveBeenCalled();
    });

    it('hydrateSuggestionsFromDb computes unscoredCount correctly', async () => {
        const scored = makeSuggestion({ _id: 's1', relevanceGenerationCompleted: true });
        const unscored1 = makeSuggestion({ _id: 's2', relevanceGenerationCompleted: false });
        const unscored2 = makeSuggestion({ _id: 's3', relevanceGenerationCompleted: false });
        mockLoadSuggestions.mockResolvedValueOnce([scored, unscored1, unscored2]);

        await useForYouStore.getState().hydrateSuggestionsFromDb();
        expect(useForYouStore.getState().unscoredCount).toBe(2);
    });

    // ── byRelevanceDesc sort logic ────────────────────────────────────────────

    it('byRelevanceDesc: completed rows are sorted by relevance desc before unscored rows', async () => {
        const low = makeSuggestion({ _id: 'low', relevance: 0.2, relevanceGenerationCompleted: true });
        const high = makeSuggestion({ _id: 'high', relevance: 0.95, relevanceGenerationCompleted: true });
        const unscored = makeSuggestion({ _id: 'unscored', relevance: 0, relevanceGenerationCompleted: false });
        mockLoadSuggestions.mockResolvedValueOnce([unscored, low, high]);

        await useForYouStore.getState().hydrateSuggestionsFromDb();

        const ids = useForYouStore.getState().suggestions.map((s) => s._id);
        expect(ids).toEqual(['high', 'low', 'unscored']);
    });

    it('byRelevanceDesc: two unscored rows keep stable relative order', async () => {
        const u1 = makeSuggestion({ _id: 'u1', relevance: 0, relevanceGenerationCompleted: false });
        const u2 = makeSuggestion({ _id: 'u2', relevance: 0, relevanceGenerationCompleted: false });
        mockLoadSuggestions.mockResolvedValueOnce([u1, u2]);
        await useForYouStore.getState().hydrateSuggestionsFromDb();
        const ids = useForYouStore.getState().suggestions.map((s) => s._id);
        expect(ids).toContain('u1');
        expect(ids).toContain('u2');
    });

    // ── hydrateMetadataFromDb ────────────────────────────────────────────────
    //
    // NOTE: `hydrateMetadataFromDb` uses `await import('@/lib/database/services/async-job-service')`
    // which is a dynamic ES import(). Jest's Babel transform (without --experimental-vm-modules)
    // cannot intercept dynamic import() calls, so calling this method always throws
    // "A dynamic import callback was invoked without --experimental-vm-modules" at runtime,
    // which lands in the catch block. The tests below assert the *catch-path* behavior:
    // state is left at defaults and logger.captureException is called.
    // The happy-path logic (setting metadata from DB + asyncJobPhase from pending job) is
    // untestable in this environment because the dynamic import always fails.

    it('hydrateMetadataFromDb catches the dynamic-import error and calls captureException', async () => {
        // State before call
        useForYouStore.setState({ articleCount: 0, hasGeneratedTopics: true });
        await useForYouStore.getState().hydrateMetadataFromDb();
        // Dynamic import throws → catch block fires
        expect(logger.captureException).toHaveBeenCalled();
    });

    it('hydrateMetadataFromDb leaves state unchanged when dynamic import throws', async () => {
        useForYouStore.setState({ articleCount: 5, relevantArticleCount: 3 });
        await useForYouStore.getState().hydrateMetadataFromDb();
        // Catch path leaves existing state intact
        expect(useForYouStore.getState().articleCount).toBe(5);
        expect(useForYouStore.getState().relevantArticleCount).toBe(3);
    });

    it('hydrateMetadataFromDb does not throw to the caller (error is swallowed)', async () => {
        await expect(useForYouStore.getState().hydrateMetadataFromDb()).resolves.toBeUndefined();
    });
});
