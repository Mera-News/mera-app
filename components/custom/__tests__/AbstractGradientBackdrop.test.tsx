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
    // Real per-instance identity, not a fresh object per render — the base
    // layer's gate is written during render and read by the style worklet, so a
    // mock that forgot the value between renders would make every assertion
    // below vacuous.
    useSharedValue: (initial: number) => {
      const { useRef } = require('react');
      return useRef({ value: initial }).current;
    },
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

describe('complementary cross-fade (the flash guard)', () => {
  // A `BlobField` is translucent everywhere (peak stop alpha 0.38, no background
  // fill), so the cover does NOT hide the layer beneath it. Leaving the base at
  // opacity 1 while the cover mounts at 1 STACKS them — composite alpha at a
  // blob centre jumps ~0.38 -> ~0.62 for one frame and then decays over
  // FADE_MS. That one-frame pop is the "flash" this suite exists to prevent,
  // and the ONLY thing that prevents it is the base layer being driven to the
  // complement of the cover's opacity.
  //
  // Note these read the opacity as of the COMMIT that first paints the new
  // colours — which is exactly the frame the bug lived in.

  /** The rendered opacity of one of the two backdrop layers. */
  const layerOpacity = (queryFn: (id: string) => any, testID: string): number | undefined => {
    const style = queryFn(testID)?.props?.style;
    const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
    return flat?.opacity;
  };

  it('drives the base layer to fully transparent in the commit that mounts the cover', () => {
    const { getByTestId } = render(<Mounted focused />);
    expect(layerOpacity(getByTestId, 'backdrop-base')).toBe(1);

    advanceOneStep();

    // Cover opaque + base transparent === the screen still shows exactly the
    // previous colours. Nothing pops, because nothing was added.
    expect(layerOpacity(getByTestId, 'backdrop-cover')).toBe(1);
    expect(layerOpacity(getByTestId, 'backdrop-base')).toBe(0);
  });

  it('commits the base layer at 0 as a PLAIN style, not only an animated one', () => {
    // reanimated's PropsFilter replaces an animated style entry with the
    // snapshot taken at that component's FIRST render whenever the component
    // re-renders. The base layer first renders at rest, so its snapshot is
    // `{opacity: 1}` — every later commit re-asserts 1, the stacked-pop value,
    // and the real value only lands afterwards via the UI-thread mapper. A
    // plain object is passed through verbatim instead, so it is what actually
    // makes the safe value part of the commit. An animated style alone here
    // would leave one frame of the flash.
    const { getByTestId } = render(<Mounted focused />);
    advanceOneStep();

    const entries = getByTestId('backdrop-base').props.style as any[];
    const plain = entries.filter(
      (e) => e && typeof e === 'object' && !Array.isArray(e) && e.opacity === 0,
    );
    expect(plain.length).toBeGreaterThan(0);
    // ...and it must be LAST, or the animated entry's stale 1 flattens over it.
    expect(entries[entries.length - 1]).toMatchObject({ opacity: 0 });
  });

  it('leaves a blurred instance at full density while the focused one cross-fades', () => {
    // The regression this catches is specific: `outgoing` is module-global, so
    // driving the base from it WITHOUT the per-instance gate would fade every
    // resident tab's background toward black whenever any one of them stepped.
    const { getByTestId } = render(
      <RNView>
        <Mounted focused={false} />
      </RNView>,
    );

    render(<Mounted focused />);
    advanceOneStep();

    expect(layerOpacity(getByTestId, 'backdrop-base')).toBe(1);
  });

  it('releases the base layer when the cover is suppressed mid-fade', () => {
    // Blurring a tab (or switching on "Static background") mid-fade drops the
    // cover. If the base stayed gated it would be stranded at whatever partial
    // opacity the fade had reached — a permanently dimmed background until the
    // next step.
    const { getByTestId, rerender } = render(<Mounted focused />);
    advanceOneStep();
    expect(layerOpacity(getByTestId, 'backdrop-base')).toBe(0);

    mockStaticGradient.value = true;
    act(() => {
      rerender(<Mounted focused />);
    });

    expect(layerOpacity(getByTestId, 'backdrop-base')).toBe(1);
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
