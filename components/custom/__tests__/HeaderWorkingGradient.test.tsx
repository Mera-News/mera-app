// The header's working strip.
//
// Two properties carry this file, and both are things a future edit would undo
// by accident rather than on purpose:
//
//   1. IT NEVER TOUCHES THE SHARED BACKDROP ENGINE. Reusing
//      `<AbstractGradientBackdrop/>` is the obvious shortcut, and it would add
//      a second full-screen animated layer to a module-global clock that
//      already prices its cost at 21.2% CPU against 6.6% static. The metric
//      assertions here cannot be satisfied by a stub or an inert render — the
//      only way to fail them is to actually reuse the backdrop.
//   2. AT REST IT IS STRUCTURALLY ABSENT, not transparent. "The header is
//      exactly what it is today at rest" is then a property of the tree.
/* eslint-disable @typescript-eslint/no-require-imports */

import React from 'react';
import { AppState } from 'react-native';
import { render, act } from '@testing-library/react-native';
import { NavigationContext } from '@react-navigation/native';

let mockReduceMotion = false;
const mockWithRepeat = jest.fn(
  (v: unknown, _count?: number, _reverse?: boolean) => v,
);

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View: (p: any) => <View {...p} /> },
    Easing: { inOut: (f: unknown) => f, ease: 'ease' },
    makeMutable: (initial: unknown) => ({ value: initial }),
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useReducedMotion: () => mockReduceMotion,
    // Real per-instance identity. A mock that forgot the value between renders
    // would make every opacity assertion below vacuous.
    useSharedValue: (initial: number) => {
      const { useRef } = require('react');
      return useRef({ value: initial }).current;
    },
    withRepeat: (v: unknown, count?: number, reverse?: boolean) =>
      mockWithRepeat(v, count, reverse),
    withTiming: (v: unknown) => v,
  };
});

jest.mock('react-native-svg', () => {
  const { View } = require('react-native');
  const Passthrough = (p: any) => <View {...p} />;
  return {
    __esModule: true,
    default: (p: any) => <View testID="strip-svg" {...p} />,
    Defs: Passthrough,
    LinearGradient: Passthrough,
    RadialGradient: Passthrough,
    Rect: Passthrough,
    Stop: Passthrough,
  };
});

const mockStaticGradient = { value: false };
jest.mock('@/lib/stores/display-prefs-store', () => ({
  useDisplayPrefsStore: (sel: (s: { staticGradient: boolean }) => unknown) =>
    sel({ staticGradient: mockStaticGradient.value }),
}));

import AbstractGradientBackdrop, {
  backdropMetrics,
  COLOR_STEP_MS,
} from '../AbstractGradientBackdrop';
import HeaderWorkingGradient, { PEAK_ALPHA, WORK_LEG_MS } from '../HeaderWorkingGradient';

function makeNavigation(focused: boolean) {
  return { isFocused: () => focused, addListener: () => () => {} } as never;
}

function renderStrip(active: boolean, focused = true) {
  return render(
    <NavigationContext.Provider value={makeNavigation(focused)}>
      <HeaderWorkingGradient active={active} />
    </NavigationContext.Provider>,
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  mockReduceMotion = false;
  mockStaticGradient.value = false;
  mockWithRepeat.mockClear();
  backdropMetrics.reset();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((() => ({ remove: () => {} })) as never);
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('HeaderWorkingGradient — at rest', () => {
  it('renders NOTHING when inactive, structurally', () => {
    // Not `opacity: 0`. This is what makes "the header at rest is exactly what
    // it is today" a fact about the tree rather than a claim about a number.
    expect(renderStrip(false).toJSON()).toBeNull();
  });

  it('renders nothing under reduced motion, even while active', () => {
    mockReduceMotion = true;
    expect(renderStrip(true).toJSON()).toBeNull();
  });

  it('renders nothing under the Static background setting, even while active', () => {
    mockStaticGradient.value = true;
    expect(renderStrip(true).toJSON()).toBeNull();
  });

  it('DOES render when active with both preferences off', () => {
    // The positive control for the three above: without it, a component that
    // always returned null would pass all of them.
    expect(renderStrip(true).toJSON()).not.toBeNull();
  });
});

describe('HeaderWorkingGradient — it is not the shared backdrop', () => {
  it('subscribes no instance and mounts no cover on the shared engine', () => {
    renderStrip(true);
    act(() => {
      jest.advanceTimersByTime(COLOR_STEP_MS * 2);
    });
    expect(backdropMetrics.instances).toBe(0);
    expect(backdropMetrics.peakLiveCovers).toBe(0);
    expect(backdropMetrics.coverMounts).toBe(0);
  });

  it('THE CONTROL: a real backdrop DOES move those numbers', () => {
    // Without this, "instances === 0" is satisfied just as well by metrics
    // that never move at all, which is exactly what a refactor to a stubbed
    // backdrop would produce.
    render(
      <NavigationContext.Provider value={makeNavigation(true)}>
        <AbstractGradientBackdrop />
      </NavigationContext.Provider>,
    );
    expect(backdropMetrics.instances).toBe(1);
  });

  it('coexists with a focused backdrop without adding a second live cover', () => {
    render(
      <NavigationContext.Provider value={makeNavigation(true)}>
        <>
          <AbstractGradientBackdrop />
          <HeaderWorkingGradient active />
        </>
      </NavigationContext.Provider>,
    );
    act(() => {
      jest.advanceTimersByTime(COLOR_STEP_MS);
    });
    expect(backdropMetrics.instances).toBe(1);
    expect(backdropMetrics.peakLiveCovers).toBeLessThanOrEqual(1);
  });
});

describe('HeaderWorkingGradient — the loop', () => {
  it('starts a ping-pong repeat when active and on screen', () => {
    renderStrip(true, true);
    expect(mockWithRepeat).toHaveBeenCalled();
    // -1 repeats, reverse=true: a ping-pong, not a sawtooth that snaps back.
    const [, count, reverse] = mockWithRepeat.mock.calls[0];
    expect(count).toBe(-1);
    expect(reverse).toBe(true);
  });

  it('does NOT start a loop on a blurred screen', () => {
    // Tabs stay mounted, so an ungated loop runs behind whatever the reader
    // walked off to. This strip is DECORATION — a blurred one is not on screen
    // and animating it is pure cost. (The narration LINE is gated differently,
    // on purpose: a frozen line reads as a hung app, a frozen background does
    // not, because nobody is looking at it.)
    renderStrip(true, false);
    expect(mockWithRepeat).not.toHaveBeenCalled();
  });

  it('does not start a loop while inactive', () => {
    renderStrip(false, true);
    expect(mockWithRepeat).not.toHaveBeenCalled();
  });

  it('does not start a loop under either motion preference', () => {
    mockReduceMotion = true;
    renderStrip(true, true);
    expect(mockWithRepeat).not.toHaveBeenCalled();

    mockWithRepeat.mockClear();
    mockReduceMotion = false;
    mockStaticGradient.value = true;
    renderStrip(true, true);
    expect(mockWithRepeat).not.toHaveBeenCalled();
  });

  it('leaves no timer armed after unmount', () => {
    // Unmount is the normal end of a run, not an edge case.
    const { unmount } = renderStrip(true, true);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('HeaderWorkingGradient — the layers', () => {
  // EVERY query here passes `includeHiddenElements`. The strip is hidden from
  // the accessibility tree on purpose, and RNTL's default query respects that
  // — which is itself the cleanest proof the hiding works, asserted below.
  const HIDDEN = { includeHiddenElements: true } as const;

  it('draws exactly two layers, and only the top one animates', () => {
    const { getAllByTestId, getByTestId } = renderStrip(true);
    // One fixed base plus one cross-fading cover. A third would mean the
    // "two layers, identical geometry" rule has quietly grown a friend.
    expect(getAllByTestId('strip-svg', HIDDEN)).toHaveLength(2);
    expect(getByTestId('header-working-gradient-blend', HIDDEN)).toBeTruthy();
  });

  it('swallows no touches on any layer', () => {
    // A full-width band across the header that is not a control must never
    // eat a pull-to-refresh pan. Same rule the header rows follow.
    const { getByTestId, getAllByTestId } = renderStrip(true);
    expect(getByTestId('header-working-gradient', HIDDEN).props.pointerEvents).toBe('none');
    expect(getByTestId('header-working-gradient-blend', HIDDEN).props.pointerEvents).toBe(
      'none',
    );
    for (const svg of getAllByTestId('strip-svg', HIDDEN)) {
      expect(svg.props.pointerEvents).toBe('none');
    }
  });

  it('is hidden from assistive technology — the narration line carries the meaning', () => {
    const { getByTestId, queryByTestId } = renderStrip(true);
    const root = getByTestId('header-working-gradient', HIDDEN);
    expect(root.props.accessibilityElementsHidden).toBe(true);
    expect(root.props.importantForAccessibility).toBe('no-hide-descendants');
    // And the consequence, from the outside: a default query, which is what a
    // screen reader effectively does, cannot see it at all.
    expect(queryByTestId('header-working-gradient')).toBeNull();
  });
});

describe('HeaderWorkingGradient — the tuning is deliberate', () => {
  it('is much slower than an affordance nudge and much faster than the backdrop', () => {
    // ~3.5x the 800-900ms nudge register, so it does not read as progress;
    // 7.5x faster than the backdrop's colour step, so it reads as the quicker
    // of the two surfaces rather than competing with it.
    expect(WORK_LEG_MS).toBeGreaterThan(2000);
    expect(WORK_LEG_MS * 2).toBeLessThan(COLOR_STEP_MS / 3);
  });

  it('keeps peak alpha low, because the colour sits ON the glass not under it', () => {
    expect(PEAK_ALPHA).toBeGreaterThan(0);
    expect(PEAK_ALPHA).toBeLessThanOrEqual(0.25);
  });
});
