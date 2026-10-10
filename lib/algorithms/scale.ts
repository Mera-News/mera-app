/**
 * The app's type scale, as numbers.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `tailwind.config.js` is the source of truth for what a `text-*` class
 * renders, but NativeWind resolves those classes at BUILD time into a static
 * stylesheet. A runtime "make all text bigger" control therefore cannot work by
 * editing tokens — there is nothing left to edit by the time the app runs. It
 * has to multiply a known px value.
 *
 * So these numbers are a deliberate mirror of the `fontSize` block in
 * `tailwind.config.js`. `components/ui/__tests__/typography-scale.test.ts`
 * reads the real Tailwind config and fails if the two ever drift, which is what
 * makes duplicating them safe rather than merely convenient.
 *
 * They are NOT a second scale, and nothing may add a token here that Tailwind
 * does not have.
 */

/** Every size name in the scale. `Text` and `Heading` share this vocabulary. */
export const TYPE_TOKENS = [
  '2xs',
  'xs',
  'sm',
  'base',
  'lg',
  'xl',
  '2xl',
  '3xl',
  '4xl',
  '5xl',
  '6xl',
] as const;

export type TypeToken = (typeof TYPE_TOKENS)[number];

export interface TypeStep {
  readonly fontSize: number;
  readonly lineHeight: number;
}

export const TYPE_SCALE: Readonly<Record<TypeToken, TypeStep>> = {
  '2xs': { fontSize: 11, lineHeight: 16 },
  'xs': { fontSize: 12, lineHeight: 18 },
  'sm': { fontSize: 14, lineHeight: 21 },
  'base': { fontSize: 16, lineHeight: 24 },
  'lg': { fontSize: 18, lineHeight: 28 },
  'xl': { fontSize: 20, lineHeight: 30 },
  '2xl': { fontSize: 24, lineHeight: 36 },
  '3xl': { fontSize: 30, lineHeight: 45 },
  '4xl': { fontSize: 36, lineHeight: 54 },
  '5xl': { fontSize: 48, lineHeight: 72 },
  '6xl': { fontSize: 60, lineHeight: 90 },
};

/**
 * The smallest type the app is allowed to render, in px.
 *
 * iOS's smallest system text style is Caption 2 at 11pt. Nothing in the app
 * should sit below the platform's own floor; the `2xs` token is pinned to it
 * exactly, and the parity test asserts no token is smaller.
 */
export const MIN_FONT_SIZE_PX = 11;

const TOKEN_CLASS_RE = /(?:^|\s)text-(2xs|xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl)(?=$|\s)/g;

/**
 * The type token a fully-merged NativeWind class string will actually render.
 *
 * Takes the LAST match, which is how `tva`/tailwind-merge resolves a caller's
 * `className="text-2xl"` beating the component's own `size` variant. Reading
 * the merged string rather than re-deriving precedence from the inputs is the
 * point: it cannot disagree with what NativeWind does.
 *
 * Returns `null` for a class string with no size token (colour-only classes
 * like `text-white` deliberately do not match).
 */
export function tokenFromClassName(className: string | undefined): TypeToken | null {
  if (!className) return null;
  TOKEN_CLASS_RE.lastIndex = 0;
  let token: TypeToken | null = null;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_CLASS_RE.exec(className)) !== null) {
    token = m[1] as TypeToken;
    // Overlapping `(?:^|\s)` anchors: step back one so ` text-a text-b` finds
    // both. Without this a run of size classes only ever yields the first.
    TOKEN_CLASS_RE.lastIndex = m.index + m[0].length - 1;
  }
  return token;
}

/**
 * The in-app text-size steps, smallest first.
 *
 * These multiply the scale above; they are INDEPENDENT of, and compose with,
 * the OS Dynamic Type setting (`lib/typography/policy.ts` caps the combined
 * growth). The control exists because plenty of readers want bigger news text
 * without enlarging every other app on their phone — and because the OS control
 * is buried three levels deep in Settings.
 *
 * `1` must be a member, and is the default: an unset preference has to render
 * exactly what the design specifies.
 *
 * These live HERE and not in `lib/stores/text-scale-store.ts` on purpose. The
 * store imports the settings table, which instantiates the WatermelonDB
 * singleton at module scope — so anything that merely wants to know what the
 * steps ARE (the settings screen, its tests) would have had to drag the whole
 * database in with it.
 */
export const TEXT_SCALE_STEPS = [0.9, 1, 1.15, 1.3] as const;

export type TextScale = (typeof TEXT_SCALE_STEPS)[number];

export const DEFAULT_TEXT_SCALE: TextScale = 1;

/** Step identifiers, index-aligned with `TEXT_SCALE_STEPS`. Used for testIDs and
 *  to build i18n key names. */
export const TEXT_SCALE_LABEL_KEYS = ['compact', 'default', 'large', 'larger'] as const;

/**
 * Nearest valid step to an arbitrary number.
 *
 * Persisted values are strings and a step could be dropped in a later release,
 * so a stored value is untrusted input, not an enum.
 */
export function nearestTextScale(value: number): TextScale {
  if (!Number.isFinite(value)) return DEFAULT_TEXT_SCALE;
  let best: TextScale = DEFAULT_TEXT_SCALE;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const step of TEXT_SCALE_STEPS) {
    const delta = Math.abs(step - value);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = step;
    }
  }
  return best;
}

/**
 * The width, in dp, below which the DEFAULT (unset-preference) text scale
 * should be the compact step rather than the designed 1x.
 *
 * 375dp (iPhone SE / 13 mini) and 360dp (small Androids) sit below this;
 * both harness devices (393dp, 402dp) sit at or above it with >=13dp of
 * margin, so a cut anywhere in 390-400 would have made harness runs a coin
 * flip on which branch they exercised. Picked to be roomy on both sides
 * rather than tight on either.
 */
const COMPACT_DEFAULT_WIDTH_THRESHOLD_DP = 380;

/**
 * The text scale to apply when the user has never made an explicit choice,
 * derived from the device's screen width.
 *
 * Width, not height and not the shorter side: it's line length — how many
 * characters fit before a wrap — that makes small type hard to read, and
 * width is what bounds that on a portrait phone screen regardless of how
 * tall it is.
 *
 * Deliberately ignores the OS `fontScale` (Dynamic Type / system font size).
 * `lib/typography/policy.ts` already composes the in-app scale with the OS
 * setting at render time; folding the OS setting into the DEFAULT here as
 * well would make the baseline move whenever the user changed something
 * that has nothing to do with this control.
 *
 * A non-finite or non-positive width (bad measurement, not "know it's
 * small") falls back to the designed default rather than guessing compact.
 */
export function defaultTextScaleForWidth(widthDp: number): TextScale {
  if (!Number.isFinite(widthDp) || widthDp <= 0) return DEFAULT_TEXT_SCALE;
  return widthDp < COMPACT_DEFAULT_WIDTH_THRESHOLD_DP ? 0.9 : DEFAULT_TEXT_SCALE;
}
