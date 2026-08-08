// Explore "hidden" scopes (Item 18) — long-pressing a LOCATION-DERIVED chip
// in ScopeChipRow must hide it without deleting the underlying location (and
// therefore without touching its geo-scoring signal). A browse-added chip
// (lib/explore/browse-countries.ts) has no such signal to protect — hiding
// one of those just calls `removeBrowseCountry` directly and never touches
// this set.
//
// Storage: a second setting-service KV row, JSON array of Explore scope ids
// (e.g. `country:IND`) — NOT alpha-2 codes, since the caller (ExploreScreen)
// filters the already-derived `ExploreScope[]` by id. `world` can never be
// hideable, so it is defensively stripped on every write/read.

import { getSetting, setSetting } from '@/lib/database/services/setting-service';

const SUPPRESSED_SCOPES_KEY = 'explore_suppressed_scopes';
const WORLD_SCOPE_ID = 'world';

function normalize(id: string | null | undefined): string {
  return (id ?? '').trim();
}

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = normalize(raw);
    if (!id || id === WORLD_SCOPE_ID || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The user's suppressed (hidden) scope ids. Malformed or missing storage
 * (garbage JSON, non-array, non-string members) resolves to `[]`. `world` is
 * never present even if it was somehow written previously.
 */
export async function getSuppressedScopeIds(): Promise<string[]> {
  const raw = await getSetting(SUPPRESSED_SCOPES_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return dedupe(parsed.filter((x): x is string => typeof x === 'string'));
}

/** Hide a scope id. No-op for `world`. Idempotent. Returns the resulting set. */
export async function addSuppressedScopeId(id: string): Promise<string[]> {
  const current = await getSuppressedScopeIds();
  const next = dedupe([...current, id]);
  await setSetting(SUPPRESSED_SCOPES_KEY, JSON.stringify(next));
  return next;
}

/** Un-hide a scope id. Idempotent. Returns the resulting set. */
export async function removeSuppressedScopeId(id: string): Promise<string[]> {
  const current = await getSuppressedScopeIds();
  const target = normalize(id);
  const next = current.filter((c) => c !== target);
  await setSetting(SUPPRESSED_SCOPES_KEY, JSON.stringify(next));
  return next;
}
