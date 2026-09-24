import { act, renderHook } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import {
    CANDIDATES_WAIT_MS,
    SKELETON_DELAY_MS,
    useFeedWarmup,
    type FeedWarmupInput,
} from '../use-feed-warmup';

const COLD: FeedWarmupInput = {
    orderHydrated: false,
    openedHydrated: false,
    candidateCount: 0,
    renderedCount: 0,
    ingested: false,
    suggestionsHydrated: false,
    announcement: 'Loading your feed',
};

describe('useFeedWarmup (F2: no false empty state on launch)', () => {
    let announce: jest.SpyInstance;
    beforeEach(() => {
        jest.useFakeTimers();
        announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    });
    afterEach(() => {
        jest.useRealTimers();
        announce.mockRestore();
    });

    it('draws nothing first, then a skeleton after the delay, announced once', () => {
        const { result, rerender } = renderHook((p: FeedWarmupInput) => useFeedWarmup(p), {
            initialProps: COLD,
        });
        expect(result.current).toBe('blank');
        act(() => {
            jest.advanceTimersByTime(SKELETON_DELAY_MS);
        });
        expect(result.current).toBe('skeleton');
        rerender({ ...COLD, orderHydrated: true });
        expect(announce).toHaveBeenCalledTimes(1);
        expect(announce).toHaveBeenCalledWith('Loading your feed');
    });

    it('stays warming while candidates exist but have not been ingested yet', () => {
        const { result } = renderHook(() =>
            useFeedWarmup({ ...COLD, orderHydrated: true, openedHydrated: true, candidateCount: 12 }),
        );
        act(() => {
            jest.advanceTimersByTime(SKELETON_DELAY_MS);
        });
        expect(result.current).toBe('skeleton');
    });

    it('is ready once candidates are ingested, even if the list ingests to zero rows', () => {
        const { result } = renderHook(() =>
            useFeedWarmup({
                ...COLD,
                orderHydrated: true,
                openedHydrated: true,
                candidateCount: 12,
                ingested: true,
                suggestionsHydrated: true,
            }),
        );
        expect(result.current).toBe('ready');
    });

    it('resolves a genuinely empty database the moment its read returns', () => {
        const { result } = renderHook(() =>
            useFeedWarmup({ ...COLD, orderHydrated: true, openedHydrated: true, suggestionsHydrated: true }),
        );
        expect(result.current).toBe('ready');
    });

    // 600-f4-cold-38: the local read took ~13s on a cold launch. A 3s guess
    // gave up, the empty-state chain said "all caught up", then cards arrived.
    it('keeps waiting on a slow local read well past the old 3s guess', () => {
        const { result } = renderHook(() =>
            useFeedWarmup({ ...COLD, orderHydrated: true, openedHydrated: true }),
        );
        act(() => {
            jest.advanceTimersByTime(13_000);
        });
        expect(result.current).toBe('skeleton');
    });

    it('stops waiting at the safety cap, so a read that hangs cannot keep the skeleton up', () => {
        const { result } = renderHook(() =>
            useFeedWarmup({ ...COLD, orderHydrated: true, openedHydrated: true }),
        );
        act(() => {
            jest.advanceTimersByTime(CANDIDATES_WAIT_MS);
        });
        expect(result.current).toBe('ready');
    });

    it('never depends on order length: hydrated stores with dead persisted ids still resolve', () => {
        // The order may hold ids whose items aged out, so renderedCount stays 0.
        const { result } = renderHook(() =>
            useFeedWarmup({ ...COLD, orderHydrated: true, openedHydrated: true, candidateCount: 0 }),
        );
        act(() => {
            jest.advanceTimersByTime(CANDIDATES_WAIT_MS);
        });
        expect(result.current).toBe('ready');
    });

    it('once rows have rendered it is ready for good, even if the list empties again', () => {
        const { result, rerender } = renderHook((p: FeedWarmupInput) => useFeedWarmup(p), {
            initialProps: { ...COLD, renderedCount: 3 },
        });
        expect(result.current).toBe('ready');
        rerender({ ...COLD, renderedCount: 0 });
        expect(result.current).toBe('ready');
    });
});
