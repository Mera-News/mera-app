// Owner (reversing "still during wait"): the Mera mark animates while the
// SERVER is scoring the reader's articles too, since in cloud mode the local
// phase lasts under 1.5s and the server batches run for minutes. One guard: a
// batch that has sat without progress past MARK_STALE_MS (the pipeline's own
// 15-minute stale bound) must not keep the mark animating.

import { act, renderHook } from '@testing-library/react-native';

let mockLocal = false;
let mockPhase: 'idle' | 'relevance' | 'reasons' = 'idle';
let mockDone = 0;
let mockTotal = 0;
let mockChunks: unknown = null;
jest.mock('@/components/custom/FeedSyncIndicator', () => ({
    useIsFeedWorkingLocally: () => mockLocal,
}));
jest.mock('@/lib/stores/selectors', () => ({
    useForYouAsyncJobPhase: () => mockPhase,
    useForYouAsyncJobProcessedCount: () => mockDone,
    useForYouAsyncJobTotalCount: () => mockTotal,
    useForYouChunkStates: () => mockChunks,
}));

import { MARK_STALE_MS, useIsFeedMarkActive } from '../use-mark-active';

beforeEach(() => {
    jest.useFakeTimers();
    mockLocal = false;
    mockPhase = 'idle';
    mockDone = 0;
    mockTotal = 0;
    mockChunks = null;
});
afterEach(() => jest.useRealTimers());

describe('useIsFeedMarkActive', () => {
    it('is the pipeline stale bound, 15 minutes', () => {
        expect(MARK_STALE_MS).toBe(15 * 60_000);
    });

    it('is still when nothing is happening', () => {
        const { result } = renderHook(() => useIsFeedMarkActive());
        expect(result.current).toBe(false);
    });

    it('is active while the phone works', () => {
        mockLocal = true;
        const { result } = renderHook(() => useIsFeedMarkActive());
        expect(result.current).toBe(true);
    });

    it('is active while the server scores the reader\'s articles', () => {
        mockPhase = 'reasons';
        mockDone = 10;
        mockTotal = 40;
        const { result } = renderHook(() => useIsFeedMarkActive());
        expect(result.current).toBe(true);
    });

    it('goes still once a server batch has made no progress for MARK_STALE_MS, and wakes on progress', () => {
        mockPhase = 'reasons';
        mockDone = 10;
        mockTotal = 40;
        const { result, rerender } = renderHook(() => useIsFeedMarkActive());
        act(() => {
            jest.advanceTimersByTime(MARK_STALE_MS - 1000);
        });
        rerender({});
        expect(result.current).toBe(true);
        act(() => {
            jest.advanceTimersByTime(2000);
        });
        rerender({});
        expect(result.current).toBe(false);
        // Progress lands: animate again.
        mockDone = 15;
        rerender({});
        expect(result.current).toBe(true);
    });
});
