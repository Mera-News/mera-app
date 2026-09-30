// publication-pref-level: the more/fewer state of ONE PUBLICATION, read
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
// Mixed state: fewer wins over more. A reader who once said "fewer" about any
// of the names has not been overruled by an older "more" on another.

export type SourcePrefUiLevel = 'none' | 'prioritised' | 'deprioritised';

/** The normalization publication preferences match on: lowercase, trimmed,
 *  inner whitespace collapsed. The ONE definition; the preference service
 *  imports it, so reads and writes cannot drift apart. */
export function normalizePrefName(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** The part of a `publication_preferences` row this module reads. */
export interface PrefRowLike {
  readonly publicationName: string;
  readonly weight: number;
  readonly scopeKind?: string | null;
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
 * The 3-state level of a publication, given the preference rows (typically
 * the observed ACTIVE rows) and every name the publication is known by.
 * Synchronous: a list row calls it on each render of an observed row set.
 *
 * A mute (weight <= -0.9) reads as `deprioritised`: the 3-state control has no
 * mute, and a mute is the strongest "fewer".
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
    if (row.weight < 0) return 'deprioritised';
    if (row.weight > 0) more = true;
  }
  return more ? 'prioritised' : 'none';
}
