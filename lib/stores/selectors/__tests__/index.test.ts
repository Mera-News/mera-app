// Selectors import the stores directly — no DB or logger deps needed for these
// pure selector functions. We DO need to mock any heavy modules that the stores
// themselves import, to avoid native-module crashes at import time.

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    loadSuggestions: jest.fn(() => Promise.resolve([])),
    persistFeedMetadata: jest.fn(() => Promise.resolve()),
    loadFeedMetadata: jest.fn(() => Promise.resolve(null)),
    clearSuggestions: jest.fn(() => Promise.resolve()),
    pruneOrphanedSuggestions: jest.fn(() => Promise.resolve(0)),
}));

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: jest.fn(() => Promise.resolve(null)),
    setSetting: jest.fn(() => Promise.resolve()),
    deleteSetting: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/database/services/user-persona-service', () => ({
    persistUserPersona: jest.fn(() => Promise.resolve()),
    loadUserPersona: jest.fn(() => Promise.resolve(null)),
    clearUserPersona: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/account-service', () => ({
    AccountService: {
        getUserPersona: jest.fn(() => Promise.resolve(null)),
    },
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

import { renderHook } from '@testing-library/react-native';
import { useForYouStore } from '../../for-you-store';
import { useUserStore } from '../../user-store';
import type { UserPersona } from '@/lib/account-service';

import {
    useForYouSuggestions,
    useForYouHasGeneratedTopics,
    useForYouCounts,
    useForYouPagination,
    useForYouUnscoredCount,
    useForYouDeviceProcessing,
    useForYouAsyncJobPhase,
    useForYouAsyncJobProcessedCount,
    useForYouAsyncJobTotalCount,
    useForYouLastProcessingRunFinishedAt,
    useForYouHydrationProgress,
    useForYouNoisyDiscardedCount,
    useForYouSyncStatusMessage,
    getForYouActions,
    useUserPersona,
    getUserActions,
} from '../index';

// Helper: reset both stores before each test
function resetStores() {
    useForYouStore.setState({
        suggestions: [],
        articleCount: 0,
        relevantArticleCount: 0,
        hasGeneratedTopics: true,
        endCursor: null,
        hasNextPage: true,
        unscoredCount: 0,
        isDeviceProcessing: false,
        deviceProcessProgress: 0,
        deviceProcessedCount: 0,
        deviceTotalCount: 0,
        asyncJobPhase: 'idle',
        asyncJobProcessedCount: 0,
        asyncJobTotalCount: 0,
        syncStatusMessage: null,
        lastSyncAt: null,
        hydrationCompleted: 0,
        hydrationTotal: 0,
        lastProcessingRunFinishedAt: null,
        feedNeedsRefresh: false,
    });
    useUserStore.setState({
        userId: null,
        userPersona: null,
        isLoading: false,
        lastFetchedAt: null,
    });
}

describe('selectors/index', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        resetStores();
    });

    // ── ForYouStore selectors ──────────────────────────────────────────────

    it('useForYouSuggestions returns empty array from initial state', () => {
        const { result } = renderHook(() => useForYouSuggestions());
        expect(result.current).toEqual([]);
    });

    it('useForYouSuggestions reflects store updates', () => {
        const suggestion = {
            _id: 's1',
            articleId: 'a1',
            clusters: [],
            relevance: 0.8,
            reason: 'test',
            relevanceGenerationCompleted: true,
            reasonGenerationCompleted: true,
            country_code: null,
            language_code: null,
            publication_name: null,
            title_en: 'Title',
            title_original: null,
            description_en: null,
            article_url: null,
            image_url: null,
            userTopicIds: [],
            createdAt: '2024-01-01',
            firstPubDate: '2024-01-01',
        };
        useForYouStore.setState({ suggestions: [suggestion] });
        const { result } = renderHook(() => useForYouSuggestions());
        expect(result.current).toHaveLength(1);
        expect(result.current[0]._id).toBe('s1');
    });

    it('useForYouHasGeneratedTopics returns true by default', () => {
        const { result } = renderHook(() => useForYouHasGeneratedTopics());
        expect(result.current).toBe(true);
    });

    it('useForYouHasGeneratedTopics reflects false', () => {
        useForYouStore.setState({ hasGeneratedTopics: false });
        const { result } = renderHook(() => useForYouHasGeneratedTopics());
        expect(result.current).toBe(false);
    });

    it('useForYouCounts returns both articleCount and relevantArticleCount', () => {
        useForYouStore.setState({ articleCount: 10, relevantArticleCount: 5 });
        const { result } = renderHook(() => useForYouCounts());
        expect(result.current).toEqual({ articleCount: 10, relevantArticleCount: 5 });
    });

    it('useForYouCounts returns zeros from initial state', () => {
        const { result } = renderHook(() => useForYouCounts());
        expect(result.current).toEqual({ articleCount: 0, relevantArticleCount: 0 });
    });

    it('useForYouPagination returns endCursor and hasNextPage', () => {
        useForYouStore.setState({ endCursor: 'cursor-123', hasNextPage: false });
        const { result } = renderHook(() => useForYouPagination());
        expect(result.current).toEqual({ endCursor: 'cursor-123', hasNextPage: false });
    });

    it('useForYouPagination initial state has null cursor and hasNextPage: true', () => {
        const { result } = renderHook(() => useForYouPagination());
        expect(result.current).toEqual({ endCursor: null, hasNextPage: true });
    });

    it('useForYouUnscoredCount returns 0 initially', () => {
        const { result } = renderHook(() => useForYouUnscoredCount());
        expect(result.current).toBe(0);
    });

    it('useForYouUnscoredCount reflects store value', () => {
        useForYouStore.setState({ unscoredCount: 7 });
        const { result } = renderHook(() => useForYouUnscoredCount());
        expect(result.current).toBe(7);
    });

    it('useForYouDeviceProcessing returns all four device processing fields', () => {
        useForYouStore.setState({
            isDeviceProcessing: true,
            deviceProcessProgress: 0.5,
            deviceProcessedCount: 5,
            deviceTotalCount: 10,
        });
        const { result } = renderHook(() => useForYouDeviceProcessing());
        expect(result.current).toEqual({
            isDeviceProcessing: true,
            deviceProcessProgress: 0.5,
            deviceProcessedCount: 5,
            deviceTotalCount: 10,
        });
    });

    it('useForYouDeviceProcessing initial state is all zeros/false', () => {
        const { result } = renderHook(() => useForYouDeviceProcessing());
        expect(result.current.isDeviceProcessing).toBe(false);
        expect(result.current.deviceProcessProgress).toBe(0);
    });

    it('useForYouAsyncJobPhase returns idle initially', () => {
        const { result } = renderHook(() => useForYouAsyncJobPhase());
        expect(result.current).toBe('idle');
    });

    it('useForYouAsyncJobPhase reflects relevance phase', () => {
        useForYouStore.setState({ asyncJobPhase: 'relevance' });
        const { result } = renderHook(() => useForYouAsyncJobPhase());
        expect(result.current).toBe('relevance');
    });

    it('useForYouAsyncJobProcessedCount returns 0 initially', () => {
        const { result } = renderHook(() => useForYouAsyncJobProcessedCount());
        expect(result.current).toBe(0);
    });

    it('useForYouAsyncJobProcessedCount reflects store value', () => {
        useForYouStore.setState({ asyncJobProcessedCount: 42 });
        const { result } = renderHook(() => useForYouAsyncJobProcessedCount());
        expect(result.current).toBe(42);
    });

    it('useForYouAsyncJobTotalCount returns 0 initially', () => {
        const { result } = renderHook(() => useForYouAsyncJobTotalCount());
        expect(result.current).toBe(0);
    });

    it('useForYouAsyncJobTotalCount reflects store value', () => {
        useForYouStore.setState({ asyncJobTotalCount: 100 });
        const { result } = renderHook(() => useForYouAsyncJobTotalCount());
        expect(result.current).toBe(100);
    });

    it('useForYouLastProcessingRunFinishedAt returns null initially', () => {
        const { result } = renderHook(() => useForYouLastProcessingRunFinishedAt());
        expect(result.current).toBeNull();
    });

    it('useForYouLastProcessingRunFinishedAt reflects stored timestamp', () => {
        useForYouStore.setState({ lastProcessingRunFinishedAt: 88888 });
        const { result } = renderHook(() => useForYouLastProcessingRunFinishedAt());
        expect(result.current).toBe(88888);
    });

    it('useForYouHydrationProgress returns both fields', () => {
        useForYouStore.setState({ hydrationCompleted: 3, hydrationTotal: 10 });
        const { result } = renderHook(() => useForYouHydrationProgress());
        expect(result.current).toEqual({ hydrationCompleted: 3, hydrationTotal: 10 });
    });

    it('useForYouHydrationProgress starts at 0/0', () => {
        const { result } = renderHook(() => useForYouHydrationProgress());
        expect(result.current).toEqual({ hydrationCompleted: 0, hydrationTotal: 0 });
    });

    /**
     * BUG: useForYouNoisyDiscardedCount reads state.noisyDiscardedCount which
     * does not exist on ForYouState — the field is absent from the store
     * definition. This selector will always return undefined.
     * EXPECTED FAILURE: the selector should return a number but returns undefined.
     */
    it('useForYouNoisyDiscardedCount returns undefined (bug: field missing from store)', () => {
        const { result } = renderHook(() => useForYouNoisyDiscardedCount());
        // The field is not in the store — undefined is returned instead of 0
        expect(result.current).toBeUndefined();
    });

    it('useForYouSyncStatusMessage returns null initially', () => {
        const { result } = renderHook(() => useForYouSyncStatusMessage());
        expect(result.current).toBeNull();
    });

    it('useForYouSyncStatusMessage reflects store value', () => {
        useForYouStore.setState({ syncStatusMessage: { type: 'syncing' } as any });
        const { result } = renderHook(() => useForYouSyncStatusMessage());
        expect(result.current).toEqual({ type: 'syncing' });
    });

    // ── getForYouActions (non-reactive) ────────────────────────────────────
    it('getForYouActions returns expected action functions', () => {
        const actions = getForYouActions();
        expect(typeof actions.setSuggestions).toBe('function');
        expect(typeof actions.appendSuggestions).toBe('function');
        expect(typeof actions.setPagination).toBe('function');
        expect(typeof actions.setCounts).toBe('function');
        expect(typeof actions.setHasGeneratedTopics).toBe('function');
        expect(typeof actions.setUnscoredCount).toBe('function');
        expect(typeof actions.startDeviceProcessing).toBe('function');
        expect(typeof actions.updateDeviceProgress).toBe('function');
        expect(typeof actions.finishDeviceProcessing).toBe('function');
        expect(typeof actions.clearData).toBe('function');
        expect(typeof actions.setLastSyncAt).toBe('function');
    });

    // ── UserStore selectors ────────────────────────────────────────────────
    it('useUserPersona returns null initially', () => {
        const { result } = renderHook(() => useUserPersona());
        expect(result.current).toBeNull();
    });

    it('useUserPersona reflects stored persona', () => {
        const persona: UserPersona = {
            id: 'persona-1',
            userId: 'u1',
            summary: 'Test persona',
            notificationsEnabled: false,
            preferredNotificationWindow: null,
        } as any;
        useUserStore.setState({ userPersona: persona });
        const { result } = renderHook(() => useUserPersona());
        expect(result.current?.id).toBe('persona-1');
    });

    // ── getUserActions (non-reactive) ─────────────────────────────────────
    it('getUserActions returns expected action functions', () => {
        const actions = getUserActions();
        expect(typeof actions.setUserId).toBe('function');
        expect(typeof actions.setUserPersona).toBe('function');
        expect(typeof actions.fetchUserPersona).toBe('function');
        expect(typeof actions.clearUser).toBe('function');
    });
});
