// use-visible-index.test.ts — renderHook tests for
// components/custom/feed/use-visible-index.ts

const mockMarkSkipped = jest.fn();

jest.mock('@/lib/stores/feed-order-store', () => ({
  useFeedOrderStore: {
    getState: jest.fn(() => ({ markSkipped: mockMarkSkipped })),
  },
}));

import { renderHook, act } from '@testing-library/react-native';
import type { ViewToken } from 'react-native';
import { useVisibleIndex, SKIP_DWELL_MS } from '../use-visible-index';
import { extendPinnedIds } from '../feed-entries';

// ---- fixtures / helpers ----

function token(id: string, isViewable: boolean): ViewToken {
  return { key: id, index: 0, item: { id }, isViewable };
}

type DwellCallback = (info: { changed: ViewToken[] }) => void;

/** Pull the sole pair out with the narrow callback signature it actually has
 *  at runtime. */
function getDwell(pairs: ReturnType<typeof useVisibleIndex>['viewabilityConfigCallbackPairs']) {
  return pairs[0] as unknown as {
    viewabilityConfig: { itemVisiblePercentThreshold: number; minimumViewTime: number };
    onViewableItemsChanged: DwellCallback;
  };
}

describe('useVisibleIndex', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    mockMarkSkipped.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('shape', () => {
    it('returns exactly one viewabilityConfigCallbackPairs entry', () => {
      const { result } = renderHook(() => useVisibleIndex());
      expect(result.current.viewabilityConfigCallbackPairs).toHaveLength(1);
    });

    it('the pair (skip dwell) uses 75% / 0ms', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const dwell = getDwell(result.current.viewabilityConfigCallbackPairs);
      expect(dwell.viewabilityConfig).toEqual({
        itemVisiblePercentThreshold: 75,
        minimumViewTime: 0,
      });
    });

    it('returns a referentially stable pairs array across re-renders', () => {
      const { result, rerender } = renderHook(() => useVisibleIndex());
      const first = result.current.viewabilityConfigCallbackPairs;
      rerender({});
      const second = result.current.viewabilityConfigCallbackPairs;
      expect(second).toBe(first);
    });
  });

  describe('dwell', () => {
    it('enter -> exit after LESS than SKIP_DWELL_MS produces no skip', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const dwell = getDwell(result.current.viewabilityConfigCallbackPairs);

      const belowDwell = Math.floor(SKIP_DWELL_MS / 3); // clearly below the threshold

      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // enter @ t=0
      });
      act(() => {
        jest.advanceTimersByTime(belowDwell);
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', false)] }); // exit, dwell=belowDwell
      });
      act(() => {
        jest.advanceTimersByTime(1200); // let the debounce elapse
      });

      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });

    it('enter -> exit after MORE than SKIP_DWELL_MS, then the debounce elapses, marks skipped exactly once', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const dwell = getDwell(result.current.viewabilityConfigCallbackPairs);

      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // enter @ t=0
      });
      act(() => {
        // Crosses SKIP_DWELL_MS while still on screen. This also fires (and
        // no-ops) the debounce timer scheduled by the enter call itself.
        jest.advanceTimersByTime(SKIP_DWELL_MS + 500);
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', false)] }); // exit, dwell > SKIP_DWELL_MS
      });
      act(() => {
        jest.advanceTimersByTime(1200); // debounce elapses
      });

      expect(mockMarkSkipped).toHaveBeenCalledTimes(1);
      expect(mockMarkSkipped).toHaveBeenCalledWith(['a']);
    });

    it('a dwell of just UNDER SKIP_DWELL_MS produces no skip', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const dwell = getDwell(result.current.viewabilityConfigCallbackPairs);

      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // enter @ t=0
      });
      act(() => {
        jest.advanceTimersByTime(SKIP_DWELL_MS - 1);
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', false)] }); // exit, dwell = SKIP_DWELL_MS - 1
      });
      act(() => {
        jest.advanceTimersByTime(1200); // let the debounce elapse
      });

      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });

    it('a dwell of EXACTLY SKIP_DWELL_MS counts as dwelt (>= comparison)', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const dwell = getDwell(result.current.viewabilityConfigCallbackPairs);

      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // enter @ t=0
      });
      act(() => {
        jest.advanceTimersByTime(SKIP_DWELL_MS);
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', false)] }); // exit, dwell = SKIP_DWELL_MS exactly
      });
      act(() => {
        jest.advanceTimersByTime(1200); // let the debounce elapse
      });

      expect(mockMarkSkipped).toHaveBeenCalledTimes(1);
      expect(mockMarkSkipped).toHaveBeenCalledWith(['a']);
    });

    it('calls markSkipped ZERO times synchronously inside the callback', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const dwell = getDwell(result.current.viewabilityConfigCallbackPairs);

      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] });
      });
      act(() => {
        jest.advanceTimersByTime(SKIP_DWELL_MS + 100);
      });
      act(() => {
        // Exit happens well past the dwell threshold — if the callback ever
        // called markSkipped synchronously, it would show up immediately.
        dwell.onViewableItemsChanged({ changed: [token('a', false)] });
      });

      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });

    it('a duplicate enter event for an already-entered id does not restart its dwell clock', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const dwell = getDwell(result.current.viewabilityConfigCallbackPairs);

      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // enter @ t=0
      });
      act(() => {
        jest.advanceTimersByTime(1000); // t=1000
      });
      act(() => {
        // Duplicate enter — must NOT reset enterAt to t=1000.
        dwell.onViewableItemsChanged({ changed: [token('a', true)] });
      });
      act(() => {
        // t = 1000 + (SKIP_DWELL_MS - 1000 + 300): elapsed since t=0 is
        // SKIP_DWELL_MS + 300 (>= threshold), elapsed since the duplicate's
        // t=1000 is only SKIP_DWELL_MS - 700 (< threshold).
        jest.advanceTimersByTime(SKIP_DWELL_MS - 700);
      });
      act(() => {
        result.current.flushSkips();
      });

      // If the duplicate enter had restarted the clock, dwell since t=1000
      // would only be (SKIP_DWELL_MS - 700)ms (< SKIP_DWELL_MS) and this
      // would not have fired.
      expect(mockMarkSkipped).toHaveBeenCalledWith(['a']);
    });

    it('two short separate visits do not accumulate into a skip', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const dwell = getDwell(result.current.viewabilityConfigCallbackPairs);

      // Each visit dwells for a bit over half the threshold — individually
      // well under SKIP_DWELL_MS, but their sum comfortably exceeds it, so a
      // buggy cumulative-dwell implementation would still fire a skip.
      const visitDwell = Math.floor(SKIP_DWELL_MS * 0.55);
      expect(visitDwell * 2).toBeGreaterThan(SKIP_DWELL_MS);
      expect(visitDwell).toBeLessThan(SKIP_DWELL_MS);

      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // enter @ t=0
      });
      act(() => {
        jest.advanceTimersByTime(visitDwell); // first visit dwell so far
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', false)] }); // exit, dwell=visitDwell
      });
      act(() => {
        jest.advanceTimersByTime(100); // small gap between visits
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // re-enter
      });
      act(() => {
        jest.advanceTimersByTime(visitDwell); // second visit dwell so far
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', false)] }); // exit, dwell=visitDwell
      });
      act(() => {
        jest.advanceTimersByTime(1200); // let any pending debounce elapse
      });

      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });

    it('several callback invocations inside one debounce window produce exactly ONE flush', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const dwell = getDwell(result.current.viewabilityConfigCallbackPairs);

      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // enter @ t=0, schedules the ONE timer
      });
      act(() => {
        jest.advanceTimersByTime(300); // t=300
      });
      act(() => {
        // A second invocation inside the same debounce window must not
        // schedule a second timer (non-resetting debounce).
        dwell.onViewableItemsChanged({ changed: [token('b', true)] });
      });
      act(() => {
        jest.advanceTimersByTime(200); // t=500
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', false)] }); // exit @ t=500, dwell=500 (no skip)
      });
      act(() => {
        jest.advanceTimersByTime(1200); // the single debounce timer (scheduled @ t=0, fires @ t=1200) elapses
      });

      // Only one flush should ever have run in this window — assert via the
      // total call count staying at (at most) one invocation, none of which
      // had anything to report.
      expect(mockMarkSkipped).not.toHaveBeenCalled();

      act(() => {
        jest.advanceTimersByTime(1200); // nothing new scheduled — no second flush
      });
      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });

    it('flushSkips() called explicitly flushes early; a subsequent timer fire is a no-op', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const dwell = getDwell(result.current.viewabilityConfigCallbackPairs);

      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // enter @ t=0
      });
      act(() => {
        jest.advanceTimersByTime(SKIP_DWELL_MS + 500); // dwell exceeded, still on screen (debounce no-ops mid-window)
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', false)] }); // exit, dwell > SKIP_DWELL_MS -> buffered
      });

      act(() => {
        result.current.flushSkips(); // explicit early flush
      });
      expect(mockMarkSkipped).toHaveBeenCalledTimes(1);
      expect(mockMarkSkipped).toHaveBeenCalledWith(['a']);

      act(() => {
        jest.advanceTimersByTime(5000); // any subsequent timer fire must be a no-op
      });
      expect(mockMarkSkipped).toHaveBeenCalledTimes(1);
    });

    it('flushSkips() drains an item still on screen but already past its dwell', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const dwell = getDwell(result.current.viewabilityConfigCallbackPairs);

      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // enter @ t=0, never exits
      });
      act(() => {
        jest.advanceTimersByTime(SKIP_DWELL_MS + 100); // advance past dwell without an exit event
      });
      act(() => {
        result.current.flushSkips();
      });

      expect(mockMarkSkipped).toHaveBeenCalledTimes(1);
      expect(mockMarkSkipped).toHaveBeenCalledWith(['a']);
    });

    it('unmounting the hook flushes a non-empty buffer', () => {
      const { result, unmount } = renderHook(() => useVisibleIndex());
      const dwell = getDwell(result.current.viewabilityConfigCallbackPairs);

      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // enter @ t=0
      });
      act(() => {
        jest.advanceTimersByTime(SKIP_DWELL_MS + 500);
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', false)] }); // exit, buffered (not yet flushed)
      });

      expect(mockMarkSkipped).not.toHaveBeenCalled();

      act(() => {
        unmount();
      });

      expect(mockMarkSkipped).toHaveBeenCalledTimes(1);
      expect(mockMarkSkipped).toHaveBeenCalledWith(['a']);
    });
  });

  // ---- deepest-seen anchor (the pinned-prefix input) ----
  //
  // THIS is where the index-space regression lives — not in extendPinnedIds,
  // which only ever sees the story-only array and would pass such a test
  // trivially. The overshoot the id-based design exists to prevent happens in
  // the TRACKER, when a token's `index` counts divider sentinels that the pin's
  // array does not contain.
  describe('deepest-seen anchor', () => {
    /** A token whose `index` deliberately disagrees with the story-only order —
     *  as it will once divider rows are spliced into the rendered list. */
    const tokenAt = (id: string, index: number): ViewToken => ({
      key: id,
      index,
      item: { id },
      isViewable: true,
    });

    function setup(ids: string[]) {
      const renderedIdsRef = { current: ids as readonly string[] };
      const { result } = renderHook(() => useVisibleIndex(renderedIdsRef));
      return { renderedIdsRef, result, dwell: getDwell(result.current.viewabilityConfigCallbackPairs) };
    }

    it('starts null and tracks the deepest viewable story', () => {
      const { result, dwell } = setup(['s0', 's1', 's2', 's3']);
      expect(result.current.deepestSeenIdRef.current).toBeNull();

      act(() => {
        dwell.onViewableItemsChanged({ changed: [tokenAt('s0', 0), tokenAt('s2', 2)] });
      });
      expect(result.current.deepestSeenIdRef.current).toBe('s2');
    });

    it('is monotonic: scrolling back up does not move the anchor', () => {
      const { result, dwell } = setup(['s0', 's1', 's2', 's3']);
      act(() => {
        dwell.onViewableItemsChanged({ changed: [tokenAt('s3', 3)] });
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [tokenAt('s1', 1)] });
      });
      expect(result.current.deepestSeenIdRef.current).toBe('s3');
    });

    it('REGRESSION: ignores the token index, so divider rows consume no pin slots', () => {
      // 10 stories rendered. Two divider rows sit above story 6, so the FlatList
      // reports it at index 8 while it is story index 6.
      const storyIds = Array.from({ length: 10 }, (_, i) => `s${i}`);
      const { result, dwell } = setup(storyIds);

      act(() => {
        dwell.onViewableItemsChanged({ changed: [tokenAt('s6', 8)] });
      });

      expect(result.current.deepestSeenIdRef.current).toBe('s6');

      // The pin derived from it covers story index 6 + 1 slack = 8 rows.
      const sorted = storyIds.map((id) => ({ id }) as never);
      const pinned = extendPinnedIds([], sorted, result.current.deepestSeenIdRef.current);
      expect(pinned).toHaveLength(8); // NOT 10 — the old index-based tracker gave 10
      expect(pinned[pinned.length - 1]).toBe('s7');
    });

    it('a re-sort that moves the anchor UP cannot shrink the pin', () => {
      const { result, dwell } = setup(['s0', 's1', 's2', 's3', 's4', 's5']);
      act(() => {
        dwell.onViewableItemsChanged({ changed: [tokenAt('s4', 4)] });
      });
      const before = extendPinnedIds(
        [],
        ['s0', 's1', 's2', 's3', 's4', 's5'].map((id) => ({ id }) as never),
        result.current.deepestSeenIdRef.current,
      );
      expect(before).toHaveLength(6);

      // List re-sorts; the anchor is now near the top, and a shallower row
      // becomes viewable.
      const reordered = ['s4', 's0', 's1', 's2', 's3', 's5'];
      act(() => {
        result.current.deepestSeenIdRef.current = 's4';
      });
      const after = extendPinnedIds(
        before,
        reordered.map((id) => ({ id }) as never),
        's4',
      );
      expect(after).toBe(before); // identity — monotonic guard holds
    });

    it('resetDeepestSeen drops the anchor for a new session', () => {
      const { result, dwell } = setup(['s0', 's1', 's2']);
      act(() => {
        dwell.onViewableItemsChanged({ changed: [tokenAt('s2', 2)] });
      });
      expect(result.current.deepestSeenIdRef.current).toBe('s2');

      act(() => {
        result.current.resetDeepestSeen();
      });
      expect(result.current.deepestSeenIdRef.current).toBeNull();
    });

    it('ignores ids absent from the rendered story order (e.g. a divider key)', () => {
      const { result, dwell } = setup(['s0', 's1', 's2']);
      act(() => {
        dwell.onViewableItemsChanged({ changed: [tokenAt('s1', 1)] });
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [tokenAt('feed-divider-caught-up', 2)] });
      });
      expect(result.current.deepestSeenIdRef.current).toBe('s1');
    });

    it('still records dwell normally while tracking (the two writes do not interfere)', () => {
      const { dwell } = setup(['s0', 's1']);
      act(() => {
        dwell.onViewableItemsChanged({ changed: [tokenAt('s0', 0)] });
      });
      act(() => {
        jest.advanceTimersByTime(SKIP_DWELL_MS + 100);
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('s0', false)] });
      });
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      expect(mockMarkSkipped).toHaveBeenCalledWith(['s0']);
    });
  });
});
