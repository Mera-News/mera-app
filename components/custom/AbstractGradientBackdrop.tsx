import React, { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { AppState, Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  makeMutable,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
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

/**
 * How often the single shared colour timer ticks, and therefore how often a
 * cross-fade happens.
 *
 * ## Why 45s and not 10s — this is the measured hot path
 *
 * Nothing in this backdrop moves at rest: the drift was removed (see
 * `BlobField`), so between fades the field is a single, already-rasterised
 * static layer. The ONLY thing that costs anything is the cross-fade itself,
 * and it costs far more than "one opacity animation" suggests:
 *
 *   • It mounts a SECOND full-screen `Svg`, forcing RNSVG to rasterise three
 *     full-screen radial gradients from scratch.
 *   • Animating that layer's opacity forces the compositor to re-blend two
 *     full-screen layers every frame for the duration — and every Liquid Glass
 *     view above the backdrop to RE-SAMPLE its blur against changing content.
 *   • Both costs are paid by EVERY mounted instance, and there are ~75 mount
 *     sites with all five tabs resident at once.
 *
 * Measured on the iPhone 17 Pro simulator, Feed idle, two 10-minute windows,
 * animated vs. the static-frame mode which differs ONLY by the fade:
 *
 *   | process         | animated | static | drop |
 *   |-----------------|---------:|-------:|-----:|
 *   | mera            |    13.0% |   5.4% | −58% |
 *   | SimRenderServer |     1.3% |   0.1% | −92% |
 *   | backboardd      |     6.9% |   1.1% | −84% |
 *   | TOTAL           |    21.2% |   6.6% | −69% |
 *
 * `backboardd` is the display server and `SimRenderServer` the renderer, so the
 * cost is compositing, not JS. At the old 2500ms fade every 10000ms the app
 * spent 25% OF ALL TIME in that state. 1200ms every 45000ms is a 2.7% duty
 * cycle — the same effect, ~9× less of it.
 *
 * Raising this further is nearly free; the limit is aesthetic, not technical.
 * Below ~20s the duty cycle climbs back into the range that showed up in the
 * measurement above.
 */
export const COLOR_STEP_MS = 45000;
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

/**
 * Opts THIS instance's base layer into the complementary fade, and back out.
 *
 * `outgoing` is module-global — every instance reads the same number — but the
 * base layer must only respond to it on an instance that is actually running a
 * cross-fade. Without this per-instance gate, one focused screen's fade would
 * drag EVERY suppressed instance's background toward black: blurred tabs,
 * static/reduce-motion mode, and any screen the focus gate misjudges. That is a
 * worse artefact than the one the complementary fade exists to remove.
 *
 * Named functions for the same React Compiler reason as `armCover`.
 */
function armBase(coverOn: SharedValue<number>) {
  coverOn.value = 1;
}

function disarmBase(coverOn: SharedValue<number>) {
  coverOn.value = 0;
}

/** How long a colour change takes. Deliberately much shorter than
 *  `COLOR_STEP_MS`: the second gradient layer only exists for this long, so the
 *  app runs on a single backdrop layer the rest of the time.
 *
 *  Shortened 2500 → 1200 alongside the `COLOR_STEP_MS` change. Both knobs move
 *  the same number — the fraction of wall-clock time a second full-screen SVG
 *  layer is mounted and being composited — and it is that fraction, not the
 *  tick rate on its own, that the measurement in `COLOR_STEP_MS` is about.
 *  1200ms is still well above the ~300ms at which a colour change reads as a
 *  cut rather than a drift. */
export const FADE_MS = 1200;

/* ────────────────────────────────────────────────────────────────────────────
 * INSTRUMENTATION
 *
 * Counters, not timers: the question these answer is "how many full-screen SVG
 * layers did we mount, and for how long", which is the cost driver identified
 * in the `COLOR_STEP_MS` measurement. They are plain integer adds on paths that
 * already do real work, so they stay compiled into release builds — the readout
 * is what is `__DEV__`-gated, not the accounting.
 *
 * `coverMounts` vs `instances` is the specific number that shows whether the
 * focus gate is working: before it, every mounted backdrop mounted a cover on
 * every step, so `coverMounts` per step equalled `instances`. After it, exactly
 * one instance — the focused one — should mount a cover, so the ratio should be
 * 1 : N regardless of how many screens are resident.
 * ──────────────────────────────────────────────────────────────────────────── */

export const backdropMetrics = {
  /** Colour-step advances since launch. */
  steps: 0,
  /** Cross-fade covers actually mounted (summed across instances). */
  coverMounts: 0,
  /** Covers currently mounted. Should peak at 1 once the focus gate lands. */
  liveCovers: 0,
  /**
   * Highest `liveCovers` ever observed — the headline number for the gate.
   *
   * Expect 1 in the tab tree. **2 is legitimate, not a gate failure**:
   * `ForceUpdateScreen` mounts a backdrop from outside the `<Stack>`, where
   * `useIsFocusedSafe` returns `true` by design (there is no navigator to be
   * blurred by), so it and the focused tab can both hold a cover. A number
   * that tracks `instances` is the actual failure signature.
   */
  peakLiveCovers: 0,
  /** Total wall-clock ms with at least one cover mounted, summed per cover. */
  coverMsTotal: 0,
  /** Backdrops currently mounted and subscribed to the shared engine. */
  get instances() {
    return mountCount;
  },
  reset() {
    backdropMetrics.steps = 0;
    backdropMetrics.coverMounts = 0;
    backdropMetrics.liveCovers = 0;
    backdropMetrics.peakLiveCovers = 0;
    backdropMetrics.coverMsTotal = 0;
  },
};

/** Named module functions for the same React Compiler reason `armCover` is one
 *  — a component that mutates a module value inline is silently skipped by the
 *  compiler. */
function noteCoverMounted() {
  backdropMetrics.coverMounts += 1;
  backdropMetrics.liveCovers += 1;
  if (backdropMetrics.liveCovers > backdropMetrics.peakLiveCovers) {
    backdropMetrics.peakLiveCovers = backdropMetrics.liveCovers;
  }
}

function noteCoverUnmounted(elapsedMs: number) {
  backdropMetrics.liveCovers = Math.max(0, backdropMetrics.liveCovers - 1);
  backdropMetrics.coverMsTotal += elapsedMs;
}

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
    // Logged BEFORE the increment so the line describes the interval that just
    // ended, with its covers already mounted, faded and unmounted. Logging
    // after `forEach` would report pre-mount state: the listeners only schedule
    // React work, they do not flush it.
    if (__DEV__) logBackdropMetrics();
    stepStore.value += 1;
    backdropMetrics.steps += 1;
    stepStore.listeners.forEach((fn) => fn());
  },
};

/** One compact line per `COLOR_STEP_MS` — at 45s that is ~80 lines an hour,
 *  cheap enough to leave on in dev and readable via `agent-device logs`. */
function logBackdropMetrics() {
  const m = backdropMetrics;
  const duty = m.steps > 0 ? m.coverMsTotal / (m.steps * COLOR_STEP_MS) : 0;
  console.log(
    `[backdrop] step=${m.steps} instances=${m.instances} ` +
      `covers=${m.coverMounts} live=${m.liveCovers} peak=${m.peakLiveCovers} ` +
      `coverMs=${Math.round(m.coverMsTotal)} layerDuty=${(duty * 100).toFixed(1)}%`,
  );
}

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

/**
 * The base layer's opacity for the commit that starts a fade — a PLAIN style
 * object, deliberately, and it is load-bearing.
 *
 * `PropsFilter.filterNonAnimatedProps` (reanimated 4.x) treats the two kinds of
 * entry in a style array very differently on a re-render:
 *
 *   • an ANIMATED style is replaced by `_initialPropsMap.get(handle)` — the
 *     snapshot taken at that component's FIRST render, not a fresh worklet run.
 *     The base layer first renders at rest, so its snapshot is `{opacity: 1}`,
 *     and every later commit re-asserts that 1 no matter what the worklet would
 *     now compute. The real value arrives afterwards, from the UI-thread mapper.
 *   • a PLAIN style object is passed through verbatim, every render.
 *
 * So an animated style alone cannot put the base layer at 0 in the commit that
 * first paints the new colours — it would commit 1 (the stacked-pop value) and
 * correct itself a frame later. Appending this after `baseStyle` makes the
 * safe value part of the commit itself; the mapper then drives the ramp from
 * there. The cover needs no such thing because it is a FRESH mount each fade,
 * which is the `initialUpdaterRun` path the long comment in the component
 * describes.
 */
const BASE_HIDDEN = { opacity: 0 } as const;

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

  /* ──────────────────────────────────────────────────────────────────────────
   * ONLY THE FOCUSED INSTANCE CROSS-FADES
   *
   * The backdrop is mounted at ~75 sites and all five tabs stay resident (the
   * Instagram model — see `use-is-focused-safe`), so a single colour step used
   * to mount a second full-screen `Svg` on every one of them at once. Every
   * cover but the focused screen's is composited behind an opaque navigation
   * background where nobody can see it, and the measurement recorded on
   * `COLOR_STEP_MS` shows that compositing full-screen layers is the entire
   * cost of this component.
   *
   * `useAnimationsActive()` is `useIsFocusedSafe() && foregrounded` — the same
   * predicate the four looping animations in 3da25ab use, reused rather than
   * re-derived. "Safe" matters here specifically: this component is mounted by
   * `ForceUpdateScreen`, which renders OUTSIDE the `<Stack>`, and a bare
   * `useIsFocused()` there throws and white-screens the mandatory-update path.
   *
   * NOTE this gates the COVER, not the ENGINE. The shared step counter must
   * keep advancing for every instance — gating the engine on focus would stop
   * the clock for the whole app whenever the focused screen happened to be a
   * static-mode one, and blurred instances would then wake to a stale step and
   * fade through colours the user already passed.
   * ────────────────────────────────────────────────────────────────────────── */
  const animationsActive = useAnimationsActive();

  /** Static mode and "nobody can see this instance" want the identical
   *  behaviour: adopt the new colours instantly, mount no cover. */
  const coverSuppressed = isStatic || !animationsActive;

  // One engine for the whole app — see THE SHARED ENGINE above. Deliberately
  // NOT gated on focus; see the note above.
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
  // So: the CURRENT colours render underneath, permanently. On a step change the
  // PREVIOUS colours mount on top and the two swap opacity, then the cover
  // unmounts.
  //
  // ## The two layers' opacities are COMPLEMENTARY, and that is the whole trick
  //
  // The obvious version of this — leave the base at opacity 1 and just fade the
  // cover 1 → 0 — is what shipped, and it FLASHED. A `BlobField` is an `Svg`
  // with no background fill whose blobs peak at alpha 0.38; it is translucent
  // everywhere and opaque nowhere, so it never "covers" the layer beneath it.
  // Two of them at full opacity therefore STACK: composite alpha at a blob
  // centre jumps 0.38 → 0.38 + 0.38×0.62 ≈ 0.62 in the single frame the cover
  // mounts, then decays back over `FADE_MS`. A full-magnitude one-frame pop
  // followed by a decay is exactly what the eye reads as a flash, and shortening
  // `FADE_MS` (2500 → 1200) made it read as one rather than as a slow bloom.
  //
  // Driving the base at `1 - outgoing` fixes it by construction:
  //
  //   • fade start (outgoing 1) → base 0: the screen is EXACTLY `blobs(previous)`,
  //     bit-identical to the frame before the step. Nothing to see.
  //   • fade end (outgoing 0)   → base 1: exactly `blobs(current)`.
  //   • midpoint → 0.5 each, composite ≈ 0.345 against 0.38 — an imperceptible
  //     dip, and crucially never ABOVE either endpoint.
  //
  // If you ever put the base back at a constant opacity 1, the flash returns.
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

  /** Whether THIS instance's base layer follows `outgoing`. A fresh mount starts
   *  at 0, so a backdrop mounted mid-fade (every navigation push mounts one)
   *  renders at full density instead of adopting a stranger's in-flight fade. */
  const coverOn = useSharedValue(0);

  if (displayed.step !== step) {
    // See point 2 above: both of these must happen before the layers render.
    // `armBase` is subject to the same constraint as `armCover` — the base
    // layer's opacity has to be 0 in the very commit that first paints the new
    // colours, or that commit shows the raw stacked pop this fade exists to
    // avoid.
    if (!coverSuppressed) {
      armCover();
      armBase(coverOn);
    }
    setDisplayed({ step, fading: !coverSuppressed });
  } else if (displayed.fading && coverSuppressed) {
    // Static mode switched on, or this screen was blurred, mid-fade: drop the
    // cover in this same render so no animation is left stranded on screen.
    // Releasing the base layer here is not optional — the cover is about to
    // disappear, and a base still tracking `outgoing` would sit at whatever
    // partial opacity the fade had reached, dimming this screen's background
    // until the next step.
    disarmBase(coverOn);
    setDisplayed({ step, fading: false });
  }

  const fading = displayed.fading && !coverSuppressed;

  useLayoutEffect(() => {
    if (!fading) return;
    // Already armed by the render pass; re-asserted so the animation always
    // starts from a known, fully-covering value.
    //
    // `armBase` in particular MUST be re-asserted here. On a step that
    // supersedes a fade in progress, React runs the previous effect's cleanup
    // (which disarms) AFTER this render's arming — so without this line the
    // base would be released mid-fade and sit at full opacity while the cover
    // fades over it, which is the stacked pop again.
    armCover();
    armBase(coverOn);
    noteCoverMounted();
    const mountedAt = Date.now();
    outgoing.value = withTiming(0, { duration: FADE_MS, easing: Easing.inOut(Easing.ease) });
    // Unmounts the cover once it is fully transparent — the whole point of the
    // one-layer-at-rest design. Cleared on unmount and whenever a new step
    // supersedes this fade.
    const t = setTimeout(
      () => setDisplayed((d) => (d.fading ? { ...d, fading: false } : d)),
      FADE_MS,
    );
    return () => {
      clearTimeout(t);
      // Runs on the fade completing (deps change), on a superseding step, and
      // on unmount — every path by which this cover stops being rendered, so
      // `liveCovers` cannot leak upward. Releasing the base layer on the same
      // paths is what guarantees it can never be stranded below full opacity;
      // the superseding-step path re-arms it in the effect body above.
      disarmBase(coverOn);
      noteCoverUnmounted(Date.now() - mountedAt);
    };
  }, [coverOn, displayed.step, fading]);

  const outgoingStyle = useAnimatedStyle(() => ({ opacity: outgoing.value }));
  /** The complement, gated per instance. `coverOn` at 0 pins this to 1, which is
   *  the resting state and the state of every instance not cross-fading. */
  const baseStyle = useAnimatedStyle(() => ({ opacity: 1 - outgoing.value * coverOn.value }));

  // `pointerEvents` goes on a plain RN View, NOT on the Svg. `Svg` is
  // `RNSVGSvgView`, which does its own hit-testing and does not reliably honour
  // the prop — and this is an absolute fill over the ENTIRE screen, so a
  // swallowed touch would make every tab untappable.
  if (ANDROID_DISABLED) return null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {/* Mounted UNCONDITIONALLY, even though its opacity only ever moves during
          a fade. Wrapping it in `fading ? ... : ...` would unmount and remount
          the whole `Svg` subtree at the END of every fade — three full-screen
          radial gradients re-rasterised for no colour change, on every mounted
          instance — which is precisely the cost the `COLOR_STEP_MS`
          measurement exists to keep down. */}
      <Animated.View
        testID="backdrop-base"
        style={[StyleSheet.absoluteFill, baseStyle, fading ? BASE_HIDDEN : null]}
      >
        <BlobField colors={current} idBase="bg-current" />
      </Animated.View>
      {fading ? (
        <Animated.View testID="backdrop-cover" style={[StyleSheet.absoluteFill, outgoingStyle]}>
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
