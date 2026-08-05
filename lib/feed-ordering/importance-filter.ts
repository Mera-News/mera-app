// The user-tunable importance filter ("show me High/Medium/Low and above"),
// expressed over `relevanceBandRank` so the filter can never contradict the
// worded RelevanceChip printed on a card. Deliberately NOT the `bucketOf`
// cutoffs in lib/news-harness/feed-select/ownership.ts — those drive Dashboard
// section viability, a separate system with separate cutoffs.
//
// Display-only: nothing upstream (suggestion creation, scoring, reason
// generation) reads this — every surface keeps receiving all suggestions and
// decides visibility at render time, so changing the filter is instant in
// both directions.

import { relevanceBandRank } from './priority-order';

export type ImportanceThreshold = 'high' | 'medium' | 'low';

/** The Feed shows medium-and-above out of the box… */
export const DEFAULT_FEED_IMPORTANCE_THRESHOLD: ImportanceThreshold = 'medium';
/** …while the Dashboard shows everything, exactly as before this filter. */
export const DEFAULT_DASHBOARD_IMPORTANCE_THRESHOLD: ImportanceThreshold = 'low';

/** Pill order in the header controls. */
export const IMPORTANCE_THRESHOLDS: readonly ImportanceThreshold[] = [
  'high',
  'medium',
  'low',
];

const MAX_BAND_RANK: Record<ImportanceThreshold, number> = {
  high: 1, // emergency + high
  medium: 2, // + medium
  low: 3, // + low — reproduces the existing 0.3 render gate exactly
};

/**
 * True when a scored relevance clears the threshold. Emergency (band rank 0)
 * numerically passes every setting — breaking news is never filtered by this
 * dial.
 */
export function passesImportanceThreshold(
  relevance: number,
  threshold: ImportanceThreshold,
): boolean {
  return relevanceBandRank(relevance) <= MAX_BAND_RANK[threshold];
}

/**
 * The unconditional top-headline cull predicate — independent of the user's
 * display filter. A headline-sourced suggestion scoring below the MEDIUM band
 * is excluded outright at score-persist time: headlines exist to surface what
 * matters in a region, so a LOW one is noise on every surface. The headline
 * score floor (HEADLINE_BASE_FLOOR + HEADLINE_POP_LIFT · popComp, max 0.5)
 * clears the render gate but not this band, so floor-only headlines are
 * culled. Topic-matched suggestions are never culled — the Dashboard shows
 * their LOW band.
 */
export function isCulledHeadlineRelevance(relevance: number): boolean {
  return relevanceBandRank(relevance) >= 3;
}

/** Parse a persisted settings-KV string; anything unrecognised → `fallback`
 *  (the surface's own default — Feed and Dashboard differ). */
export function parseImportanceThreshold(
  raw: string | null,
  fallback: ImportanceThreshold,
): ImportanceThreshold {
  return raw === 'high' || raw === 'medium' || raw === 'low' ? raw : fallback;
}
