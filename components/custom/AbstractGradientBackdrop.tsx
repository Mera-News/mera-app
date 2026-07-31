import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  makeMutable,
  useAnimatedStyle,
  useReducedMotion,
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
const OVERSCAN = 1;

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


/**
 * The oversize now lives on the RECT INSIDE the Svg, not on the hosting view.
 *
 * This is a memory decision, not a cosmetic one. A React Native view's backing
 * store is proportional to its area, so an `OVERSCAN`× view is OVERSCAN²×
 * the pixels — at 2× that is 4× a full screen, and the old structure had SIX of
 * them per backdrop (3 blobs × 2 cross-fade copies). Multiplied by the tab
 * screens that stay mounted it reached ~1.5 GB of backing store.
 *
 * Keeping the Svg exactly screen-sized and oversizing the rect inside it gives
 * the identical picture — the rect still extends far enough that drift never
 * drags a gradient boundary into view — while the Svg viewport clips to the
 * screen, so nothing off-screen is ever rasterised.
 */

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


/* ────────────────────────────────────────────────────────────────────────────
 * THE SHARED ENGINE
 *
 * There is ONE animation for the whole app, not one per mounted backdrop.
 *
 * Why this matters: the backdrop cannot be mounted a single time. expo-router
 * wraps every tab's content in an opaque `View` (navigation theme background),
 * and native-stack screens must stay opaque or you see the outgoing screen
 * through the incoming one mid-push. So the component is mounted per screen —
 * dozens of times.
 *
 * Left to itself each of those instances would run its own clock and draw its
 * own random palette at mount, which is exactly what made every screen look
 * different and made a single screen change colours when you navigated away and
 * back. Hoisting the clock, the cross-fade driver, the step counter and the
 * colour sequences to module scope makes every instance render the IDENTICAL
 * frame of the IDENTICAL animation. Visually and behaviourally it is one
 * background; the instances are just render targets.
 *
 * It is also cheaper: one interval for the whole app regardless of how many
 * screens are mounted.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The shared 0↔1 colour cross-fade driver. */
const sharedMix = makeMutable(0);

/** The shared colour-step counter. Lives outside React because every instance
 *  must observe the same value; `useSyncExternalStore` subscribes them. */
const stepStore = {
  value: 0,
  listeners: new Set<() => void>(),
  get: () => stepStore.value,
  subscribe(fn: () => void) {
    stepStore.listeners.add(fn);
    return () => stepStore.listeners.delete(fn);
  },
  advance() {
    stepStore.value += 1;
    stepStore.listeners.forEach((fn) => fn());
  },
};

/** The app-wide colour sequences — one per blob, drawn once at module load.
 *  Every unseeded instance shares these, which is what makes the whole app one
 *  background rather than N random ones. */
const SHARED_SEQUENCES = BLOBS.map((_, i) => colorSequence(makeRandom(`house#${i}`)));

/** Refcount of mounted backdrops. The engine starts on the first and stops on
 *  the last, so nothing runs when no backdrop is on screen. */
let mountCount = 0;
let colorTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;
let running = false;

function startEngine() {
  if (running) return;
  running = true;
  colorTimer = setInterval(() => {
    stepStore.advance();
    sharedMix.value = withTiming(stepStore.value % 2 === 0 ? 0 : 1, {
      duration: COLOR_STEP_MS,
      easing: Easing.inOut(Easing.ease),
    });
  }, COLOR_STEP_MS);
}

function stopEngine() {
  if (!running) return;
  running = false;
  if (colorTimer) {
    clearInterval(colorTimer);
    colorTimer = null;
  }
}

/** Mount/unmount bookkeeping for one backdrop instance. The engine is gated on
 *  the app being in the foreground — a backgrounded app animates nothing. */
function useSharedEngine(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    mountCount += 1;
    if (mountCount === 1) {
      if (AppState.currentState === 'active') startEngine();
      appStateSub = AppState.addEventListener('change', (state) => {
        if (state === 'active') startEngine();
        else stopEngine();
      });
    }
    return () => {
      mountCount -= 1;
      if (mountCount === 0) {
        stopEngine();
        appStateSub?.remove();
        appStateSub = null;
      }
    };
  }, [enabled]);
}

type BlobSpec = (typeof BLOBS)[number];

/** One static, single-colour copy of a blob. Memoized so a colour tick only
 *  rebuilds the layer whose colour actually changed. */
/**
 * One colour phase of the whole field: a single screen-sized `Svg` holding all
 * three blobs as STATIC rects.
 *
 * ## Why nothing moves in here
 *
 * The blobs used to drift, and both ways of doing it were too expensive:
 *
 * - Animating a wrapping React Native view's `transform` is GPU-cheap, but the
 *   view has to be drawn larger than the screen or translating it drags the
 *   gradient's boundary into view — and an oversized layer costs its area in
 *   backing store, several times per backdrop, on every mounted screen.
 * - Animating an SVG `<G transform>` instead keeps the view screen-sized, but
 *   RNSVG rasterises on the CPU: moving a group forces a full-screen radial
 *   gradient to be RE-DRAWN every frame. That is what made the whole UI choppy,
 *   including in the simulator.
 *
 * So the drift is gone and the colour cross-fade stays. The cross-fade is a
 * view-opacity animation over two static, already-rasterised layers — pure GPU
 * compositing, no re-rasterisation, and no oversize needed because nothing
 * translates. The gradient still slowly shifts colour, which was the point.
 *
 * If drift ever comes back, it must not re-rasterise. Measure before shipping it.
 */
const BlobField: React.FC<{ colors: string[]; idBase: string }> = ({ colors, idBase }) => (
  <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
    <Defs>
      {BLOBS.map((spec, i) => (
        <RadialGradient key={i} id={`${idBase}-${i}`} cx={spec.cx} cy={spec.cy} r={spec.r}>
          <Stop offset="0" stopColor={colors[i]} stopOpacity={spec.alpha} />
          <Stop offset="0.5" stopColor={colors[i]} stopOpacity={spec.alpha * 0.34} />
          <Stop offset="1" stopColor={colors[i]} stopOpacity={0} />
        </RadialGradient>
      ))}
    </Defs>
    {BLOBS.map((_, i) => (
      <Rect key={i} x="0" y="0" width="100%" height="100%" fill={`url(#${idBase}-${i})`} />
    ))}
  </Svg>
);

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

  // One engine for the whole app — see THE SHARED ENGINE above. Reduce Motion
  // opts this instance out entirely: no clock, no timer, no animated styles.
  useSharedEngine(!reduceMotion);
  const step = useSyncExternalStore(stepStore.subscribe, stepStore.get, stepStore.get);

  // Unseeded surfaces share the app-wide sequences, which is what makes every
  // screen the same background. A seed opts out into its own deterministic walk
  // — the fact news-list keys it by fact id.
  const [sequences] = useState(() =>
    seed === undefined
      ? SHARED_SEQUENCES
      : BLOBS.map((_, i) => colorSequence(makeRandom(`${seed}#${i}`)))
  );

  // The field FADING IN takes the new colour; the outgoing one keeps what it
  // was showing until it is fully transparent. Reading the incoming at `step`
  // and the outgoing at `step - 1` is what creates that hold — swap either and
  // the outgoing field jumps mid-fade. `+ i` staggers the blobs so a shared
  // tick does not move all three to similar colours at once.
  const at = (seq: string[], i: number, n: number) =>
    seq[(((n + i) % seq.length) + seq.length) % seq.length];
  const colorsA = sequences.map((seq, i) => at(seq, i, step % 2 === 0 ? step : step - 1));
  const colorsB = sequences.map((seq, i) => at(seq, i, step % 2 === 1 ? step : step - 1));

  const styleA = useAnimatedStyle(() => ({ opacity: 1 - sharedMix.value }));
  const styleB = useAnimatedStyle(() => ({ opacity: sharedMix.value }));

  // `pointerEvents` goes on a plain RN View, NOT on the Svg. `Svg` is
  // `RNSVGSvgView`, which does its own hit-testing and does not reliably honour
  // the prop — and this is an absolute fill over the ENTIRE screen, so a
  // swallowed touch would make every tab untappable.
  if (reduceMotion) {
    return (
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <BlobField colors={colorsA} idBase="bg-a" />
      </View>
    );
  }

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, styleA]}>
        <BlobField colors={colorsA} idBase="bg-a" />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, styleB]}>
        <BlobField colors={colorsB} idBase="bg-b" />
      </Animated.View>
    </View>
  );
};

/** Static: nothing about it depends on props, so the screens above it never
 *  re-render the animation. */
export const AbstractGradientBackdrop = React.memo(AbstractGradientBackdropImpl);
AbstractGradientBackdrop.displayName = 'AbstractGradientBackdrop';

export default AbstractGradientBackdrop;
