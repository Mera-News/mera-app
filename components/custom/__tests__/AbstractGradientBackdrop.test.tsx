// AbstractGradientBackdrop.test — the two things a future edit could silently
// undo, both of which were measured rather than guessed.
//
// The backdrop's entire cost is compositing full-screen layers, not JS. On the
// iPhone 17 Pro simulator, Feed idle, two 10-minute windows differing ONLY by
// whether colour cross-fades happen:
//
//     animated 21.2% CPU  vs  static 6.6% CPU   (backboardd 6.9% -> 1.1%)
//
// Two properties follow from that, and this file guards both:
//
//   1. LAYER DUTY CYCLE — the fraction of wall-clock time a second full-screen
//      Svg is mounted. Restoring the old 2500ms/10000ms pair puts it back to
//      25%, which is what the measurement above priced.
//   2. ONE COVER AT A TIME — five tabs stay resident and there are ~75 mount
//      sites, so an ungated cover multiplies that duty cycle by the number of
//      mounted screens. Only the focused instance may mount one.

import React from 'react';
import { AppState, View as RNView } from 'react-native';
import { render, act } from '@testing-library/react-native';
import { NavigationContext } from '@react-navigation/native';

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View: (p: any) => <View {...p} /> },
    Easing: { inOut: (f: unknown) => f, ease: 'ease' },
    makeMutable: (initial: unknown) => ({ value: initial }),
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useReducedMotion: () => false,
    withTiming: (v: unknown) => v,
  };
});

jest.mock('react-native-svg', () => {
  const { View } = require('react-native');
  const Passthrough = (p: any) => <View {...p} />;
  return {
    __esModule: true,
    default: (p: any) => <View testID="blob-field" {...p} />,
    Defs: Passthrough,
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
  FADE_MS,
} from '../AbstractGradientBackdrop';

/** Minimal stand-in for a react-navigation route object, matching the shape
 *  `use-is-focused-safe` reads. */
function makeNavigation(focused: boolean) {
  return {
    isFocused: () => focused,
    addListener: () => () => {},
  } as never;
}

function Mounted({ focused }: { focused: boolean }) {
  return (
    <NavigationContext.Provider value={makeNavigation(focused)}>
      <AbstractGradientBackdrop />
    </NavigationContext.Provider>
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  mockStaticGradient.value = false;
  backdropMetrics.reset();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((() => ({ remove: () => {} })) as never);
  Object.defineProperty(AppState, 'currentState', {
    value: 'active',
    configurable: true,
  });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** Drives the shared colour timer one full step. */
const advanceOneStep = () =>
  act(() => {
    jest.advanceTimersByTime(COLOR_STEP_MS);
  });

describe('layer duty cycle (B1.1)', () => {
  // The measurement priced a 25% duty cycle at +14.6 points of CPU. This is the
  // guard that a future "make the colours change more often" edit has to argue
  // with explicitly rather than trip over.
  it('keeps a second full-screen layer mounted for under 5% of wall-clock time', () => {
    expect(FADE_MS / COLOR_STEP_MS).toBeLessThan(0.05);
  });

  // Deliberately NOT asserting a perceptual threshold — "how short is too
  // short before a cross-fade reads as a cut" is not something this suite has
  // measured, and inventing a number here would dress a guess up as a limit.
  // The only property that is actually load-bearing is that a fade is still a
  // fade: non-zero, and short relative to the step.
  it('still cross-fades rather than cutting', () => {
    expect(FADE_MS).toBeGreaterThan(0);
    expect(FADE_MS).toBeLessThan(COLOR_STEP_MS);
  });
});

describe('focus gating (B1.2)', () => {
  it('mounts a cover on the focused instance when the colour steps', () => {
    render(<Mounted focused />);
    expect(backdropMetrics.coverMounts).toBe(0);

    advanceOneStep();
    expect(backdropMetrics.coverMounts).toBe(1);
    expect(backdropMetrics.liveCovers).toBe(1);
  });

  it('mounts NO cover on a blurred instance', () => {
    render(<Mounted focused={false} />);

    advanceOneStep();
    expect(backdropMetrics.coverMounts).toBe(0);
    expect(backdropMetrics.liveCovers).toBe(0);
  });

  it('mounts exactly one cover with several instances resident, as the tabs are', () => {
    // Four resident screens, one focused — the real shape: five tabs stay
    // mounted and any pushed stack screens stay mounted under them.
    render(
      <RNView>
        <Mounted focused />
        <Mounted focused={false} />
        <Mounted focused={false} />
        <Mounted focused={false} />
      </RNView>,
    );

    advanceOneStep();

    expect(backdropMetrics.coverMounts).toBe(1);
    expect(backdropMetrics.peakLiveCovers).toBe(1);
    // The regression this exists to catch: an ungated cover would mount one per
    // instance, so this number would track `instances` instead of staying at 1.
    expect(backdropMetrics.instances).toBe(4);
  });

  it('unmounts the cover when the fade completes, leaving one layer at rest', () => {
    render(<Mounted focused />);
    advanceOneStep();
    expect(backdropMetrics.liveCovers).toBe(1);

    act(() => {
      jest.advanceTimersByTime(FADE_MS);
    });

    expect(backdropMetrics.liveCovers).toBe(0);
    expect(backdropMetrics.coverMsTotal).toBeGreaterThanOrEqual(0);
  });

  it('mounts no cover in static mode even when focused', () => {
    mockStaticGradient.value = true;
    render(<Mounted focused />);

    advanceOneStep();

    expect(backdropMetrics.coverMounts).toBe(0);
  });
});

describe('the shared step advances regardless of focus', () => {
  // Load-bearing: the cover is gated on focus, the ENGINE is not. If the step
  // stopped advancing for blurred instances they would wake to a stale colour
  // and fade through colours the user already passed.
  it('advances the step counter while every instance is blurred', () => {
    render(<Mounted focused={false} />);

    advanceOneStep();
    advanceOneStep();

    expect(backdropMetrics.steps).toBe(2);
  });
});
