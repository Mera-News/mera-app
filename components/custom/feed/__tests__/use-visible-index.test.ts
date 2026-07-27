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
});
