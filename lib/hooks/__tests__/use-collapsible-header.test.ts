// use-collapsible-header — scroll-origin semantics.
//
// The hook is shared by THREE screens: Feed, Explore and the Dashboard. Feed and
// Explore each drive it from a single list. The Dashboard drives it from FOUR —
// its sub-tab panels stay mounted behind `display:'none'` and keep their own
// scroll offsets — so `lastY` (one shared value) holds whichever panel scrolled
// last, and the first event after a switch reads the difference between two
// panels as user travel.
//
// `resetScrollOrigin()` fixes that, and the FIRST describe below is the point of
// this file: with it never called the handler behaves exactly as it did before
// the reset existed, so Feed and Explore are provably unaffected.
/* eslint-disable @typescript-eslint/no-require-imports */

// Reanimated's worklets runtime cannot initialise under Jest. Shared values
// become plain boxes, `withTiming` resolves to its target immediately, and
// `useAnimatedScrollHandler` hands back the config so the worklet can be invoked
// directly. `useAnimatedStyle` returns the FUNCTION (not its result) so the test
// can recompute the transform on demand after mutating shared values.
jest.mock('react-native-reanimated', () => ({
  // MUST persist across renders — `onHeaderLayout` calls `setHeaderHeight`,
  // which re-renders. A naive `() => ({ value: initial })` would hand back fresh
  // boxes on that render and silently reset `headerH` to 0, so every hide
  // assertion would fail for the wrong reason. `useRef` gives real shared-value
  // semantics: one stable box per call site.
  useSharedValue: (initial: any) => require('react').useRef({ value: initial }).current,
  useAnimatedScrollHandler: (cfg: any) => cfg,
  useAnimatedStyle: (fn: any) => fn,
  withTiming: (toValue: any) => toValue,
}));

import { act, renderHook } from '@testing-library/react-native';
import { useCollapsibleHeader } from '../use-collapsible-header';

const HEADER_H = 100;
/** Past DOWN_THRESHOLD (24) and past the header height, so a hide can trigger. */
const setup = () => {
  const { result } = renderHook(() => useCollapsibleHeader());
  act(() => {
    result.current.onHeaderLayout({ nativeEvent: { layout: { height: HEADER_H } } } as any);
  });
  const scroll = (y: number) =>
    act(() => {
      (result.current.scrollHandler as any).onScroll({ contentOffset: { y } });
    });
  /** 0 = fully shown, -HEADER_H = fully hidden. The `+ 0` normalises the `-0`
   *  that `-hidden * headerH` yields when hidden is 0 — `Object.is(-0, 0)` is
   *  false, so `toBe(0)` would fail on a fully-revealed header. */
  const translateY = () => (result.current.headerStyle as any)().transform[0].translateY + 0;
  return { result, scroll, translateY };
};

describe('single-list use (Feed, Explore) — resetScrollOrigin never called', () => {
  it('starts revealed', () => {
    const { translateY } = setup();
    expect(translateY()).toBe(0);
  });

  it('hides once cumulative downward travel passes the threshold below the header', () => {
    const { scroll, translateY } = setup();
    scroll(150);
    scroll(400);
    expect(translateY()).toBe(-HEADER_H);
  });

  it('reveals again on an upward flick', () => {
    const { scroll, translateY } = setup();
    scroll(150);
    scroll(400);
    expect(translateY()).toBe(-HEADER_H);
    scroll(370);
    expect(translateY()).toBe(0);
  });

  it('always reveals at the very top', () => {
    const { scroll, translateY } = setup();
    scroll(150);
    scroll(400);
    scroll(0);
    expect(translateY()).toBe(0);
  });

  it('ignores rubber-band overscroll above the top', () => {
    const { scroll, translateY } = setup();
    scroll(150);
    scroll(400);
    expect(translateY()).toBe(-HEADER_H);
    scroll(-40);
    expect(translateY()).toBe(-HEADER_H);
  });

  it('does not hide while still above the header height, however far it travelled', () => {
    const { scroll, translateY } = setup();
    scroll(50);
    scroll(99);
    expect(translateY()).toBe(0);
  });

  // reveal() must NOT rebase the origin: Feed and Explore call it MID-SCROLL on
  // error/offline states, and rebasing there would make the next event read as a
  // large positive dy and hide the header under the user.
  it('reveal() mid-scroll does not rebase the origin', () => {
    const { result, scroll, translateY } = setup();
    scroll(150);
    scroll(400);
    act(() => result.current.reveal());
    expect(translateY()).toBe(0);
    // A small further scroll DOWN from 400 is 10px of travel, under the
    // threshold — not a re-hide.
    scroll(410);
    expect(translateY()).toBe(0);
  });
});

describe('multi-list use (Dashboard sub-tabs) — the cross-panel artifact', () => {
  // Demonstrates the bug the reset exists for. One handler, two panels at
  // different offsets: the first event after the switch is read as travel.
  it('WITHOUT the reset, switching to a panel at a lower offset spuriously reveals', () => {
    const { scroll, translateY } = setup();
    scroll(150);
    scroll(1500); // Overview, scrolled well down — header hidden.
    expect(translateY()).toBe(-HEADER_H);
    // Saved is at 800. Its first event is read as 700px of UPWARD travel.
    scroll(800);
    expect(translateY()).toBe(0);
  });

  it('WITH the reset, that same switch changes nothing', () => {
    const { result, scroll, translateY } = setup();
    scroll(150);
    scroll(1500);
    expect(translateY()).toBe(-HEADER_H);
    act(() => result.current.resetScrollOrigin());
    scroll(800);
    expect(translateY()).toBe(-HEADER_H);
  });

  it('WITHOUT the reset, switching to a panel at a HIGHER offset hides the header', () => {
    const { scroll, translateY } = setup();
    scroll(150);
    scroll(200);
    scroll(0); // Overview back at the top — header revealed.
    expect(translateY()).toBe(0);
    // Saved sits at 800; its first event is read as 800px of DOWNWARD travel.
    scroll(800);
    expect(translateY()).toBe(-HEADER_H);
  });

  it('WITH the reset, the header stays revealed on that switch', () => {
    const { result, scroll, translateY } = setup();
    scroll(150);
    scroll(200);
    scroll(0);
    act(() => result.current.resetScrollOrigin());
    scroll(800);
    expect(translateY()).toBe(0);
  });

  // One event only — the baseline is adopted, then normal tracking resumes.
  it('consumes the reset on a single event, then tracks normally again', () => {
    const { result, scroll, translateY } = setup();
    act(() => result.current.resetScrollOrigin());
    scroll(800); // adopted as the baseline, no travel read
    expect(translateY()).toBe(0);
    scroll(900); // real 100px of downward travel
    expect(translateY()).toBe(-HEADER_H);
  });

  it('a reset that is never followed by a scroll has no effect on its own', () => {
    const { result, translateY } = setup();
    act(() => result.current.resetScrollOrigin());
    expect(translateY()).toBe(0);
  });
});
