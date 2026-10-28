// scoring-engine — the location rule (PURE, RN-free).
//
// A story from a publication in a country none of its matched facts point at
// is caught before any model reads it: the scoring stage scores it 0, marks
// its components `locationCaught`, and the orchestrators save it as a plain
// below-gate row, so it shows only under Show > Discarded by Mera. Field case:
// an Indian reader's "Pensioner in India" fact pulled a Romanian pension story.
//
// shortcut: publication country only; the other-town case waits for ARTICLE_METADATA_PLAN.
//
// Not caught when there is no signal: no publication country (or GLOBAL), no
// matched fact, or ANY matched fact with unknown places (an unswept fact must
// not lose its stories: the fallback to the reader's countries caught 21 of 37
// must-shows on goldset-348). Headline rows: GLOBAL scope is exempt, COUNTRY
// scope is checked against the reader's countries plus the row's own scope
// country. Exempt too: a followed-story match, a title or description that
// names one of the allowed places (or a bloc holding one), and a matched topic
// whose text names the publication country.

import countries from 'i18n-iso-countries';
import type { Bloc } from '../../mera-harness/core/types';
import {
  blocNamedIn,
  countriesNamedIn,
  parsePlace,
  placesCoverCountry,
  type CountriesInBloc,
} from '../persona-management/fact-places';
import type { ScoredCandidateInput } from './relevance';

export interface LocationRuleContext {
  /** Fact id → its stored places. Missing or empty means unknown: the row is exempt. */
  factPlacesById: ReadonlyMap<string, readonly string[]>;
  /** Alpha-2 codes of the reader's unexpired locations (headline rows only). */
  readerCountries: ReadonlySet<string>;
  /** Topic ids with provenance `tracked` (followed stories, the strictMatch topics). */
  trackedTopicIds: ReadonlySet<string>;
  /** Bloc membership, injected: harness code never imports place-service. */
  countriesInBloc: CountriesInBloc;
}

/** The slice of a StageCandidate the rule reads (`legacy` carries the matched facts). */
export interface LocationRuleCandidate {
  input: ScoredCandidateInput;
  legacy?: { relatedFacts: readonly { id: string }[] };
}

/** Alpha-2 for an alpha-2 or alpha-3 code; null for GLOBAL, blank or unknown. */
export function toAlpha2(code: string | null | undefined): string | null {
  const c = (code ?? '').trim().toUpperCase();
  if (c.length === 2) return countries.isValid(c) ? c : null;
  if (c.length === 3) return countries.alpha3ToAlpha2(c) ?? null;
  return null;
}

const wordRe = (name: string) =>
  new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'iu');

/** Does the text name one of these places: its country (name, alias, demonym), its
 *  region or city, or a bloc that holds its country (an EU story for an NL fact)? */
function textNamesPlaces(text: string, places: readonly string[], inBloc: CountriesInBloc): boolean {
  if (!text.trim()) return false;
  const named = new Set(countriesNamedIn(text));
  const blocs = blocNamedIn(text);
  for (const raw of places) {
    const p = parsePlace(raw);
    if (!p) continue;
    if (p.level === 'bloc') {
      if (blocs.includes(p.bloc as Bloc)) return true;
      continue;
    }
    const cc = p.country;
    if (!cc) continue;
    if (named.has(cc)) return true;
    if (blocs.some((b) => inBloc(b).includes(cc))) return true;
    if (p.region && wordRe(p.region).test(text)) return true;
    if (p.city && wordRe(p.city).test(text)) return true;
  }
  return false;
}

/** Ids the rule catches. Never throws; an unparseable input is simply not caught. */
export function screenLocationRule(
  candidates: readonly LocationRuleCandidate[],
  ctx: LocationRuleContext,
): Set<string> {
  const caught = new Set<string>();
  for (const c of candidates) {
    if (isCaught(c, ctx)) caught.add(c.input.id);
  }
  return caught;
}

function isCaught(c: LocationRuleCandidate, ctx: LocationRuleContext): boolean {
  const input = c.input;
  const pub = toAlpha2(input.countryCode);
  if (!pub) return false;

  // The places the row may come from, and whether they are known at all.
  let allowed: string[];
  if (input.headlineScope === 'GLOBAL') return false;
  if (input.headlineScope === 'COUNTRY' || input.headlineScope === 'CITY') {
    allowed = [...ctx.readerCountries];
    const scope = toAlpha2(input.headlineCountryCode);
    if (scope) allowed.push(scope);
    if (allowed.length === 0) return false;
    if (allowed.includes(pub)) return false;
  } else {
    const factIds = c.legacy?.relatedFacts.map((f) => f.id) ?? [];
    if (factIds.length === 0) return false;
    allowed = [];
    for (const id of factIds) {
      const places = ctx.factPlacesById.get(id) ?? [];
      const covers = placesCoverCountry(places, pub, ctx.countriesInBloc);
      if (covers !== false) return false; // unknown places, GLOBAL or a match
      allowed.push(...places);
    }
  }

  if (input.matchedTopics.some((t) => t.topicId != null && ctx.trackedTopicIds.has(t.topicId))) return false;
  if (input.matchedTopics.some((t) => !!t.text && countriesNamedIn(t.text).includes(pub))) return false;
  const text = `${input.titleEn ?? ''}\n${input.descriptionEn ?? ''}`;
  if (textNamesPlaces(text, allowed, ctx.countriesInBloc)) return false;
  return true;
}
