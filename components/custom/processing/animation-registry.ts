// The ONLY file in the repo that may hold a processing-stage animation
// `require()`. Its tutorials twin is
// `components/custom/tutorials/animation-registry.ts`; the two share one asset
// directory and one convention and are deliberately not merged, because each
// one is the single file its own area has to look at.
//
// ── Why this file exists ────────────────────────────────────────────────────
// Metro resolves `require()` at BUNDLE time. A `try { require(…) } catch {}`
// around a missing animation file is a BUILD error that no runtime guard can
// catch. So stages carry an id STRING and this map is the single place a string
// becomes an asset. **An entry may exist here only once its file is on disk.**
//
// ── Adding or removing one ──────────────────────────────────────────────────
// Drop `processing-<stageId>.json` into `assets/animations/` (it has to meet
// that directory's contract, and `scripts/animations/validate.py` is what says
// whether it does), then uncomment its line below. Comment a line out and that
// stage falls back to its designed Reanimated/SVG scene with no other change,
// at any N from 0 to 6. The fallbacks are not placeholders for missing work:
// they are what a device with Reduce Motion on would show anyway.
//
// Plain `.json` bodymovin, already a Metro `sourceExt`. Never `.lottie`, which
// needs an `assetExts` change plus a dotLottie runtime.

import type { ProcessingStageId } from './types';

export const PROCESSING_ANIMATIONS: Partial<Record<ProcessingStageId, unknown>> = {
  fetching: require('@/assets/animations/processing-fetching.json'),
  downloading: require('@/assets/animations/processing-downloading.json'),
  grouping: require('@/assets/animations/processing-grouping.json'),
  analysing: require('@/assets/animations/processing-analysing.json'),
  summarising: require('@/assets/animations/processing-summarising.json'),
  preparing: require('@/assets/animations/processing-preparing.json'),
};

/** The asset for a stage, or `undefined` when it has none and must fall back. */
export function processingAnimationFor(id: ProcessingStageId | null): unknown {
  if (!id) return undefined;
  return PROCESSING_ANIMATIONS[id];
}
