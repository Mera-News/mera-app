// The unconditional top-headline cull, expressed over `relevanceBandRank`.
//
// This file used to also hold the user-tunable importance filter ("show me
// High/Medium/Low and above") — a threshold type, two per-surface defaults, a
// pill order and a `passesImportanceThreshold` predicate. That dial has been
// removed from the app: nothing filters suggestions by band at render time any
// more, and every scored story down to the LOW band is drawn on both tabs.
//
// What is left is a DIFFERENT system that merely shared the file, and the
// distinction is the reason this module still exists. The cull below runs at
// SCORE-PERSIST time, is not a display decision, and was never something the
// reader could turn off. Deleting it with the dial would silently readmit every
// low-scoring top headline into the feed.
//
// Deliberately NOT the `bucketOf` cutoffs in
// lib/news-harness/feed-select/ownership.ts — those drive Dashboard section
// viability, a separate system with separate cutoffs.

import { relevanceBandRank } from './priority-order';

/**
 * The top-headline cull predicate. A headline-sourced suggestion scoring below
 * the MEDIUM band is excluded outright at score-persist time: headlines exist
 * to surface what matters in a region, so a LOW one is noise on every surface.
 * The headline score floor (HEADLINE_BASE_FLOOR + HEADLINE_POP_LIFT · popComp,
 * max 0.5) clears the render gate but not this band, so floor-only headlines
 * are culled. Topic-matched suggestions are never culled — their LOW band
 * reaches the screen.
 */
export function isCulledHeadlineRelevance(relevance: number): boolean {
  return relevanceBandRank(relevance) >= 3;
}
