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
import {
  useVisibleIndex,
  frozenThroughIndexFor,
  SKIP_DWELL_MS,
} from '../use-visible-index';

// ---- fixtures / helpers ----

function token(id: string, isViewable: boolean): ViewToken {
  return { key: id, index: 0, item: { id }, isViewable };
}

type FreezeCallback = (info: { viewableItems: ViewToken[] }) => void;
type DwellCallback = (info: { changed: ViewToken[] }) => void;

/** Pull the two pairs out with the narrow callback signature each actually has
 *  at runtime — the hook's inline array literal infers a union type across
 *  both pairs, so a plain index access won't type-check the call site. */
function getPairs(pairs: ReturnType<typeof useVisibleIndex>['viewabilityConfigCallbackPairs']) {
  return {
    freeze: pairs[0] as unknown as {
      viewabilityConfig: { itemVisiblePercentThreshold: number; minimumViewTime: number };
      onViewableItemsChanged: FreezeCallback;
    },
    dwell: pairs[1] as unknown as {
      viewabilityConfig: { itemVisiblePercentThreshold: number; minimumViewTime: number };
      onViewableItemsChanged: DwellCallback;
    },
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
    it('returns exactly two viewabilityConfigCallbackPairs', () => {
      const { result } = renderHook(() => useVisibleIndex());
      expect(result.current.viewabilityConfigCallbackPairs).toHaveLength(2);
    });

    it('pair 0 (freeze boundary) uses 10% / 0ms', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const { freeze } = getPairs(result.current.viewabilityConfigCallbackPairs);
      expect(freeze.viewabilityConfig).toEqual({
        itemVisiblePercentThreshold: 10,
        minimumViewTime: 0,
      });
    });

    it('pair 1 (skip dwell) uses 75% / 0ms', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const { dwell } = getPairs(result.current.viewabilityConfigCallbackPairs);
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

  describe('freeze boundary (pair 0)', () => {
    it("populates seenIdsRef.current with the viewable ids", () => {
      const { result } = renderHook(() => useVisibleIndex());
      const { freeze } = getPairs(result.current.viewabilityConfigCallbackPairs);

      act(() => {
        freeze.onViewableItemsChanged({
          viewableItems: [token('a', true), token('b', true)],
        });
      });

      expect(result.current.seenIdsRef.current.has('a')).toBe(true);
      expect(result.current.seenIdsRef.current.has('b')).toBe(true);
    });

    it('never calls markSkipped', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const { freeze } = getPairs(result.current.viewabilityConfigCallbackPairs);

      act(() => {
        freeze.onViewableItemsChanged({ viewableItems: [token('a', true)] });
      });
      act(() => {
        jest.advanceTimersByTime(SKIP_DWELL_MS * 2);
      });

      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });
  });

  describe('dwell (pair 1)', () => {
    it('enter -> exit after LESS than SKIP_DWELL_MS produces no skip', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const { dwell } = getPairs(result.current.viewabilityConfigCallbackPairs);

      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // enter @ t=0
      });
      act(() => {
        jest.advanceTimersByTime(1000); // t=1000
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', false)] }); // exit @ t=1000, dwell=1000
      });
      act(() => {
        jest.advanceTimersByTime(1200); // let the debounce elapse
      });

      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });

    it('enter -> exit after MORE than SKIP_DWELL_MS, then the debounce elapses, marks skipped exactly once', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const { dwell } = getPairs(result.current.viewabilityConfigCallbackPairs);

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

    it('calls markSkipped ZERO times synchronously inside the callback', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const { dwell } = getPairs(result.current.viewabilityConfigCallbackPairs);

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
      const { dwell } = getPairs(result.current.viewabilityConfigCallbackPairs);

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
        jest.advanceTimersByTime(1300); // t=2300 (>= SKIP_DWELL_MS since t=0, but < since t=1000)
      });
      act(() => {
        result.current.flushSkips();
      });

      // If the duplicate enter had restarted the clock, dwell would only be
      // 1300ms (< SKIP_DWELL_MS) and this would not have fired.
      expect(mockMarkSkipped).toHaveBeenCalledWith(['a']);
    });

    it('two short separate visits do not accumulate into a skip', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const { dwell } = getPairs(result.current.viewabilityConfigCallbackPairs);

      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // enter @ t=0
      });
      act(() => {
        jest.advanceTimersByTime(1200); // t=1200 (first visit dwell so far)
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', false)] }); // exit @ t=1200, dwell=1200
      });
      act(() => {
        jest.advanceTimersByTime(100); // t=1300, small gap between visits
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', true)] }); // re-enter @ t=1300
      });
      act(() => {
        jest.advanceTimersByTime(1200); // t=2500 (second visit dwell so far)
      });
      act(() => {
        dwell.onViewableItemsChanged({ changed: [token('a', false)] }); // exit @ t=2500, dwell=1200
      });
      act(() => {
        jest.advanceTimersByTime(1200); // let any pending debounce elapse
      });

      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });

    it('several callback invocations inside one debounce window produce exactly ONE flush', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const { dwell } = getPairs(result.current.viewabilityConfigCallbackPairs);

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
      const { dwell } = getPairs(result.current.viewabilityConfigCallbackPairs);

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
      const { dwell } = getPairs(result.current.viewabilityConfigCallbackPairs);

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
      const { dwell } = getPairs(result.current.viewabilityConfigCallbackPairs);

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
});

describe('frozenThroughIndexFor', () => {
  it('returns 1 for an empty seen set', () => {
    expect(frozenThroughIndexFor(['a', 'b', 'c'], new Set())).toBe(1);
  });

  it('returns deepestSeenIndex + 2', () => {
    const order = ['a', 'b', 'c', 'd'];
    const seen = new Set(['a', 'c']); // deepest present = index 2 ('c')
    expect(frozenThroughIndexFor(order, seen)).toBe(4);
  });

  it('ignores seen ids no longer in order and falls back to the deepest present id', () => {
    const order = ['a', 'b'];
    // 'z' was seen at some point but has since been evicted from `order`.
    const seen = new Set(['a', 'z']);
    expect(frozenThroughIndexFor(order, seen)).toBe(2); // deepest present is 'a' @ index 0
  });

  it('returns 1 when every seen id has been evicted from order', () => {
    const order = ['a', 'b'];
    const seen = new Set(['x', 'y']);
    expect(frozenThroughIndexFor(order, seen)).toBe(1);
  });
});
