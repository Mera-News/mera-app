// mera-harness/core: binding a model's choice chips to the places the port returned.
// PURE, RN-free. Split out of core.ts; the loop calls these from its ask_choice leg.

import { userSaidPlace } from './fuzzy-place';
import type { AgentChoiceOption, Place } from './types';

/** A place the model copied back is reconciled against the candidates the port
 *  ACTUALLY returned this turn, rather than re-derived from a country map the
 *  harness deliberately does not own. Stronger than trusting a copy-verbatim
 *  rule, and it needs no import. */
export function reconcilePlaceChain(
  supplied: Record<string, unknown> | null,
  candidates: Place[],
  userMessage: string,
): Place | null {
  if (candidates.length === 0) return null;
  const wantedLocality =
    supplied && typeof supplied.locality === 'string' ? supplied.locality.toLowerCase() : null;
  const match =
    (wantedLocality && candidates.find((c) => c.locality.toLowerCase() === wantedLocality)) ||
    (candidates.length === 1 ? candidates[0] : null);
  if (!match) return null;

  // `neighbourhood` is the one place field with no GraphQL source, so it is the
  // one the model can invent. Accept it only when the user actually said it;
  // otherwise DROP it and keep the rest of the chain, which is still good.
  // A TYPO-DISTANCE match counts (ux2 D2): "Nieuw-West" against "niew west"
  // is the canonical spelling of what the user said, and the model can only
  // propose the district if this accepts it. An invented district of similar
  // length still fails.
  const suppliedHood =
    supplied && typeof supplied.neighbourhood === 'string' ? supplied.neighbourhood.trim() : '';
  const hood =
    suppliedHood && userSaidPlace(suppliedHood, userMessage)
      ? suppliedHood
      : match.neighbourhood;

  return hood ? { ...match, neighbourhood: hood } : { ...match, neighbourhood: undefined };
}

/** Pair each chip with the structured value it stands for. Matched by content,
 *  not position: positional pairing silently mis-binds the moment the model
 *  reorders its own options. Unmatched options carry a null payload rather than
 *  a wrong one.
 *
 *  The MOST SPECIFIC match wins, not the first: "Newcastle" is inside
 *  "Newcastle-under-Lyme", and a first-hit match bound that chip to Newcastle,
 *  New South Wales (ux2 batch 27). */
export function bindChoicePayloads(
  options: string[],
  candidates: Place[],
): { text: string; payload: unknown }[] {
  return options.map((text) => {
    const lower = text.toLowerCase();
    // Score = the characters of the option this candidate's names account
    // for, so district plus city beats city alone, and a longer city beats a
    // shorter one it contains. Ties keep the earlier candidate.
    let hit: Place | null = null;
    let best = 0;
    for (const c of candidates) {
      const score = [c.neighbourhood, c.locality]
        .map((name) => name?.toLowerCase())
        .filter((n): n is string => !!n && lower.includes(n))
        .reduce((sum, n) => sum + n.length, 0);
      if (score > best) {
        hit = c;
        best = score;
      }
    }
    return { text, payload: hit };
  });
}

/** A place's chain from lookup data only: district, city, region, country,
 *  with a part that repeats the one before it dropped ("Singapore,
 *  Singapore"). Never invented. */
function placeChainLabel(p: Place): string {
  const parts: string[] = [];
  for (const part of [p.neighbourhood, p.locality, p.admin1, p.countryName]) {
    const t = part?.trim();
    if (t && !parts.some((q) => q.toLowerCase() === t.toLowerCase())) parts.push(t);
  }
  return parts.join(', ');
}

/** Everyday names for a country that the lookup data does not spell out. */
const COUNTRY_ALIASES: Record<string, string[]> = { GB: ['uk', 'britain'], US: ['usa'] };

function namesItsCountry(text: string, p: Place): boolean {
  const lower = text.toLowerCase();
  if (p.countryName && lower.includes(p.countryName.toLowerCase())) return true;
  const words = new Set(lower.split(/[^a-z]+/).filter(Boolean));
  return words.has(p.countryCode.toLowerCase()) || (COUNTRY_ALIASES[p.countryCode] ?? []).some((a) => words.has(a));
}

/**
 * A place chip reads as the place it stands for (ux2 batch 27). The model
 * writes chips freely and, with candidates resolved, wrote bare localities 5
 * of 5 times ("Newcastle upon Tyne", "Newcastle", "Newcastle-under-Lyme"): a
 * bare "Newcastle" says nothing about which one. When the chips are not
 * already distinct AND country-bearing, or two share a city, EVERY bound chip
 * takes its lookup chain. An unbound chip stays verbatim. Texts that would
 * collide after expansion keep the model's wording, since the tap is matched
 * back by text.
 */
export function expandChoiceLabels(bound: AgentChoiceOption[]): AgentChoiceOption[] {
  const places = bound.map((b) => placeFromPayload(b.payload));
  if (places.every((p) => p === null)) return bound;
  const texts = bound.map((b) => b.text.trim().toLowerCase());
  const distinct = new Set(texts).size === texts.length;
  const cities = places.filter((p): p is Place => p !== null).map((p) => p.locality.toLowerCase());
  const sharedCity = new Set(cities).size !== cities.length;
  const allNameCountry = bound.every((b, i) => places[i] === null || namesItsCountry(b.text, places[i] as Place));
  if (distinct && !sharedCity && allNameCountry) return bound;
  const expanded = bound.map((b, i) => {
    const place = places[i];
    if (!place) return b;
    const text = placeChainLabel(place);
    return text === b.text ? b : { ...b, text, modelText: b.text };
  });
  const out = expanded.map((e) => e.text.trim().toLowerCase());
  return new Set(out).size === out.length ? expanded : bound;
}

/** A chip payload that is a Place (the only structured payload a chip
 *  carries today), or null. */
export function placeFromPayload(payload: unknown): Place | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Partial<Place>;
  return typeof p.locality === 'string' && typeof p.countryCode === 'string' ? (p as Place) : null;
}
