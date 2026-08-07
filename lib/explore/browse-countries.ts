// Explore "browse countries" — the Sources L1 country list's add-on-top-of-
// World scope set (Item 7, decoupling wave).
//
// Tapping "+" on a country in Sources used to call `addUserLocation({role:
// 'interest', ...})`, silently creating a persona Location that then fed geo
// relevance scoring. That coupling is deliberately removed: adding a country
// here must mean "show me this country's news" and NOTHING more — no
// Location, no scoring signal, no PublicationPreference row (that changes
// representative election and Related-Articles tier P, which is more than
// "nothing more" — rejected).
//
// Instead the browse set is a plain JSON array of alpha-2 codes in a single
// setting-service KV row, same store as `explore_last_scope`. `deriveExploreScopes`
// (lib/explore/scopes.ts) takes this array as its third argument, appended
// AFTER location-derived countries and deduped against them.
//
// The KV store has no observable — callers re-read on focus (`useFocusEffect`)
// rather than subscribing.

import { getSetting, setSetting } from '@/lib/database/services/setting-service';

const BROWSE_COUNTRIES_KEY = 'explore_browse_countries';

function normalize(code: string | null | undefined): string {
  return (code ?? '').trim().toUpperCase();
}

/** Dedupe + case-normalize, dropping empties. Order-preserving (first occurrence wins). */
function dedupeNormalize(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of codes) {
    const code = normalize(raw);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * Pure merge: append `code` to `existing` if it isn't already present
 * (case/whitespace-normalized). Idempotent — merging an already-present code
 * returns an equivalent (deduped/normalized) list, not a duplicate.
 */
export function mergeBrowseCountries(
  existing: readonly string[],
  code: string,
): string[] {
  const deduped = dedupeNormalize(existing);
  const target = normalize(code);
  if (!target || deduped.includes(target)) return deduped;
  return [...deduped, target];
}

/**
 * The user's browse-country set, alpha-2, normalized + deduped. Malformed or
 * missing storage (garbage JSON, non-array, non-string members) resolves to
 * `[]` rather than throwing.
 */
export async function getBrowseCountries(): Promise<string[]> {
  const raw = await getSetting(BROWSE_COUNTRIES_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return dedupeNormalize(parsed.filter((x): x is string => typeof x === 'string'));
}

/** Add a country (alpha-2) to the browse set. Idempotent. Returns the resulting set. */
export async function addBrowseCountry(alpha2: string): Promise<string[]> {
  const current = await getBrowseCountries();
  const next = mergeBrowseCountries(current, alpha2);
  await setSetting(BROWSE_COUNTRIES_KEY, JSON.stringify(next));
  return next;
}

/** Remove a country (alpha-2) from the browse set. Idempotent. Returns the resulting set. */
export async function removeBrowseCountry(alpha2: string): Promise<string[]> {
  const current = await getBrowseCountries();
  const target = normalize(alpha2);
  const next = current.filter((c) => c !== target);
  await setSetting(BROWSE_COUNTRIES_KEY, JSON.stringify(next));
  return next;
}
