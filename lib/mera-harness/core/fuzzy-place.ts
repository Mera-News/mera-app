// mera-harness/core — did the USER name this place? PURE, RN-free.
//
// Friction this removes: the district check was an exact substring of the
// user's words, so "Nieuw-West" failed against "niew west" and the model,
// unable to propose the district, asked about it and invented the options
// (ux2 D2). The match is fuzzy but bounded per word, so a typo passes and an
// invented district of similar length does not.

import type { Place } from './types';

/** Lower case, accents dropped, hyphens and punctuation as spaces, a leading
 *  "the" dropped, spaces collapsed. */
export function foldPlace(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'`.,;:()\-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the\s+/, '');
}

/** Edits allowed for a word of this length: none up to 3 letters, one up to 5,
 *  two above that. */
function budget(length: number): number {
  if (length <= 3) return 0;
  if (length <= 5) return 1;
  return 2;
}

/** Levenshtein distance, abandoned once it exceeds `max`. */
function withinDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return false;
    prev = row;
  }
  return prev[b.length] <= max;
}

/**
 * True when `term` appears in `userMessage` up to a typo: a run of the
 * message's words matches the term's words one for one, each within its
 * budget, or the run written together matches the term written together.
 */
export function userSaidPlace(term: string, userMessage: string): boolean {
  const t = foldPlace(term);
  if (!t) return false;
  const said = foldPlace(userMessage);
  if (` ${said} `.includes(` ${t} `)) return true;
  const tw = t.split(' ');
  const mw = said.split(' ');
  const joined = tw.join('');
  for (let start = 0; start < mw.length; start++) {
    // Word for word.
    if (start + tw.length <= mw.length) {
      const window = mw.slice(start, start + tw.length);
      if (window.every((w, k) => withinDistance(w, tw[k], budget(Math.max(w.length, tw[k].length))))) {
        return true;
      }
    }
    // Written together on either side ("nieuwwest", "nieuw west").
    for (let len = 1; len <= Math.min(3, mw.length - start); len++) {
      const run = mw.slice(start, start + len).join('');
      if (run.length < 4) continue;
      if (withinDistance(run, joined, budget(Math.max(run.length, joined.length)))) return true;
    }
  }
  return false;
}


/** "niew west" as a name: each word capitalised, nothing else changed. */
function titleCase(words: string): string {
  return words
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The district to put first in a loop-written home, spelled the way the MODEL
 * spelled it this turn when that spelling is a typo-distance match for the
 * words the lookup could not place ("Nieuw-West" for "niew west"), else the
 * user's own words title-cased. Never an invented district: a model term must
 * match the user's words both ways.
 */
export function correctedDistrict(finerArea: string, modelTexts: readonly string[]): string {
  const wanted = foldPlace(finerArea);
  let found: string | null = null;
  for (const text of modelTexts) {
    const tokens = text.split(/[\s,.!?;:()"“”{}\[\]]+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      for (let len = 1; len <= 3 && i + len <= tokens.length; len++) {
        const run = tokens.slice(i, i + len).join(' ');
        if (!/[A-Z]/.test(run)) continue;
        const folded = foldPlace(run);
        if (Math.abs(folded.length - wanted.length) > 3) continue;
        if (userSaidPlace(run, finerArea) && userSaidPlace(finerArea, run)) {
          // A HYPHENATED spelling wins over a spaced one (ux2 batch 25, D1):
          // "Nieuw-West" from the model's own lookup over "Nieuw West" copied
          // from an older fact.
          if (run.includes('-')) return run;
          found = found ?? run;
        }
      }
    }
  }
  return found ?? titleCase(finerArea);
}

/**
 * The hyphenated spelling of `term` the turn used anywhere, when one folds to
 * the same words; else `term`. The place service has no districts, so the
 * turn's own text is the only source of a canonical district spelling.
 */
export function hyphenatedSpelling(term: string, modelTexts: readonly string[]): string {
  const wanted = foldPlace(term);
  if (!wanted || term.includes('-')) return term;
  for (const text of modelTexts) {
    for (const token of text.split(/[\s,.!?;:()"“”{}\[\]]+/)) {
      if (token.includes('-') && foldPlace(token) === wanted) return token;
    }
  }
  return term;
}

function endsWithTerm(head: string, term: string | null | undefined): boolean {
  if (!term) return false;
  const h = foldPlace(head);
  const t = foldPlace(term);
  return t.length > 0 && (h === t || h.endsWith(` ${t}`));
}

/**
 * A place chain written by the MODEL, checked against the place the lookup
 * returned (ux2 D13). The statement's rungs after the first must be the looked
 * up doc's own locality, region, country or bloc, or words the user said: the
 * saved chain "Vila Baleira, Machico, Madeira" carried an invented "Machico".
 * When the lookup matched the user's term through an alias, that term is put
 * first ("Porto Santo (Vila Baleira)"). A statement naming none of these
 * places is returned unchanged.
 */
export function guardPlaceRungs(
  statement: string,
  places: readonly Place[],
  userMessage: string,
): string {
  const parts = statement.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return statement;
  const [head, ...rest] = parts;
  const place = places.find(
    (p) =>
      endsWithTerm(head, p.locality)
      || endsWithTerm(head, p.userTerm)
      || (endsWithTerm(head, p.neighbourhood) || rest.some((r) => foldPlace(r) === foldPlace(p.locality))),
  );
  if (!place) return statement;
  let first = head;
  if (place.userTerm && !foldPlace(head).includes(foldPlace(place.userTerm)) && endsWithTerm(head, place.locality)) {
    const at = head.toLowerCase().lastIndexOf(place.locality.toLowerCase());
    if (at >= 0) first = `${head.slice(0, at)}${place.userTerm} (${place.locality})`;
  }
  const allowed = new Set(
    [place.locality, place.admin1, place.countryName, place.bloc, place.neighbourhood, place.userTerm]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .map(foldPlace),
  );
  // A rung the first one already names goes too: "Porto Santo (Vila Baleira),
  // Porto Santo, Madeira" was measured on staging, a stutter on the card.
  const inFirst = ` ${foldPlace(first)} `;
  const kept = rest.filter(
    (r) =>
      (allowed.has(foldPlace(r)) || userSaidPlace(r, userMessage))
      && !inFirst.includes(` ${foldPlace(r)} `),
  );
  const out = [first, ...kept].join(', ');
  return out === parts.join(', ') ? statement : out;
}
