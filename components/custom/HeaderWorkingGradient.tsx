// The header's "working" strip: a faster, smaller cousin of the app backdrop,
// painted behind the title row while a sync is really running.
//
// It exists so the surface itself reads as busy, not just the words on it. The
// words say what is happening; this says it is still happening, without a
// number, a bar or a percentage — all three of which are the arrival-
// anticipation billboard `7e96aa4` deleted from this exact header.
//
// ## It is NOT an AbstractGradientBackdrop
//
// That component runs a MODULE-GLOBAL colour clock shared across ~66 mount
// sites, and its `backdropMetrics` carries a "two live covers" alarm for
// exactly the kind of second animated layer this would otherwise become.
// Reusing it here is the shortcut a future editor will reach for, so the test
// asserts `backdropMetrics.instances === 0` after rendering this, which no
// stub and no inert render can satisfy — only actually reusing the backdrop
// can fail it.
//
// ## Why it mounts ABOVE `GlassPlate`, not below
//
// Three reasons agree, and the third is decisive:
//   1. Android's `GLASS_HEADER_ANDROID_GRADIENT` starts at rgba(8,8,10,0.95)
//      and would simply bury it.
//   2. Transmission under the plate is about (1 − 0.42)(1 − 0.16) ≈ 0.49, so
//      half the colour is lost before anyone sees it.
//   3. A `GlassView` RE-SAMPLES its backdrop every frame that backdrop
//      changes, and that resampling is 8.2 of the 21.2 measured CPU points in
//      the backdrop's own table. Below the plate, this would convert the app's
//      most expensive documented term from a ~2.7% duty cycle to 100% for the
//      length of every sync.
// The cost is that the colour sits ON the glass rather than refracting
// through it, mitigated with a low peak alpha and a soft falloff.
//
// ## Reanimated, and it is not close for this shape
//
// Two pre-rasterised gradient layers rasterise ONCE at activation and become
// cached textures, so the per-frame work is a compositor blend of something
// already drawn — the cheapest animated composite either platform has. Lottie
// would be a vector renderer re-evaluating paths every frame to do what one
// opacity blend does; it earns its keep for the six illustrated stage scenes
// in `components/custom/processing/`, not here.
//
// Only a VIEW OPACITY animates, which is the one cheap path this codebase has
// found. An SVG `<Stop>`'s `stopColor` cannot be animated at all (`Stop.render()`
// returns null) and an animated `<G transform>` re-rasterises on the CPU every
// frame. Never `interpolateColor` into a gradient stop.
//
// ## A slower animation is not a cheaper one
//
// Energy goes as frames × pixels, so a 3s leg costs the same per second as a
// 1s leg. `WORK_LEG_MS` is a perceptual choice, not a power one. The levers
// that actually matter, in order: not sitting under a blur that re-samples
// (see above), painted area, never re-rasterising, and TOTAL SECONDS ACTIVE.
// The last one is what the gate and the `null` at rest are for.

import React from 'react';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { PALETTE } from '@/components/custom/AbstractGradientBackdrop';
import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';

/**
 * One leg of the ping-pong, so a round trip is ~6s.
 *
 * About 3.5x slower than the 800-900ms affordance-nudge register, so it does
 * not read as a progress indicator, and 7.5x faster than the app backdrop's
 * `COLOR_STEP_MS` of 45s, so it is unmistakably the quicker of the two.
 */
export const WORK_LEG_MS = 3000;

/**
 * Peak alpha of the strip, kept low on purpose.
 *
 * The colour sits ON the glass rather than refracting through it (see the
 * mount-order note above), so the same alpha reads considerably stronger here
 * than it would under the plate.
 */
export const PEAK_ALPHA = 0.18;

/** Two house hues, far enough apart to read as a change and not as a flicker. */
const HUE_A = PALETTE[0]; // warm accent
const HUE_B = PALETTE[1]; // house blue

const ANDROID_CSS_GRADIENT = Platform.OS === 'android';

export interface HeaderWorkingGradientProps {
  /** True only while there is real work in flight. */
  readonly active: boolean;
  readonly testID?: string;
}

/**
 * One layer. Identical geometry on both; only the hue differs.
 *
 * NO OFFSET between the two, deliberately. An offset gives the cross-fade an
 * apparent direction of travel, and a directional gradient in this header is
 * `FeedStatusShimmer` again — the thing that was deleted for making the header
 * about arrival.
 */
const Layer: React.FC<{ hue: string; gradientId: string }> = ({ hue, gradientId }) => {
  if (ANDROID_CSS_GRADIENT) {
    // Android draws it as a CSS background rather than SVG, the same split
    // `SectionGradientPanel` uses and for the same reason: RNSVG resolves
    // `height="100%"` against the size at FIRST layout and never re-measures,
    // and this strip sits in a header that changes height. A background
    // drawable is re-shaded against the view's CURRENT bounds on every draw.
    //
    // Four reasons this animates on Android while the app backdrop does not,
    // written here so nobody cites this file as grounds to un-static that one:
    // there is no RNSVG node at all on this path (the crash was
    // `RNSVGSvgView` in `dispatchGetDisplayList`), there is at most ONE
    // animating instance instead of ~47, the duration is bounded by the sync
    // rather than unbounded, and there is no blur above it to re-sample.
    //
    // Alpha is baked into the stops because CSS has no `stopOpacity`, and the
    // far stop is the SAME hue at alpha 0 — never the keyword `transparent`,
    // which is rgba(0,0,0,0) and drags the falloff through grey.
    return (
      <View
        pointerEvents="none"
        style={
          {
            ...StyleSheet.absoluteFillObject,
            experimental_backgroundImage:
              `linear-gradient(to bottom right, ${rgba(hue, PEAK_ALPHA)} 0%, ` +
              `${rgba(hue, PEAK_ALPHA * 0.35)} 55%, ${rgba(hue, 0)} 100%)`,
          } as unknown as ViewStyle
        }
      />
    );
  }
  return (
    <Svg
      width="100%"
      height="100%"
      preserveAspectRatio="none"
      pointerEvents="none"
      style={StyleSheet.absoluteFillObject}
    >
      <Defs>
        <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={hue} stopOpacity={PEAK_ALPHA} />
          <Stop offset="0.55" stopColor={hue} stopOpacity={PEAK_ALPHA * 0.35} />
          <Stop offset="1" stopColor={hue} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
};

/** `rgb(r,g,b)` -> `rgba(r,g,b,a)`, for the CSS branch's baked stops. */
function rgba(rgb: string, alpha: number): string {
  return rgb.replace(/^rgb\(/, 'rgba(').replace(/\)$/, `,${alpha})`);
}

export const HeaderWorkingGradient: React.FC<HeaderWorkingGradientProps> = ({
  active,
  testID = 'header-working-gradient',
}) => {
  const reduceMotion = useReducedMotion();
  const staticGradient = useDisplayPrefsStore((s) => s.staticGradient);
  // `focused && foregrounded`. `ProcessingStageAnimation.tsx:27-49` argues this
  // out for the closest sibling: the `use-is-focused-safe` warning against
  // gating a LIVENESS signal applies to something narrower than "anyone is
  // looking", and a blurred screen has nobody to form a hung impression. The
  // cost of leaving it ungated is the one that file names — tabs stay mounted,
  // so a loop would run behind whatever the reader walked off to.
  const animationsActive = useAnimationsActive();

  const blend = useSharedValue(0);
  // Both preferences stop the MOTION. The state is still carried by the mark,
  // the narration line and the status panel, none of which are animations.
  const animates = active && animationsActive && !reduceMotion && !staticGradient;

  React.useEffect(() => {
    if (!animates) {
      blend.value = 0;
      return;
    }
    // A ping-pong on the UI thread. NO JS TICK: unlike the app backdrop, which
    // needs an interval because it swaps colours and re-rasterises, these two
    // layers are fixed and re-render zero times for the whole sync.
    blend.value = withRepeat(withTiming(1, { duration: WORK_LEG_MS }), -1, true);
    return () => {
      blend.value = 0;
    };
  }, [animates, blend]);

  const topLayerStyle = useAnimatedStyle(() => ({ opacity: blend.value }));

  // STRUCTURAL, not `opacity: 0`. "At rest the header is exactly what it is
  // today" is then a property of the tree rather than a claim about a number,
  // and it is asserted as `toJSON() === null`.
  if (!active || reduceMotion || staticGradient) return null;

  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFillObject}
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* Layer A is fixed at opacity 1; layer B cross-fades over it. Only a
          view opacity ever animates. */}
      <Layer hue={HUE_A} gradientId="hdr-work-a" />
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFillObject, topLayerStyle]}
        testID={`${testID}-blend`}
      >
        <Layer hue={HUE_B} gradientId="hdr-work-b" />
      </Animated.View>
    </View>
  );
};

export default HeaderWorkingGradient;
