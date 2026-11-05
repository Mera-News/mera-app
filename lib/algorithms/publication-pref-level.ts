// publication-pref-level: the preference state of ONE PUBLICATION, read
// across every name it is known by. Pure: no database, no network, so a
// Sources row and a card can import it (a DB import in the card graph kills
// every card suite on initializeJSI).
//
// Why a publication has several names. Articles carry the SOURCE's
// `publication_name`, and a publisher's sources do not all share the
// publisher's own name. Scoring matches a preference row by that source name
// (normalized), so a preference written under the publisher name alone misses
// every source named differently. A publication's preference is therefore a
// SET of rows, one per name, and its state is read across all of them.
//
// Mixed state: a mute wins over a preference. A reader who hid any of the
// names has not been overruled by an older star on another.
//
// A stored -0.5 row (the retired Fewer) reads as neither state. It keeps its
// ranking effect until the next set replaces it.

import { normalizeKey } from '@/lib/algorithms/normalize-key';

/** `'deprioritised'` is write-only and goes once its last caller has moved. */
export type SourcePrefUiLevel = 'none' | 'prioritised' | 'muted' | 'deprioritised';

/** A publication preference at or below this weight is a mute. */
export const MUTE_WEIGHT = -0.9;

/** The normalization publication preferences match on: lowercase, trimmed,
 *  inner whitespace collapsed. The ONE definition; the preference service
 *  imports it, so reads and writes cannot drift apart. */
export function normalizePrefName(s: string): string {
  return normalizeKey(s);
}

/** The part of a `publication_preferences` row this module reads. */
export interface PrefRowLike {
  readonly publicationName: string;
  readonly weight: number;
  readonly scopeKind?: string | null;
  /** ISO alpha-3 on a country row. */
  readonly scopeValue?: string | null;
  readonly status?: string;
}

type NameInput = string | null | undefined | readonly (string | null | undefined)[];

/**
 * Every name a publication is known by, deduplicated on the normalized form.
 * The first spelling seen is kept, so pass the most readable source first
 * (the preference screen shows the stored spelling). Empty names are dropped.
 */
export function publisherPrefNames(...inputs: NameInput[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const input of inputs) {
    const list = Array.isArray(input) ? input : [input];
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      const norm = normalizePrefName(trimmed);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * The level of a publication, given the preference rows (typically the
 * observed ACTIVE rows) and every name the publication is known by.
 * Synchronous: a list row calls it on each render of an observed row set.
 */
export function resolvePrefLevel(
  rows: readonly PrefRowLike[],
  names: readonly string[],
): SourcePrefUiLevel {
  if (names.length === 0 || rows.length === 0) return 'none';
  const wanted = new Set(names.map(normalizePrefName).filter(Boolean));
  let more = false;
  for (const row of rows) {
    if (row.scopeKind != null) continue; // a country scope's label is not a name
    if (row.status !== undefined && row.status !== 'active') continue;
    if (!wanted.has(normalizePrefName(row.publicationName ?? ''))) continue;
    if (row.weight <= MUTE_WEIGHT) return 'muted';
    if (row.weight > 0) more = true;
  }
  return more ? 'prioritised' : 'none';
}

/**
 * Whether a publication's star comes from its country: the country is preferred
 * and none of the publication's names has a row of its own (a stored Fewer
 * counts, because it outranks the country in the sort). Pass the rows of
 * `observeActive`, which include scope rows.
 */
export function isStarInherited(
  rows: readonly PrefRowLike[],
  names: readonly string[],
  countryAlpha3: string | null | undefined,
): boolean {
  const country = countryAlpha3?.trim().toUpperCase();
  if (!country) return false;
  const wanted = new Set(names.map(normalizePrefName).filter(Boolean));
  let inherited = false;
  for (const row of rows) {
    if (row.status !== undefined && row.status !== 'active') continue;
    if (row.scopeKind === 'country') {
      if (row.weight > 0 && row.scopeValue?.trim().toUpperCase() === country) inherited = true;
    } else if (row.scopeKind == null && row.weight !== 0 && wanted.has(normalizePrefName(row.publicationName ?? ''))) {
      return false;
    }
  }
  return inherited;
}
