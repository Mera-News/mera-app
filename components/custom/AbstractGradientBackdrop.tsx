import React, { useEffect, useState } from 'react';
import { AppState, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

/**
 * The app-wide background for the five tab pages: a slowly drifting,
 * colour-shifting field of soft blobs.
 *
 * Mounted once in `app/logged-in/app_container/_layout.tsx` — see the comment
 * there for why it lives in the layout and not inside the screens.
 *
 * ## Why this exists
 *
 * Liquid Glass refracts whatever is BEHIND it. The app is dark-mode only on a
 * pure-black page, so glass cards over black render as black — the effect is
 * present but invisible. This backdrop gives the glass something to refract,
 * and because it keeps moving, the colour under a stationary card keeps
 * changing.
 *
 * ## Cost, and why it is shaped this way
 *
 * An always-on background animation is a battery question, so the engine is
 * deliberately the cheapest thing that produces the effect:
 *
 *   • **One clock.** A single shared value ramps 0→1 linearly and repeats.
 *     Every blob's motion is a sine of that one clock at an integer harmonic
 *     with its own phase offset, so the whole field is driven by `Math.sin` on
 *     one number — roughly a dozen float ops per frame across all three blobs.
 *     Integer harmonics also make the loop seamless: `sin(2πk·clock)` returns
 *     to itself at clock = 1, so there is no reversal and no visible seam.
 *   • **One colour timer.** A single interval, one tick per `COLOR_STEP_MS`,
 *     drives all three cross-fades together. Three blobs do NOT mean three
 *     timers.
 *   • **Nothing runs in the background.** The clock is cancelled and the timer
 *     cleared as soon as the app leaves the foreground, and restarted on
 *     return. A backgrounded app animates nothing.
 *   • **Reduce Motion is honoured** — the field renders as a static frame with
 *     no clock, no timer, and no animated styles at all. That is both the
 *     accessibility behaviour and the cheapest possible mode.
 *
 * The per-frame CPU cost is negligible by construction; what remains is the
 * GPU compositing six full-screen layers, which is the irreducible price of an
 * animated background and the reason the foreground gate matters.
 *
 * ## Colours
 *
 * A fixed palette tuned for a near-black page — every entry is a mid-to-light
 * tone, because a dark one composited at these low alphas is indistinguishable
 * from the background. Three are the app's own accents from
 * `components/ui/gluestack-ui-provider/config.ts`; the rest are neighbours in
 * the same brightness band, so no random draw lands on a colour that reads as
 * muddy or blows out the white text above it. Each blob walks its own random
 * path through the palette, drawn once at mount.
 *
 * ## The trap worth knowing
 *
 * Colour is an opacity cross-fade between two stacked copies of each blob
 * rather than an animated gradient stop, because **you cannot animate a
 * `<Stop>`'s `stopColor`**: `react-native-svg`'s `Stop.render()` returns
 * `null` — it is not a native node, just a props carrier the parent gradient
 * reads at render time — so `Animated.createAnimatedComponent(Stop)` has
 * nothing to drive and the colour would silently never change.
 *
 * ## Rendering
 *
 * `react-native-svg`, matching `SectionGradientPanel` — already in the binary,
 * so this ships OTA with no new native dependency. The three-stop falloff
 * (peak → ~⅓ peak at the halfway ring → transparent) approximates a gaussian
 * blur without a filter, which RN's SVG backend renders inconsistently.
 *
 * Each blob's `cx`/`cy`/`r` are fractions under the default `objectBoundingBox`
 * gradient units over a full-layer rect, which stretches each circle into an
 * ellipse matching the screen's aspect ratio — the wide, soft ovals the design
 * calls for, for free.
 */

const PALETTE = [
  'rgb(231,138,83)', // primary-400   — house warm accent
  'rgb(13,166,242)', // info-400      — house blue
  'rgb(125,152,152)', // secondary-500 — muted teal
  'rgb(150,120,220)', // violet
  'rgb(214,110,140)', // rose
  'rgb(110,190,160)', // sea green
] as const;

/** One full orbit of the drift. Long on purpose: this is ambient, not a
 *  transition, and a slower clock is a cheaper clock to look at. */
const CYCLE_MS = 48000;
/** How long each colour cross-fade takes, and therefore how often the single
 *  colour timer ticks. */
const COLOR_STEP_MS = 10000;
/** Colours each blob visits before its cycle repeats. */
const SEQUENCE_LENGTH = 5;

/**
 * Each blob's layer is drawn at DOUBLE the screen size, centred, so the screen
 * sits in the middle half of it (fraction 0.25 → 0.75 on both axes).
 *
 * This is REQUIRED, not padding. A blob layer sized exactly to the screen has a
 * hard boundary where its gradient rect ends, and the gradient still carries
 * real alpha there (a blob centred near an edge is nowhere near faded out by
 * the time it reaches the opposite one). Translating such a layer drags that
 * boundary into view as a visible rectangle edge. Oversizing keeps every
 * boundary off-screen at the extremes of both the drift and the scale.
 *
 * Margin check, worst case (largest drift 110pt, smallest scale 0.9), on a
 * 402pt-wide screen: the layer's own half-width is 402, so the nearest edge
 * lands at 0.9 × 402 − 110 = 252pt from centre against a 201pt half-screen —
 * roughly 50pt of clearance. Widen `dx`/`dy` or deepen `amp` and this has to be
 * rechecked.
 */
const OVERSCAN = 2;

/** Screen fraction → layer fraction, given the layer is `OVERSCAN`× the screen
 *  and centred on it. Lets the blob positions below stay written in the
 *  coordinates that actually matter (where they sit on screen). */
const onScreen = (f: number) => (f + (OVERSCAN - 1) / 2) / OVERSCAN;
/** Screen-relative radius → layer-relative, same reasoning. */
const radius = (r: number) => r / OVERSCAN;

/**
 * Per-blob geometry, motion and phase. `cx`/`cy`/`r` are written as SCREEN
 * fractions and converted to the oversized layer's coordinates above.
 *
 * `dx`/`dy` are drift extents in POINTS, large on purpose: a soft blob
 * spanning most of the screen has to travel a long way before the eye reads it
 * as moving. `alpha` is peak opacity — the knob worth tuning, high enough that
 * glass has something to refract, low enough that white text over an uncovered
 * gap keeps its contrast. `phase` desynchronises the three so the field never
 * pulses as one. `amp` is capped so scale never dips below 0.9 — see the
 * margin check above.
 */
const BLOBS = [
  { cx: onScreen(0.78), cy: onScreen(0.12), r: radius(0.7), alpha: 0.38, dx: 90, dy: 70, amp: 0.1, phase: 0 },
  { cx: onScreen(0.22), cy: onScreen(0.46), r: radius(0.75), alpha: 0.34, dx: -110, dy: 85, amp: 0.1, phase: 0.37 },
  { cx: onScreen(0.6), cy: onScreen(0.88), r: radius(0.65), alpha: 0.28, dx: 75, dy: -95, amp: 0.1, phase: 0.71 },
] as const;

const TAU = Math.PI * 2;

/** The oversized layer box: `OVERSCAN`× the screen on both axes, centred. */
const LAYER: ViewStyle = {
  position: 'absolute',
  left: `${-((OVERSCAN - 1) / 2) * 100}%`,
  top: `${-((OVERSCAN - 1) / 2) * 100}%`,
  width: `${OVERSCAN * 100}%`,
  height: `${OVERSCAN * 100}%`,
};

/** FNV-1a 32-bit — the same hash `lib/section-color.ts` uses to key a fact's
 *  colour, so a seeded backdrop is stable across launches and screens. */
function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32 — a tiny deterministic PRNG. Given a seed the whole field is
 *  reproducible; given none we fall back to `Math.random` so unseeded surfaces
 *  still differ from each other. */
function makeRandom(seed?: string): () => number {
  if (seed === undefined) return Math.random;
  let a = hashString(seed) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A walk through `PALETTE` that never repeats a colour back-to-back, including
 * across the wrap from last entry to first — the sequence is indexed modulo its
 * length and runs forever, so that seam is a real adjacency.
 */
function colorSequence(rand: () => number): string[] {
  const seq: string[] = [PALETTE[Math.floor(rand() * PALETTE.length)]];
  for (let i = 1; i < SEQUENCE_LENGTH; i++) {
    const isLast = i === SEQUENCE_LENGTH - 1;
    let next: string;
    do {
      next = PALETTE[Math.floor(rand() * PALETTE.length)];
    } while (next === seq[i - 1] || (isLast && next === seq[0]));
    seq.push(next);
  }
  return seq;
}

type BlobSpec = (typeof BLOBS)[number];

/** One static, single-colour copy of a blob. Memoized so a colour tick only
 *  rebuilds the layer whose colour actually changed. */
const BlobLayer = React.memo<{ spec: BlobSpec; color: string; gradientId: string }>(
  ({ spec, color, gradientId }) => (
    <Svg width="100%" height="100%">
      <Defs>
        <RadialGradient id={gradientId} cx={spec.cx} cy={spec.cy} r={spec.r}>
          <Stop offset="0" stopColor={color} stopOpacity={spec.alpha} />
          <Stop offset="0.5" stopColor={color} stopOpacity={spec.alpha * 0.34} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  )
);
BlobLayer.displayName = 'BlobLayer';

interface BlobProps {
  spec: BlobSpec;
  index: number;
  step: number;
  /** The shared 0→1 clock. */
  clock: { value: number };
  /** The shared 0↔1 colour cross-fade driver. */
  mix: { value: number };
  still: boolean;
  /** Optional determinism key — see `AbstractGradientBackdropProps.seed`. */
  seed?: string;
}

const Blob: React.FC<BlobProps> = ({ spec, index, step, clock, mix, still, seed }) => {
  // Drawn once at mount: re-rolling on a re-render would jump the colour. The
  // blob index is folded into the seed so the three blobs never draw the same
  // sequence as each other on a seeded surface.
  const [sequence] = useState(() =>
    colorSequence(makeRandom(seed === undefined ? undefined : `${seed}#${index}`))
  );

  // A closed Lissajous figure: x on the fundamental, y on the second harmonic,
  // scale on the third. All integer multiples of the same clock, so the path
  // closes exactly at clock = 1 and repeats forever without a seam.
  const layerStyle = useAnimatedStyle(() => {
    const a = TAU * (clock.value + spec.phase);
    return {
      transform: [
        { translateX: spec.dx * Math.sin(a) },
        { translateY: spec.dy * Math.cos(2 * a) },
        { scale: 1 + spec.amp * Math.sin(3 * a) },
      ],
    };
  });

  const styleA = useAnimatedStyle(() => ({ opacity: 1 - mix.value }));
  const styleB = useAnimatedStyle(() => ({ opacity: mix.value }));

  // The layer FADING IN takes the new colour; the outgoing one keeps what it
  // was showing until it is fully transparent. Reading the incoming layer at
  // `step` and the outgoing at `step - 1` is what creates that hold — swap
  // either and the outgoing layer jumps mid-fade.
  //
  // `+ index` staggers the blobs through their sequences so a shared tick does
  // not move all three to visually similar colours at once.
  const at = (i: number) =>
    sequence[(((i + index) % sequence.length) + sequence.length) % sequence.length];
  const colorA = at(step % 2 === 0 ? step : step - 1);
  const colorB = at(step % 2 === 1 ? step : step - 1);

  const idBase = `blob-grad-${index}`;

  if (still) {
    // Reduce Motion: one frame, no animated styles, no layers to cross-fade.
    // Still uses the oversized layer so the framing matches the animated case.
    return (
      <View style={LAYER}>
        <BlobLayer spec={spec} color={colorA} gradientId={`${idBase}-a`} />
      </View>
    );
  }

  return (
    <Animated.View style={[LAYER, layerStyle]}>
      <Animated.View style={[StyleSheet.absoluteFill, styleA]}>
        <BlobLayer spec={spec} color={colorA} gradientId={`${idBase}-a`} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, styleB]}>
        <BlobLayer spec={spec} color={colorB} gradientId={`${idBase}-b`} />
      </Animated.View>
    </Animated.View>
  );
};

export interface AbstractGradientBackdropProps {
  /**
   * Makes this backdrop's colours deterministic and distinct per key. Pass a
   * stable id (e.g. a fact id) and that surface always draws the same palette
   * walk, while a different id draws a different one — so two fact lists are
   * recognisably different backgrounds rather than the same animation twice.
   *
   * Omit it and the colours are drawn from `Math.random` at mount, which is
   * what the tab pages want: no identity to key off, just variety.
   */
  seed?: string;
}

const AbstractGradientBackdropImpl: React.FC<AbstractGradientBackdropProps> = ({ seed }) => {
  const reduceMotion = useReducedMotion();

  const clock = useSharedValue(0);
  const mix = useSharedValue(0);
  const [step, setStep] = useState(0);

  // One clock and one timer for the whole field, both gated on the app being
  // in the foreground — a backgrounded app animates nothing.
  useEffect(() => {
    if (reduceMotion) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      // Restart from 0 rather than resuming mid-cycle: the loop is seamless at
      // the boundary, and any positional jump happens while the app is not on
      // screen.
      clock.value = 0;
      clock.value = withRepeat(
        withTiming(1, { duration: CYCLE_MS, easing: Easing.linear }),
        -1,
        false
      );
      timer = setInterval(() => setStep((s) => s + 1), COLOR_STEP_MS);
    };

    const stop = () => {
      cancelAnimation(clock);
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') start();
      else stop();
    });

    return () => {
      sub.remove();
      stop();
    };
  }, [clock, reduceMotion]);

  // Cross-fade toward the parity of the current step. Driven by the same tick
  // as the colour swap, so the fade always takes exactly one step.
  useEffect(() => {
    if (reduceMotion) return;
    mix.value = withTiming(step % 2 === 0 ? 0 : 1, {
      duration: COLOR_STEP_MS,
      easing: Easing.inOut(Easing.ease),
    });
  }, [mix, step, reduceMotion]);

  return (
    // `pointerEvents` goes on a plain RN View, NOT on the Svg. `Svg` is
    // `RNSVGSvgView`, which does its own hit-testing and does not reliably
    // honour the prop — and this is an absolute fill over the ENTIRE screen, so
    // a swallowed touch would make every tab untappable.
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {BLOBS.map((spec, i) => (
        <Blob
          key={`blob-${i}`}
          spec={spec}
          index={i}
          step={step}
          clock={clock}
          mix={mix}
          still={reduceMotion}
          seed={seed}
        />
      ))}
    </View>
  );
};

/** Static: nothing about it depends on props, so the screens above it never
 *  re-render the animation. */
export const AbstractGradientBackdrop = React.memo(AbstractGradientBackdropImpl);
AbstractGradientBackdrop.displayName = 'AbstractGradientBackdrop';

export default AbstractGradientBackdrop;
