// news-harness — fact places (PURE, RN-free).
//
// A fact carries WHERE its news should come from in `metadata.places`:
//   GLOBAL                 anywhere
//   <Bloc value>           EU, Asia, North America, ... (lib/mera-harness Bloc)
//   CC                     a country, ISO alpha-2
//   CC|Region              a region of that country
//   CC|Region|City         a city (region may be empty); the deepest level
// plus `metadata.places_by` ('sweep' | 'user' | 'chat') and
// `metadata.places_source` (placesSourceHash of what the sweep decided from).
// These are NOT `locations` rows: those feed Places, World pages and headline
// scopes.
//
// No LLM ever sees or writes a code: prompts get `describeFactPlaces` /
// `factLineWithPlaces`, and model output comes back as names through
// `placeFromNames`. Bloc membership is injected (`CountriesInBloc`, built from
// place-service's map) because harness code never imports place-service.

import countries from 'i18n-iso-countries';
import enCountryNames from 'i18n-iso-countries/langs/en.json';
import type { Bloc } from '../../mera-harness/core/types';
import { getCountryName } from '../../algorithms/country-utils';
import { resolveCountryCode } from './persona-migration';

countries.registerLocale(enCountryNames);

// ── Shapes ────────────────────────────────────────────────────────────────

export const PLACE_GLOBAL = 'GLOBAL';
export type PlaceLevel = 'global' | 'bloc' | 'country' | 'region' | 'city';
export type PlacesBy = 'sweep' | 'user' | 'chat';

export interface ParsedPlace {
  level: PlaceLevel;
  bloc?: Bloc;
  /** ISO alpha-2, upper-cased. */
  country?: string;
  region?: string;
  city?: string;
}

/** A reader's place (a `locations` row), as the harness sees it. */
export interface ReaderPlace {
  countryCode: string;
  region: string | null;
  city: string | null;
  role: string;
}

export type CountriesInBloc = (bloc: Bloc) => readonly string[];

/** Anything with a statement and the fact's metadata (the Fact DTO fits). */
export interface FactPlacesInput {
  statement: string;
  metadata?: Record<string, unknown> | null;
}

export interface FactPlaceOption {
  place: string;
  level: PlaceLevel;
  /** English name only ("Bhopal", "India"); GLOBAL reads "Anywhere". */
  label: string;
}

/** The roles whose places decide a fact's place; travel/interest churn too much. */
export const RESIDENCE_ROLES: ReadonlySet<string> = new Set(['home', 'work']);

// ── Bloc vocabulary ───────────────────────────────────────────────────────

// 'UK' is a Bloc value, but as a place it is the country GB (one spelling).
const PLACE_BLOCS: ReadonlySet<string> = new Set<Bloc>([
  'EU', 'EEA', 'EFTA', 'Europe', 'Asia', 'Africa',
  'North America', 'South America', 'Oceania', 'Antarctica',
]);

const BLOC_PROSE: Record<Bloc, string> = {
  EU: 'the European Union',
  EEA: 'the European Economic Area',
  EFTA: 'the European Free Trade Association',
  UK: 'the United Kingdom',
  Europe: 'Europe',
  Asia: 'Asia',
  Africa: 'Africa',
  'North America': 'North America',
  'South America': 'South America',
  Oceania: 'Oceania',
  Antarctica: 'Antarctica',
};

const BLOC_LABEL: Record<Bloc, string> = {
  ...BLOC_PROSE,
  EU: 'European Union',
  EEA: 'European Economic Area',
  EFTA: 'European Free Trade Association',
  UK: 'United Kingdom',
};

/** Longest forms first, so "European Union" is consumed before "European".
 *  Acronyms are case-sensitive ("eu" is not the EU). */
const BLOC_PATTERNS: readonly [RegExp, Bloc][] = [
  [/\bEuropean Economic Area\b/gi, 'EEA'],
  [/\bEuropean Free Trade Association\b/gi, 'EFTA'],
  [/\bEuropean Union\b/gi, 'EU'],
  [/\bEEA\b/g, 'EEA'],
  [/\bEFTA\b/g, 'EFTA'],
  [/\bEU\b/g, 'EU'],
  [/\bEurope(?:an)?\b/gi, 'Europe'],
  [/\bNorth American?\b/gi, 'North America'],
  [/\bSouth American?\b/gi, 'South America'],
  [/\bAsian?\b/gi, 'Asia'],
  [/\bAfrican?\b/gi, 'Africa'],
  [/\bOceania\b/gi, 'Oceania'],
  [/\bAntarctic(?:a)?\b/gi, 'Antarctica'],
];

const BLOC_BY_NAME: ReadonlyMap<string, Bloc> = new Map<string, Bloc>([
  ...(Object.entries(BLOC_LABEL) as [Bloc, string][]).map(([b, n]) => [n.toLowerCase(), b] as [string, Bloc]),
  ...([...PLACE_BLOCS] as Bloc[]).map((b) => [b.toLowerCase(), b] as [string, Bloc]),
]);

// ── Country vocabulary ────────────────────────────────────────────────────

/**
 * Nationality/adjectival forms → alpha-2. The curated country-name map only
 * matches nouns, so "Follows Brazilian football" resolves nothing without this.
 * Hand-curated, therefore allowed in a free position (geo-derivation tier 1).
 */
export const DEMONYMS: Record<string, string> = {
  'dutch': 'NL', 'german': 'DE', 'french': 'FR', 'spanish': 'ES',
  'portuguese': 'PT', 'italian': 'IT', 'belgian': 'BE', 'austrian': 'AT',
  'swiss': 'CH', 'british': 'GB', 'english': 'GB', 'scottish': 'GB',
  'welsh': 'GB', 'irish': 'IE', 'polish': 'PL', 'ukrainian': 'UA',
  'russian': 'RU', 'czech': 'CZ', 'slovak': 'SK', 'hungarian': 'HU',
  'romanian': 'RO', 'bulgarian': 'BG', 'greek': 'GR', 'turkish': 'TR',
  'swedish': 'SE', 'norwegian': 'NO', 'danish': 'DK', 'finnish': 'FI',
  'icelandic': 'IS', 'estonian': 'EE', 'latvian': 'LV', 'lithuanian': 'LT',
  'croatian': 'HR', 'serbian': 'RS', 'slovenian': 'SI',
  'american': 'US', 'canadian': 'CA', 'mexican': 'MX', 'brazilian': 'BR',
  'argentine': 'AR', 'argentinian': 'AR', 'chilean': 'CL', 'colombian': 'CO',
  'peruvian': 'PE', 'uruguayan': 'UY',
  'indian': 'IN', 'chinese': 'CN', 'japanese': 'JP', 'korean': 'KR',
  'south korean': 'KR', 'indonesian': 'ID', 'thai': 'TH', 'vietnamese': 'VN',
  'filipino': 'PH', 'philippine': 'PH', 'malaysian': 'MY', 'singaporean': 'SG',
  'taiwanese': 'TW', 'pakistani': 'PK', 'bangladeshi': 'BD',
  'sri lankan': 'LK', 'nepali': 'NP', 'nepalese': 'NP',
  'israeli': 'IL', 'saudi': 'SA', 'emirati': 'AE', 'qatari': 'QA',
  'kuwaiti': 'KW', 'jordanian': 'JO', 'lebanese': 'LB', 'iranian': 'IR',
  'iraqi': 'IQ', 'egyptian': 'EG', 'nigerian': 'NG', 'south african': 'ZA',
  'kenyan': 'KE', 'ethiopian': 'ET', 'ghanaian': 'GH', 'moroccan': 'MA',
  'tunisian': 'TN', 'algerian': 'DZ', 'tanzanian': 'TZ', 'ugandan': 'UG',
  'australian': 'AU', 'new zealander': 'NZ',
};

/** A country name, alias or demonym → alpha-2, or null. Never accepts a code. */
function countryFromName(name: string): string | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  const lower = n.toLowerCase();
  const code = resolveCountryCode(n) ?? DEMONYMS[lower] ?? countries.getAlpha2Code(n, 'en') ?? null;
  return code ? code.toUpperCase() : null;
}

function countryName(alpha2: string): string {
  const a3 = countries.alpha2ToAlpha3(alpha2);
  return a3 ? getCountryName(a3) : alpha2;
}

// ── Parse / normalize ─────────────────────────────────────────────────────

const MAX_PART_CHARS = 80;

function cleanPart(s: string | undefined | null): string {
  const t = (s ?? '').trim().replace(/\s+/g, ' ');
  return t.length <= MAX_PART_CHARS ? t : '';
}

/** One stored value → its parts, or null when malformed. */
export function parsePlace(raw: string): ParsedPlace | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === PLACE_GLOBAL) return { level: 'global' };
  if (value === 'UK') return { level: 'country', country: 'GB' };
  if (PLACE_BLOCS.has(value)) return { level: 'bloc', bloc: value as Bloc };
  const parts = value.split('|');
  const cc = parts[0];
  if (!/^[A-Z]{2}$/.test(cc) || !countries.isValid(cc)) return null;
  if (parts.length === 1) return { level: 'country', country: cc };
  const region = cleanPart(parts[1]);
  if (parts.length === 2) return region ? { level: 'region', country: cc, region } : null;
  const city = cleanPart(parts[2]);
  if (parts.length === 3 && city) {
    return region ? { level: 'city', country: cc, region, city } : { level: 'city', country: cc, city };
  }
  return null;
}

function formatPlace(p: ParsedPlace): string {
  switch (p.level) {
    case 'global': return PLACE_GLOBAL;
    case 'bloc': return p.bloc as string;
    case 'country': return p.country as string;
    case 'region': return `${p.country}|${p.region}`;
    case 'city': return `${p.country}|${p.region ?? ''}|${p.city}`;
  }
}

/** Drop malformed values, canonicalize, dedupe. A specific place outranks
 *  GLOBAL, so GLOBAL survives only alone (the UI passes ['GLOBAL'] for Anywhere). */
export function normalizePlaces(places: readonly unknown[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of places ?? []) {
    const parsed = typeof raw === 'string' ? parsePlace(raw) : null;
    if (!parsed) continue;
    const value = formatPlace(parsed);
    if (!out.includes(value)) out.push(value);
  }
  return out.length > 1 ? out.filter((p) => p !== PLACE_GLOBAL) : out;
}

export function factPlaces(fact: FactPlacesInput): string[] {
  const raw = fact.metadata?.places;
  return Array.isArray(raw) ? normalizePlaces(raw) : [];
}

export function factPlacesBy(fact: FactPlacesInput): PlacesBy | null {
  const by = fact.metadata?.places_by;
  return by === 'sweep' || by === 'user' || by === 'chat' ? by : null;
}

// ── Names ─────────────────────────────────────────────────────────────────

/** Prose name for prompts: "Bhopal, Madhya Pradesh, India", "the European Union". */
export function describePlace(place: string): string | null {
  const p = parsePlace(place);
  if (!p) return null;
  switch (p.level) {
    case 'global': return 'anywhere in the world';
    case 'bloc': return BLOC_PROSE[p.bloc as Bloc];
    case 'country': return countryName(p.country as string);
    case 'region': return `${p.region}, ${countryName(p.country as string)}`;
    case 'city': return [p.city, p.region, countryName(p.country as string)].filter(Boolean).join(', ');
  }
}

/** Short English label for a chip or an option: the place's own name only. */
export function placeLabel(place: string): string | null {
  const p = parsePlace(place);
  if (!p) return null;
  switch (p.level) {
    case 'global': return 'Anywhere';
    case 'bloc': return BLOC_LABEL[p.bloc as Bloc];
    case 'country': return countryName(p.country as string);
    case 'region': return p.region as string;
    case 'city': return p.city as string;
  }
}

/** Names only, never codes. Null when the fact has no places. */
export function describeFactPlaces(fact: FactPlacesInput): string | null {
  const names = factPlaces(fact).map(describePlace).filter((n): n is string => !!n);
  return names.length > 0 ? names.join('; ') : null;
}

/** The fact as every cloud prompt shows it: "<statement> (news from: <names>)". */
export function factLineWithPlaces(fact: FactPlacesInput): string {
  const names = describeFactPlaces(fact);
  return names ? `${fact.statement} (news from: ${names})` : fact.statement;
}

/**
 * A place from the names a model (or chat tool) wrote, or null when any name
 * does not resolve. `level` is 'anywhere' | 'bloc' | 'country' | 'region' | 'city'.
 */
export function placeFromNames(names: {
  level?: unknown;
  bloc?: unknown;
  country?: unknown;
  region?: unknown;
  city?: unknown;
}): string | null {
  const str = (v: unknown) => (typeof v === 'string' ? cleanPart(v) : '');
  const level = str(names.level).toLowerCase();
  if (level === 'anywhere' || level === 'global') return PLACE_GLOBAL;
  if (level === 'bloc') {
    const name = str(names.bloc).toLowerCase();
    const bloc = BLOC_BY_NAME.get(name);
    if (bloc) return bloc === 'UK' ? 'GB' : bloc;
    return null;
  }
  if (level !== 'country' && level !== 'region' && level !== 'city') return null;
  const cc = countryFromName(str(names.country));
  if (!cc) return null;
  if (level === 'country') return cc;
  const region = str(names.region).replace(/\|/g, ' ');
  if (level === 'region') return region ? `${cc}|${region}` : null;
  const city = str(names.city).replace(/\|/g, ' ');
  return city ? `${cc}|${region}|${city}` : null;
}

// ── Text matching (titles, descriptions) ──────────────────────────────────

/**
 * Alpha-2 codes a text names by country name, alias or demonym. Proper nouns
 * only (an English title capitalizes them), so "turkey recipes" names nothing;
 * "US" must be upper-case. shortcut: a Title Case "Turkey Recipes" still names
 * TR; acceptable while the only caller uses it to EXEMPT a story.
 */
export function countriesNamedIn(text: string): string[] {
  const words = (text ?? '').replace(/[‘’]/g, "'").replace(/'s\b/g, '').split(/[^A-Za-zÀ-ɏ]+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    if (!/^[A-ZÀ-Þ]/.test(words[i])) continue;
    for (let n = Math.min(4, words.length - i); n >= 1; n--) {
      const raw = words.slice(i, i + n).join(' ');
      if (raw.toLowerCase() === 'us' && raw !== 'US') continue;
      const code = countryFromName(raw);
      if (code) {
        out.add(code);
        i += n - 1;
        break;
      }
    }
  }
  return [...out];
}

/** Blocs a text names ("European Union", "EU", "Asian"). Never 'UK': that is a country. */
export function blocNamedIn(text: string): Bloc[] {
  let rest = text ?? '';
  const out: Bloc[] = [];
  for (const [re, bloc] of BLOC_PATTERNS) {
    re.lastIndex = 0;
    if (!re.test(rest)) continue;
    if (!out.includes(bloc)) out.push(bloc);
    re.lastIndex = 0;
    rest = rest.replace(re, ' ');
  }
  return out;
}

// ── Sweep bookkeeping and matching ────────────────────────────────────────

/** Bump to make every fact re-decide once (a prompt or decoder change). */
const PLACES_SWEEP_VERSION = 'p1';

/** What the sweep decided a fact's place from: the statement plus the reader's
 *  residence places (home, work). Order-independent over the places. */
export function placesSourceHash(statement: string, locations: readonly ReaderPlace[]): string {
  const tuples = [
    ...new Set(
      locations
        .filter((l) => RESIDENCE_ROLES.has(l.role))
        .map((l) => [l.countryCode, l.region ?? '', l.city ?? ''].map((s) => s.trim().toLowerCase()).join('|')),
    ),
  ].sort();
  const joined = `${PLACES_SWEEP_VERSION}\n${(statement ?? '').trim()}\n${tuples.join('\n')}`;
  let hash = 5381;
  for (let i = 0; i < joined.length; i++) hash = ((hash << 5) + hash + joined.charCodeAt(i)) | 0;
  return `${PLACES_SWEEP_VERSION}:${(hash >>> 0).toString(36)}`;
}

/** Does a fact's place list cover a country? null when there are no places
 *  (the caller decides; the location rule treats unknown as exempt). */
export function placesCoverCountry(
  places: readonly string[],
  alpha2: string,
  countriesInBloc: CountriesInBloc,
): boolean | null {
  const parsed = normalizePlaces(places).map(parsePlace).filter((p): p is ParsedPlace => !!p);
  if (parsed.length === 0) return null;
  const cc = (alpha2 ?? '').trim().toUpperCase();
  return parsed.some(
    (p) =>
      p.level === 'global' ||
      p.country === cc ||
      (p.level === 'bloc' && countriesInBloc(p.bloc as Bloc).includes(cc)),
  );
}

/** What a fact's topics depend on: its countries (at any depth), blocs or
 *  GLOBAL. Topics regenerate only when this changes. shortcut: a bloc is its
 *  own key, not its members; upgrade if a bloc-to-country move must not regenerate. */
export function placesCoverageKey(places: readonly string[]): string {
  const keys = normalizePlaces(places).map((p) => {
    const parsed = parsePlace(p);
    return parsed?.country ?? parsed?.bloc ?? PLACE_GLOBAL;
  });
  return [...new Set(keys)].sort().join(',');
}

const LEVEL_RANK: Record<PlaceLevel, number> = { global: 1, bloc: 1, country: 1, region: 2, city: 3 };

/**
 * "Where should news for <fact> come from?" options: the reader's places at the
 * fact's current level and every level up to the country (a fact with no
 * places gets countries only), narrowest first, then GLOBAL last.
 */
export function suggestFactPlaceOptions(
  fact: FactPlacesInput,
  locations: readonly ReaderPlace[],
): FactPlaceOption[] {
  const depth = Math.max(1, ...factPlaces(fact).map((p) => LEVEL_RANK[parsePlace(p)?.level ?? 'global']));
  const byLevel: Record<'city' | 'region' | 'country', string[]> = { city: [], region: [], country: [] };
  for (const l of locations) {
    const cc = (l.countryCode ?? '').trim().toUpperCase();
    if (!parsePlace(cc)) continue;
    const region = cleanPart(l.region);
    const city = cleanPart(l.city);
    byLevel.country.push(cc);
    if (depth >= 2 && region) byLevel.region.push(`${cc}|${region}`);
    if (depth >= 3 && city) byLevel.city.push(`${cc}|${region}|${city}`);
  }
  const options: FactPlaceOption[] = [];
  for (const level of ['city', 'region', 'country'] as const) {
    for (const place of normalizePlaces(byLevel[level])) {
      if (options.some((o) => o.place === place)) continue;
      options.push({ place, level, label: placeLabel(place) as string });
    }
  }
  options.push({ place: PLACE_GLOBAL, level: 'global', label: 'Anywhere' });
  return options;
}
