// image-resolution-stats — session-scoped counters for how big the images we
// actually render are.
//
// In memory only: no persistence, no network, nothing written to the database.
// It counts what the app already had to decode in order to draw the screen, and
// it is reset by closing the app. It records NOTHING about the reader: no
// article id, no publication, no timing, no per-user anything. That is the
// whole design, and it is the reason this is allowed to exist at all.
//
// The metric cannot be derived from the URL. Source resolution is only knowable
// from expo-image's onLoad -> event.source.width/height, so callers feed it from
// there; do not parse dimensions out of a path.
//
// Shaped after `computeFeedFunnel` in lib/stores/feed-diagnostics.ts: a plain
// module with a pure report function, so the screen just renders what it returns.

import { PixelRatio } from 'react-native';

/**
 * One device pixel of the 192pt hero. 576 on a 3x phone.
 *
 * Captured ONCE at module load, not recomputed per call, so a before/after
 * comparison is against the same denominator on the same device.
 */
export const MIN_HERO_PX = 192 * PixelRatio.get();

export interface HeroLoadSample {
  /** True when the URL we served was a rewritten one. */
  upgraded: boolean;
  /** Real decoded height of the image the host returned. */
  sourceHeight: number;
  /** True when a rewrite was attempted for this card at all. */
  rewriteAttempted: boolean;
  /** True when the rewrite failed and we fell back to the original. */
  rewriteFellBack: boolean;
}

interface Counters {
  heroesLoaded: number;
  belowMin: number;
  rewriteAttempted: number;
  rewriteServed: number;
  rewriteFellBack: number;
  upgradedHeights: number[];
  passthroughHeights: number[];
}

const empty = (): Counters => ({
  heroesLoaded: 0,
  belowMin: 0,
  rewriteAttempted: 0,
  rewriteServed: 0,
  rewriteFellBack: 0,
  upgradedHeights: [],
  passthroughHeights: [],
});

let counters: Counters = empty();

export function recordHeroLoad(sample: HeroLoadSample): void {
  const h = Number.isFinite(sample.sourceHeight) ? sample.sourceHeight : 0;
  counters.heroesLoaded += 1;
  if (h > 0 && h < MIN_HERO_PX) counters.belowMin += 1;
  if (sample.rewriteAttempted) counters.rewriteAttempted += 1;
  if (sample.upgraded) counters.rewriteServed += 1;
  if (sample.rewriteFellBack) counters.rewriteFellBack += 1;
  if (h > 0) (sample.upgraded ? counters.upgradedHeights : counters.passthroughHeights).push(h);
}

export function resetImageStats(): void {
  counters = empty();
}

export interface ImageResolutionReport {
  heroesLoaded: number;
  belowMin: number;
  /** Rounded percentage, 0 when nothing has loaded (never NaN). */
  belowMinPct: number;
  rewriteAttempted: number;
  rewriteServed: number;
  rewriteFellBack: number;
  /** Median decoded height of rewritten images, null when there are none. */
  medianUpgradedHeight: number | null;
  /** Median decoded height of pass-through images, null when there are none. */
  medianPassthroughHeight: number | null;
  minHeroPx: number;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

export function getImageResolutionReport(): ImageResolutionReport {
  const c = counters;
  return {
    heroesLoaded: c.heroesLoaded,
    belowMin: c.belowMin,
    belowMinPct: c.heroesLoaded === 0 ? 0 : Math.round((100 * c.belowMin) / c.heroesLoaded),
    rewriteAttempted: c.rewriteAttempted,
    rewriteServed: c.rewriteServed,
    rewriteFellBack: c.rewriteFellBack,
    medianUpgradedHeight: median(c.upgradedHeights),
    medianPassthroughHeight: median(c.passthroughHeights),
    minHeroPx: MIN_HERO_PX,
  };
}
