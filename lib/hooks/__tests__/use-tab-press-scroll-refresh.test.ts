// Decision logic + listener wiring for "re-tap the active tab icon → scroll to
// top, tap again at the top → refresh".
//
// The pure `decideTabPressAction` carries the whole behaviour, so most of the
// coverage lives there — no navigator, no list, no native tab bar needed. The
// hook block below then checks only the three things the pure function cannot:
// that the subscription is registered for `tabPress`, that a scroll actually
// goes through `scrollToTopWithRetry` (not a bare scrollToOffset), and that the
// listener is torn down on unmount.

const mockScrollToTopWithRetry = jest.fn();
jest.mock('@/components/custom/feed/scroll-to-top-with-retry', () => ({
  scrollToTopWithRetry: (...args: unknown[]) => mockScrollToTopWithRetry(...args),
}));

let mockIsFocused = true;
const mockAddListener = jest.fn();
const mockUnsubscribe = jest.fn();
jest.mock('@react-navigation/native', () => {
  // STABLE identities, like the real hooks — a fresh object per render would
  // re-run the subscription effect and mask the "no re-subscribe" assertion.
  const navigation = {
    addListener: (type: string, cb: (e: unknown) => void) => {
      mockAddListener(type, cb);
      return mockUnsubscribe;
    },
    isFocused: () => mockIsFocused,
  };
  const route = { key: 'feed-key' };
  return { useNavigation: () => navigation, useRoute: () => route };
});

import { renderHook } from '@testing-library/react-native';
import {
  decideTabPressAction,
  useTabPressScrollRefresh,
  TAB_PRESS_TOP_EPSILON,
} from '../use-tab-press-scroll-refresh';

const base = {
  isForThisTab: true,
  isFocused: true,
  offset: 0,
  canRefresh: true,
  isRefreshing: false,
};

describe('decideTabPressAction', () => {
  it('scrolls to top when the active tab is re-tapped while scrolled down', () => {
    expect(decideTabPressAction({ ...base, offset: 900 })).toBe('scroll-to-top');
  });

  it('refreshes when the active tab is re-tapped while already at the top', () => {
    expect(decideTabPressAction({ ...base, offset: 0 })).toBe('refresh');
  });

  it('keeps refreshing on consecutive taps at the top', () => {
    // Nothing latches: each event is decided from the live offset + refresh
    // state, so a second tap after a finished refresh refreshes again.
    expect(decideTabPressAction({ ...base, offset: 0 })).toBe('refresh');
    expect(decideTabPressAction({ ...base, offset: 0 })).toBe('refresh');
  });

  it('does not stack a refresh while one is already in flight', () => {
    expect(decideTabPressAction({ ...base, offset: 0, isRefreshing: true })).toBe('ignore');
  });

  it('treats a NEGATIVE resting offset as "at the top", not as scrolled', () => {
    // Under contentInsetAdjustmentBehavior=automatic the top of the list rests
    // at -adjustedContentInset.top. An `Math.abs(offset) > EPSILON` test would
    // wrongly scroll here and the refresh branch would be unreachable.
    expect(decideTabPressAction({ ...base, offset: -59 })).toBe('refresh');
  });

  it('treats sub-epsilon jitter as "at the top"', () => {
    expect(decideTabPressAction({ ...base, offset: TAB_PRESS_TOP_EPSILON })).toBe('refresh');
    expect(decideTabPressAction({ ...base, offset: TAB_PRESS_TOP_EPSILON + 1 })).toBe(
      'scroll-to-top',
    );
  });

  it('scroll-to-top-only screens do nothing on the second tap', () => {
    // Explore passes no onRefresh: first tap scrolls, further taps are inert.
    expect(decideTabPressAction({ ...base, offset: 900, canRefresh: false })).toBe(
      'scroll-to-top',
    );
    expect(decideTabPressAction({ ...base, offset: 0, canRefresh: false })).toBe('ignore');
  });

  it('ignores a press that is SWITCHING to this tab rather than re-tapping it', () => {
    // tabPress is emitted before the JUMP_TO dispatch, so isFocused() is false
    // for a switch-to-me and true for a re-tap. A switch must not scroll or
    // refresh the destination.
    expect(decideTabPressAction({ ...base, isFocused: false, offset: 900 })).toBe('ignore');
    expect(decideTabPressAction({ ...base, isFocused: false, offset: 0 })).toBe('ignore');
  });

  it("ignores another tab's event", () => {
    expect(decideTabPressAction({ ...base, isForThisTab: false, offset: 900 })).toBe('ignore');
  });
});

describe('useTabPressScrollRefresh', () => {
  const listRef = { current: { scrollToOffset: jest.fn() } };

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFocused = true;
  });

  const fire = (target: string | undefined = 'feed-key') => {
    const cb = mockAddListener.mock.calls[0][1] as (e: { target?: string }) => void;
    cb({ target });
  };

  it('subscribes to tabPress and scrolls via scrollToTopWithRetry', () => {
    const onRefresh = jest.fn();
    renderHook(() =>
      useTabPressScrollRefresh({ listRef, getOffset: () => 500, onRefresh }),
    );

    expect(mockAddListener).toHaveBeenCalledWith('tabPress', expect.any(Function));

    fire();
    expect(mockScrollToTopWithRetry).toHaveBeenCalledTimes(1);
    expect(mockScrollToTopWithRetry.mock.calls[0][0]).toBe(listRef);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('calls the supplied onRefresh when already at the top', () => {
    const onRefresh = jest.fn();
    renderHook(() => useTabPressScrollRefresh({ listRef, getOffset: () => 0, onRefresh }));

    fire();
    expect(mockScrollToTopWithRetry).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an event targeted at another tab', () => {
    const onRefresh = jest.fn();
    renderHook(() => useTabPressScrollRefresh({ listRef, getOffset: () => 0, onRefresh }));

    fire('around-key');
    expect(onRefresh).not.toHaveBeenCalled();
    expect(mockScrollToTopWithRetry).not.toHaveBeenCalled();
  });

  it('does nothing when the tab is not focused at event time (a tab switch)', () => {
    mockIsFocused = false;
    const onRefresh = jest.fn();
    renderHook(() => useTabPressScrollRefresh({ listRef, getOffset: () => 900, onRefresh }));

    fire();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(mockScrollToTopWithRetry).not.toHaveBeenCalled();
  });

  it('reads the LATEST refreshing flag without re-subscribing', () => {
    const onRefresh = jest.fn();
    const { rerender } = renderHook(
      ({ isRefreshing }: { isRefreshing: boolean }) =>
        useTabPressScrollRefresh({ listRef, getOffset: () => 0, onRefresh, isRefreshing }),
      { initialProps: { isRefreshing: false } },
    );

    rerender({ isRefreshing: true });
    expect(mockAddListener).toHaveBeenCalledTimes(1);

    fire();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() =>
      useTabPressScrollRefresh({ listRef, getOffset: () => 0 }),
    );
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
