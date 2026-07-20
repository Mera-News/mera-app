// Module-level LRU cache (insertion-order eviction, cap 100) for topic→facts
// lookups. Cards that share the same topic set (common within a fact section)
// resolve from here instead of re-querying WatermelonDB on mount (perf A5).
// Keyed by the SORTED, joined topic ids so ordering doesn't matter.
//
// Extracted verbatim from ArticleSuggestionContainer during the card-hierarchy
// refactor so the suggestion card owns its own fact-chip cache.

import type { Fact } from '@/lib/mera-protocol-toolkit/types';

const FACTS_CACHE_MAX = 100;
const factsCache = new Map<string, Fact[]>();

export function getCachedFacts(key: string): Fact[] | undefined {
  const hit = factsCache.get(key);
  if (hit !== undefined) {
    // Refresh recency: re-insert so it becomes most-recently-used.
    factsCache.delete(key);
    factsCache.set(key, hit);
  }
  return hit;
}

export function setCachedFacts(key: string, value: Fact[]): void {
  if (factsCache.has(key)) factsCache.delete(key);
  factsCache.set(key, value);
  if (factsCache.size > FACTS_CACHE_MAX) {
    const oldest = factsCache.keys().next().value;
    if (oldest !== undefined) factsCache.delete(oldest);
  }
}
