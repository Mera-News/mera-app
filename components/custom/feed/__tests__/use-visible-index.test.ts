// use-visible-index.test.ts — renderHook tests for
// components/custom/feed/use-visible-index.ts
//
// ux2 B2 (owner): a card counts as SEEN only while its BOTTOM edge sits inside
// the visible band [header bottom, window height minus the tab bar clearance],
// continuously for DWELL_READ_SECONDS. The 75% pair now only moves the pinned
// prefix anchor.

const mockMarkSkipped = jest.fn();
let mockTick: (() => void) | null = null;

jest.mock('@/lib/stores/feed-order-store', () => ({
  useFeedOrderStore: {
    getState: jest.fn(() => ({ markSkipped: mockMarkSkipped })),
  },
}));
jest.mock('@/lib/visibility-tick', () => ({
  subscribeScrollTick: (fn: () => void) => {
    mockTick = fn;
    return () => {
      mockTick = null;
    };
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

type PairCallback = (info: { changed: ViewToken[] }) => void;
type Pair = {
  viewabilityConfig: { itemVisiblePercentThreshold: number; minimumViewTime: number };
  onViewableItemsChanged: PairCallback;
};

/** Pair 0: the pinned-prefix anchor (75%). */
function getDwell(pairs: ReturnType<typeof useVisibleIndex>['viewabilityConfigCallbackPairs']) {
  return pairs[0] as unknown as Pair;
}
/** Pair 1: which rows are on screen at all. */
function getOnScreen(pairs: ReturnType<typeof useVisibleIndex>['viewabilityConfigCallbackPairs']) {
  return pairs[1] as unknown as Pair;
}

/** Band: header bottom at 100, tab bar top at 700. */
const BAND = { top: 100, bottom: 700 };

function setupBand() {
  const bandRef = { current: () => BAND };
  const { result, unmount } = renderHook(() => useVisibleIndex(undefined, bandRef));
  const onScreen = getOnScreen(result.current.viewabilityConfigCallbackPairs);
  /** Where each row is in the window: y and height (measureInWindow). */
  const geometry = new Map<string, { y: number; h: number }>();
  const place = (id: string, y: number, h: number) => {
    geometry.set(id, { y, h });
    act(() => {
      result.current.registerRow(id)({
        measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => {
          const g = geometry.get(id)!;
          cb(0, g.y, 390, g.h);
        },
      } as never);
    });
  };
  const show = (id: string, on = true) =>
    act(() => {
      onScreen.onViewableItemsChanged({ changed: [token(id, on)] });
    });
  const tick = () =>
    act(() => {
      mockTick?.();
    });
  const wait = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });
  return { result, unmount, place, show, tick, wait, geometry };
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
    it('returns two pairs: the 75% anchor and a low-threshold on-screen pair', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const pairs = result.current.viewabilityConfigCallbackPairs;
      expect(pairs).toHaveLength(2);
      expect(getDwell(pairs).viewabilityConfig).toEqual({ itemVisiblePercentThreshold: 75, minimumViewTime: 0 });
      expect(getOnScreen(pairs).viewabilityConfig.itemVisiblePercentThreshold).toBeLessThanOrEqual(1);
    });

    it('returns a referentially stable pairs array across re-renders', () => {
      const { result, rerender } = renderHook(() => useVisibleIndex());
      const first = result.current.viewabilityConfigCallbackPairs;
      rerender({});
      expect(result.current.viewabilityConfigCallbackPairs).toBe(first);
    });
  });

  describe('seen = bottom edge in the band for the dwell', () => {
    it('bottom edge in the band for the full dwell, then it leaves: marked seen once', () => {
      const t = setupBand();
      t.place('a', 200, 300); // bottom 500: in band
      t.show('a');
      t.tick();
      t.wait(SKIP_DWELL_MS + 100);
      t.geometry.set('a', { y: -400, h: 300 }); // scrolled up past the header
      t.tick();
      t.wait(1300);
      expect(mockMarkSkipped).toHaveBeenCalledTimes(1);
      expect(mockMarkSkipped).toHaveBeenCalledWith(['a']);
    });

    it('in the band for less than the dwell: not seen', () => {
      const t = setupBand();
      t.place('a', 200, 300);
      t.show('a');
      t.tick();
      t.wait(SKIP_DWELL_MS - 200);
      t.geometry.set('a', { y: -400, h: 300 });
      t.tick();
      t.wait(1300);
      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });

    it('a card whose bottom sits under the tab bar never counts, however long it is on screen', () => {
      const t = setupBand();
      t.place('a', 300, 450); // bottom 750: under the tab bar (band ends at 700)
      t.show('a');
      t.tick();
      t.wait(SKIP_DWELL_MS * 4);
      act(() => t.result.current.flushSkips());
      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });

    it('a tall card qualifies once its END scrolls into the band', () => {
      const t = setupBand();
      t.place('tall', 150, 900); // bottom 1050: below the band
      t.show('tall');
      t.tick();
      t.wait(SKIP_DWELL_MS * 2);
      act(() => t.result.current.flushSkips());
      expect(mockMarkSkipped).not.toHaveBeenCalled();
      t.geometry.set('tall', { y: -300, h: 900 }); // bottom 600: in band now
      t.tick();
      t.wait(SKIP_DWELL_MS + 100);
      act(() => t.result.current.flushSkips());
      expect(mockMarkSkipped).toHaveBeenCalledWith(['tall']);
    });

    it('two short stays in the band do not add up', () => {
      const t = setupBand();
      t.place('a', 200, 300);
      t.show('a');
      t.tick();
      t.wait(SKIP_DWELL_MS / 2);
      t.geometry.set('a', { y: 500, h: 300 }); // bottom 800: out
      t.tick();
      t.geometry.set('a', { y: 200, h: 300 }); // back in
      t.tick();
      t.wait(SKIP_DWELL_MS / 2 + 100);
      t.geometry.set('a', { y: -400, h: 300 });
      t.tick();
      t.wait(1300);
      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });

    it('a row that scrolls off screen after earning its dwell is marked', () => {
      const t = setupBand();
      t.place('a', 200, 300);
      t.show('a');
      t.tick();
      t.wait(SKIP_DWELL_MS + 100);
      t.show('a', false); // the on-screen pair reports it gone
      t.wait(1300);
      expect(mockMarkSkipped).toHaveBeenCalledWith(['a']);
    });

    it('flushSkips() drains a row still in the band past its dwell', () => {
      const t = setupBand();
      t.place('a', 200, 300);
      t.show('a');
      t.tick();
      t.wait(SKIP_DWELL_MS + 100);
      act(() => t.result.current.flushSkips());
      expect(mockMarkSkipped).toHaveBeenCalledTimes(1);
      expect(mockMarkSkipped).toHaveBeenCalledWith(['a']);
    });

    it('an unmeasured row (height 0) is not timed until it measures', () => {
      const t = setupBand();
      t.place('a', 0, 0);
      t.show('a');
      t.tick();
      t.wait(SKIP_DWELL_MS * 2);
      act(() => t.result.current.flushSkips());
      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });

    it('a list at rest: a first measure that never calls back is retried on the ladder, no scroll needed', () => {
      const t = setupBand();
      let calls = 0;
      act(() => {
        t.result.current.registerRow('a')({
          measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => {
            calls += 1;
            // Fabric: a fresh cell with no committed position never calls back.
            if (calls === 1) return;
            cb(0, 200, 390, 300);
          },
        } as never);
      });
      t.show('a'); // no tick follows: the list is at rest
      t.wait(500); // the ladder re-measures at 150 and 450 ms
      expect(calls).toBeGreaterThanOrEqual(2);
      t.wait(SKIP_DWELL_MS);
      act(() => t.result.current.flushSkips());
      expect(mockMarkSkipped).toHaveBeenCalledWith(['a']);
    });

    it('75% visibility ALONE never marks a card seen (the anchor pair does not time dwell)', () => {
      const { result } = renderHook(() => useVisibleIndex());
      const anchor = getDwell(result.current.viewabilityConfigCallbackPairs);
      act(() => anchor.onViewableItemsChanged({ changed: [token('a', true)] }));
      act(() => {
        jest.advanceTimersByTime(SKIP_DWELL_MS * 3);
      });
      act(() => anchor.onViewableItemsChanged({ changed: [token('a', false)] }));
      act(() => result.current.flushSkips());
      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });

    it('never writes the store synchronously inside a tick', () => {
      const t = setupBand();
      t.place('a', 200, 300);
      t.show('a');
      t.tick();
      t.wait(SKIP_DWELL_MS + 100);
      t.geometry.set('a', { y: -400, h: 300 });
      t.tick();
      expect(mockMarkSkipped).not.toHaveBeenCalled();
    });

    it('unmounting flushes a non-empty buffer', () => {
      const t = setupBand();
      t.place('a', 200, 300);
      t.show('a');
      t.tick();
      t.wait(SKIP_DWELL_MS + 100);
      t.geometry.set('a', { y: -400, h: 300 });
      t.tick();
      act(() => t.unmount());
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
  });
});
