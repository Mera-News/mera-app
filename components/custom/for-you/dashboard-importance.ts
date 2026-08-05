// Dashboard-only importance filter. Pure (no React), so both the sections feed
// and its tests can call it directly.
//
// Filters a section's story GROUPS by the user's Dashboard importance pill
// (`dashboardThreshold`, default 'low' = show everything = today's behavior).
// The filter reads each group's REPRESENTATIVE — `group.data` — because that's
// whose RelevanceChip the card renders; filtering on any other member would
// let a card chipped "High" vanish under a "High" filter, a visible
// contradiction. Breaking reps always pass, mirroring `isBreaking`'s treatment
// throughout the Dashboard selector (fact-rows-selector.buildFactRows never
// importance-gates a breaking rep either).
//
// Deliberately NOT in fact-rows-selector.ts / feed-list-selector.ts /
// importance-filter.ts: those are shared with other surfaces (the shared
// selector, the Feed tab), and this filter must stay Dashboard-only so raising
// the Feed's pill can never affect the Dashboard or vice versa.

import { isBreaking, type FactRowGroup } from '@/lib/stores/fact-rows-selector';
import {
  passesImportanceThreshold,
  type ImportanceThreshold,
} from '@/lib/feed-ordering/importance-filter';

/**
 * Filters `groups` to those whose representative clears `threshold` — or is
 * breaking, which always passes regardless of threshold.
 *
 * Returns the SAME array reference when `threshold` is `'low'` (today's
 * default: show everything), so callers that depend on referential stability
 * (memo deps, `React.memo` props) see no change at the default setting —
 * required for the "byte-identical to today at 'low'" guarantee.
 */
export function filterGroupsByImportance(
  groups: readonly FactRowGroup[],
  threshold: ImportanceThreshold,
): FactRowGroup[] {
  if (threshold === 'low') return groups as FactRowGroup[];
  return groups.filter(
    (g) => isBreaking(g.data) || passesImportanceThreshold(g.data.relevance ?? 0, threshold),
  );
}
