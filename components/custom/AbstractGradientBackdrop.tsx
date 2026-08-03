import React, { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { AppState, Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  makeMutable,
  useAnimatedStyle,
  useReducedMotion,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';

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
 *     accessibility behaviour and the cheapest possible mode. Settings →
 *     Display → "Static background" (`display-prefs-store`) selects the exact
 *     same mode by hand, for battery or for older devices.
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

/** The shared fade-out driver for the outgoing colour layer. */
const outgoing = makeMutable(0);

/**
 * Puts the cover at full opacity. A named module function rather than a bare
 * `outgoing.value = 1` at the call sites for one concrete reason: the component
 * has to do this DURING RENDER (see the long comment there), and React Compiler
 * refuses to compile a component that mutates a module value inline in render
 * ("This value cannot be modified") — it silently skips optimising the whole
 * component. Behind a function call it compiles normally.
 */
function armCover() {
  outgoing.value = 1;
}

/** How long a colour change takes. Deliberately much shorter than
 *  `COLOR_STEP_MS`: the second gradient layer only exists for this long, so the
 *  app runs on a single backdrop layer the rest of the time. */
const FADE_MS = 2500;

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
  // Only advances the step; each mounted backdrop runs its own short fade off
  // that shared tick (see the component).
  colorTimer = setInterval(() => stepStore.advance(), COLOR_STEP_MS);
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

/**
 * DISABLED ON ANDROID — deliberately, and this needs to stay until it can be
 * tested on a real Android build.
 *
 * Two Android-only problems, both traced to this component being a full-screen
 * `Svg` mounted on every screen:
 *
 * 1. **A crash.** `java.lang.NullPointerException` in
 *    `ViewGroup.dispatchGetDisplayList()` — Android's render thread walking a
 *    display list and finding a null child, i.e. a view removed from the
 *    hierarchy while it was being drawn. `RNSVGSvgView` is a `ViewGroup`, and
 *    this component put one on ~47 screens.
 * 2. **Slowness.** RNSVG draws through the Canvas/Picture path on Android
 *    rather than a cached layer, so a full-screen radial gradient is far more
 *    expensive there than on iOS — multiplied by every mounted tab.
 *
 * Android therefore renders nothing here and falls back to the flat dark page
 * it had before this feature, which is correct-looking, just less pretty. iOS
 * is unaffected.
 *
 * To bring Android back, do NOT simply re-enable this: use a non-SVG path
 * (a `View` with `experimental_backgroundImage` radial-gradients is the
 * obvious candidate) and verify it on a device, since neither of the problems
 * above reproduces on iOS.
 */
const ANDROID_DISABLED = Platform.OS === 'android';

const AbstractGradientBackdropImpl: React.FC<AbstractGradientBackdropProps> = ({ seed }) => {
  const reduceMotion = useReducedMotion();
  const staticGradient = useDisplayPrefsStore((s) => s.staticGradient);

  // OS Reduce Motion and the app's own "Static background" setting
  // (Settings → Display) are the SAME mode: a single static frame, no clock,
  // no timer, no animated styles. Both are global — every mounted instance
  // agrees — so when either is on the shared engine has no subscribers left
  // and stops, which is what keeps `step` from advancing underneath a static
  // field.
  const isStatic = reduceMotion || staticGradient;

  // One engine for the whole app — see THE SHARED ENGINE above.
  useSharedEngine(!isStatic && !ANDROID_DISABLED);
  const step = useSyncExternalStore(stepStore.subscribe, stepStore.get, stepStore.get);

  // Unseeded surfaces share the app-wide sequences, which is what makes every
  // screen the same background. A seed opts out into its own deterministic walk
  // — the fact news-list keys it by fact id.
  const [sequences] = useState(() =>
    seed === undefined
      ? SHARED_SEQUENCES
      : BLOBS.map((_, i) => colorSequence(makeRandom(`${seed}#${i}`)))
  );

  // ONE layer at rest, two only while a colour is changing.
  //
  // This is the Android fix, and it helps everywhere. Keeping two full-screen
  // `Svg`s mounted permanently just so they could cross-fade meant paying for
  // two rasterised gradient layers 100% of the time to animate for a couple of
  // seconds every ten. That is expensive on Android in particular, where RNSVG
  // draws through the Canvas/Picture path rather than a cached CALayer, and it
  // was multiplied by every tab screen that stays mounted.
  //
  // So: the CURRENT colours render underneath at full opacity, permanently. On
  // a step change the PREVIOUS colours mount on top at full opacity and fade
  // out, revealing the new ones, then unmount. The swap underneath is invisible
  // because the outgoing layer covers it while it happens.
  const at = (seq: string[], i: number, n: number) =>
    seq[(((n + i) % seq.length) + seq.length) % seq.length];
  const current = sequences.map((seq, i) => at(seq, i, step));
  const previous = sequences.map((seq, i) => at(seq, i, step - 1));

  /* ──────────────────────────────────────────────────────────────────────────
   * WHY THE COVER IS MOUNTED FROM RENDER AND NOT FROM AN EFFECT
   *
   * This used to be a `useEffect` on [step] that called `setFading(true)` and
   * set `outgoing` to 1. That is one commit too late, and it produced the
   * "background snaps to a different colour" bug: the step advance re-rendered
   * `current` with the NEW colours and committed them with NO cover mounted —
   * one or more frames of raw new colour — and only then did the effect mount
   * the previous colours over the top, so the old colour visibly popped BACK
   * before fading. Two things fix it, and both are load-bearing:
   *
   * 1. **Same-commit mounting.** `displayed` is adjusted DURING render (the
   *    "adjust state when a value changes" pattern): React re-runs this
   *    component synchronously and throws the first pass away, so the commit
   *    that first paints the new `current` colours ALSO contains the cover.
   *    There is no in-between frame to paint.
   *
   * 2. **`outgoing.value = 1` during that same render pass, not in the
   *    effect.** Reanimated computes an animated component's initial JS-side
   *    style by re-running the style worklet at that component's FIRST render
   *    (`PropsFilter.filterNonAnimatedProps` → `initialUpdaterRun`, reanimated
   *    4.x). So the cover's opacity at mount is whatever `outgoing` reads at
   *    the moment it renders. Between fades `outgoing` rests at 0 — set it in
   *    an effect (which runs AFTER the commit) and the cover mounts
   *    TRANSPARENT, re-exposing the raw new colours for a frame and defeating
   *    fix 1 entirely. Do not "tidy" this write into the effect below.
   *
   * `useLayoutEffect` then starts the fade-out. It runs after the commit but
   * before the frame is drawn, and by then the cover is already opaque, so all
   * it does is animate 1 → 0.
   *
   * Multi-instance coherence: `stepStore.advance()` notifies every subscriber
   * inside one interval callback, so React batches them into a SINGLE render
   * pass and a single commit — every instance's render-phase write happens
   * before any instance's layout effect, and the repeated `outgoing.value = 1`
   * / `withTiming(0)` in that one frame are idempotent (same target, same
   * duration). That is the whole coordination mechanism; there is deliberately
   * no per-instance driver, because one shared value is what makes every
   * mounted backdrop show the IDENTICAL frame.
   * ────────────────────────────────────────────────────────────────────────── */

  // The step THIS instance has painted, plus whether that transition is being
  // cross-faded. Seeded with the live shared step, which is what stops a
  // backdrop mounted mid-session (every navigation push mounts one) from
  // re-arming a fade — the old effect did, and it reset the SHARED `outgoing`
  // for every other mounted instance mid-fade.
  const [displayed, setDisplayed] = useState(() => ({ step, fading: false }));

  if (displayed.step !== step) {
    // See point 2 above: this must happen before the cover renders.
    if (!isStatic) armCover();
    setDisplayed({ step, fading: !isStatic });
  } else if (displayed.fading && isStatic) {
    // Static mode switched on mid-fade: drop the cover in this same render so
    // no animation is left stranded on screen.
    setDisplayed({ step, fading: false });
  }

  const fading = displayed.fading && !isStatic;

  useLayoutEffect(() => {
    if (!fading) return;
    // Already armed by the render pass; re-asserted so the animation always
    // starts from a known, fully-covering value.
    armCover();
    outgoing.value = withTiming(0, { duration: FADE_MS, easing: Easing.inOut(Easing.ease) });
    // Unmounts the cover once it is fully transparent — the whole point of the
    // one-layer-at-rest design. Cleared on unmount and whenever a new step
    // supersedes this fade.
    const t = setTimeout(
      () => setDisplayed((d) => (d.fading ? { ...d, fading: false } : d)),
      FADE_MS,
    );
    return () => clearTimeout(t);
  }, [displayed.step, fading]);

  const outgoingStyle = useAnimatedStyle(() => ({ opacity: outgoing.value }));

  // `pointerEvents` goes on a plain RN View, NOT on the Svg. `Svg` is
  // `RNSVGSvgView`, which does its own hit-testing and does not reliably honour
  // the prop — and this is an absolute fill over the ENTIRE screen, so a
  // swallowed touch would make every tab untappable.
  if (ANDROID_DISABLED) return null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <BlobField colors={current} idBase="bg-current" />
      {fading ? (
        <Animated.View style={[StyleSheet.absoluteFill, outgoingStyle]}>
          <BlobField colors={previous} idBase="bg-prev" />
        </Animated.View>
      ) : null}
    </View>
  );
};

/** Static: nothing about it depends on props, so the screens above it never
 *  re-render the animation. */
export const AbstractGradientBackdrop = React.memo(AbstractGradientBackdropImpl);
AbstractGradientBackdrop.displayName = 'AbstractGradientBackdrop';

export default AbstractGradientBackdrop;
