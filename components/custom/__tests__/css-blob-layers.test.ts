// cssBlobLayers — the Android renderer's one pure function.
//
// This file exists because the SVG→CSS port has four ways of being WRONG WITH NO
// ERROR. A dropped or malformed layer makes `processBackgroundImage` fail by
// `return []` — no throw, no warning, the prop silently ignored — and the result
// looks exactly like the flat black Android had before this shipped. A reversed
// layer array is worse still: it renders, it looks plausible, and it is wrong
// only where two translucent blobs overlap.
//
// Every assertion below is a trap that was verified on a 1080x2400 API-35
// emulator before the code was written (see AbstractGradientBackdrop's
// ANDROID_STATIC_CSS comment for the measured numbers).
//
// A rendering test cannot cover this: `jest.setup.js` pins `Platform.OS` to
// 'ios' globally, so the component never takes the CSS path under test. The
// function is exported for exactly that reason.

// The module under test is a component file, so importing it pulls in
// reanimated's native bindings. Only the pure function is exercised here; these
// stubs exist purely so the import resolves.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: () => null },
  Easing: { inOut: (f: unknown) => f, ease: 'ease' },
  makeMutable: (initial: unknown) => ({ value: initial }),
  useAnimatedStyle: (fn: () => unknown) => fn(),
  useReducedMotion: () => false,
  useSharedValue: (initial: unknown) => ({ value: initial }),
  withTiming: (v: unknown) => v,
}));

jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: () => null,
  Defs: () => null,
  RadialGradient: () => null,
  Rect: () => null,
  Stop: () => null,
}));

jest.mock('@/lib/stores/display-prefs-store', () => ({
  useDisplayPrefsStore: (sel: (s: { staticGradient: boolean }) => unknown) =>
    sel({ staticGradient: false }),
}));

import { cssBlobLayers } from '@/components/custom/AbstractGradientBackdrop';

const RED = 'rgb(255,0,0)';
const GREEN = 'rgb(0,255,0)';
const BLUE = 'rgb(0,0,255)';

/** Split the value into its top-level layers: only commas at paren depth 0 are
 *  separators. Depth-aware rather than a regex, because the commas inside
 *  `radial-gradient(…)` and inside each `rgba(…)` are nested two levels deep —
 *  the same walk React Native's own `splitGradients` does. */
function layersOf(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out;
}

describe('cssBlobLayers', () => {
  const value = cssBlobLayers([RED, GREEN, BLUE]);
  const layers = layersOf(value);

  it('emits one radial-gradient layer per blob', () => {
    expect(layers).toHaveLength(3);
    layers.forEach((l) => expect(l.startsWith('radial-gradient(')).toBe(true));
  });

  // TRAP 4 — the one that produces a subtly wrong picture and no error.
  // SVG paints in array order, so BLOBS[2] ends up on TOP. CSS
  // `background-image` paints the FIRST listed layer on top. Three translucent
  // hues do not composite commutatively, so an unreversed array is wrong in
  // exactly the overlaps and right everywhere else.
  it('REVERSES the layer order — blob 2 is listed first so CSS paints it on top', () => {
    expect(layers[0]).toContain('0,0,255'); // BLOBS[2]
    expect(layers[1]).toContain('0,255,0'); // BLOBS[1]
    expect(layers[2]).toContain('255,0,0'); // BLOBS[0]
  });

  it('keeps each blob paired with its OWN geometry across the reversal', () => {
    // BLOBS[2] is the bottom blob: r 0.65 at 60% / 88%.
    expect(layers[0]).toContain('ellipse 65% 65% at 60% 88%');
    // BLOBS[1]: r 0.75 at 22% / 46%.
    expect(layers[1]).toContain('ellipse 75% 75% at 22% 46%');
    // BLOBS[0]: r 0.7 at 78% / 12%.
    expect(layers[2]).toContain('ellipse 70% 70% at 78% 12%');
  });

  // TRAP 1 — `circle` resolves a single radius against the box's DIAGONAL and
  // paints a round blob on a tall screen. The SVG's objectBoundingBox units
  // stretch each circle into an ellipse matching the screen's aspect ratio, and
  // only a two-axis `ellipse W% H%` reproduces that.
  it('never uses `circle`, and always gives two axis percentages', () => {
    expect(value).not.toContain('circle');
    layers.forEach((l) => expect(l).toMatch(/ellipse \d+(\.\d+)?% \d+(\.\d+)?% at /));
  });

  // TRAP 2 — CSS has no `stopOpacity`, so the alpha must be baked into every
  // colour literal. A bare `rgb(...)` anywhere means a blob at full opacity.
  it('bakes alpha into every stop — peak, halfway ring, and end', () => {
    // BLOBS[0] alpha 0.38; halfway ring is 0.34x that.
    const blob0 = layers[2];
    expect(blob0).toContain('rgba(255,0,0,0.38) 0%');
    expect(blob0).toContain('rgba(255,0,0,0.1292) 50%');
    expect(blob0).toContain('rgba(255,0,0,0) 100%');

    // BLOBS[1] alpha 0.34, BLOBS[2] alpha 0.28 — each blob keeps its own peak.
    expect(layers[1]).toContain('rgba(0,255,0,0.34) 0%');
    expect(layers[0]).toContain('rgba(0,0,255,0.28) 0%');

    // No un-alpha'd colour survives anywhere.
    expect(value).not.toMatch(/rgb\([^)]*\)(?!,)/);
  });

  // TRAP 3 — CSS `transparent` is `rgba(0,0,0,0)`, so interpolating to it drags
  // every falloff through grey and muddies a warm blob. The end stop must be the
  // SAME hue at alpha 0.
  it('ends on the same hue at alpha 0, never the keyword `transparent`', () => {
    expect(value).not.toContain('transparent');
    expect(layers[2]).toContain('rgba(255,0,0,0) 100%');
    expect(layers[1]).toContain('rgba(0,255,0,0) 100%');
    expect(layers[0]).toContain('rgba(0,0,255,0) 100%');
  });

  it('produces a value React Native can parse end to end', () => {
    // Not a re-implementation of the parser — this is the real one the Android
    // view config uses, so a syntax slip that would silently `return []` on
    // device fails here instead.
    const processBackgroundImage =
      require('react-native/Libraries/StyleSheet/processBackgroundImage').default;
    const parsed = processBackgroundImage(value);
    expect(parsed).toHaveLength(3);
    parsed.forEach((g: { type: string }) => expect(g.type).toBe('radial-gradient'));
  });
});
