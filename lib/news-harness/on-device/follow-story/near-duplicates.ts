// AFM writes one story several times over ("X Expansion Plans / X Development
// Timeline / X Project Progress"), and no prompt wording stopped it, so the card
// drops near-copies in code. Pure and RN-free.

import { contentJaccard, DETECT_JACCARD } from '../../../mera-harness/core/topic-similarity';

/** Words that name a facet of a story, not a story: two labels that differ only by these are one story. */
const FACET_WORDS = new Set([
  'update', 'updates', 'progress', 'timeline', 'plan', 'plans', 'development', 'developments', 'status',
  'impact', 'impacts', 'implications', 'history', 'background', 'overview', 'analysis', 'latest', 'news',
  'coverage', 'project', 'outlook', 'trends',
]);

const withoutFacets = (label: string): string =>
  label.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !FACET_WORDS.has(w.toLowerCase())).join(' ');

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Same search, or labels whose content words, facet words left out, overlap at the eval's "too close" bar. */
export function isNearDuplicate(a: { label: string; search: string }, b: { label: string; search: string }): boolean {
  if (norm(a.search) && norm(a.search) === norm(b.search)) return true;
  return contentJaccard(withoutFacets(a.label), withoutFacets(b.label)) >= DETECT_JACCARD;
}

/** The options with each near-copy of an earlier one dropped. The first `protectedHead` rows (the reader's own words) always stay. */
export function dropNearDuplicates<T extends { label: string; search: string }>(options: readonly T[], protectedHead = 0): T[] {
  const kept: T[] = [];
  options.forEach((o, i) => {
    if (i < protectedHead || !kept.some((k) => isNearDuplicate(k, o))) kept.push(o);
  });
  return kept;
}
