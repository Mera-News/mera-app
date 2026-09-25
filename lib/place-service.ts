import { gql } from '@apollo/client';
import countries from 'i18n-iso-countries';
import client from './apollo-client';
import type { Place } from './generated/graphql-types';
import logger from './logger';
// Imported for its `registerLocale(en)` side effect, which the alpha-2 name
// lookup below needs. Same pattern components/custom/locations uses.
import './country-utils';
import type { Bloc, Place as HarnessPlace, LookupPlaceResult } from '@/lib/mera-harness';

// [Persona v3] Place typeahead for the locations add-flow. `placeSearch` runs an
// anchored prefix regex over the server's GeoNames-seeded `places` collection
// (population-sorted). The server returns [] for queries shorter than 2 chars,
// and the collection may be UNSEEDED in some environments — callers must degrade
// to manual entry when this returns an empty list.
//
// NOTE: `Place.countryCode` is ISO alpha-2 (GeoNames convention), matching the
// on-device `locations.countryCode` — so a picked place is stored as-is with no
// alpha-2/alpha-3 conversion.
const PLACE_SEARCH = gql`
  query PlaceSearch($query: String!, $limit: Int) {
    placeSearch(query: $query, limit: $limit) {
      _id
      city
      region
      countryCode
      displayName
      normalized
      population
      search_keys
    }
  }
`;

/** Minimum query length the server will act on (shorter → guaranteed []). */
export const PLACE_SEARCH_MIN_CHARS = 2;

export type { Place };

/**
 * Discriminated result for `searchPlaces` — lets callers tell an honest "no
 * matches" apart from "the search itself failed" (network/server error) so the
 * UI can show a distinct "search unavailable" state instead of silently
 * reading as zero results.
 */
export type SearchPlacesResult = { readonly ok: true; readonly places: Place[] } | { readonly ok: false };

/**
 * Prefix-search places for the add-location type-ahead. Returns
 * population-sorted matches on success (`ok: true`, possibly an empty list for
 * short queries / an unseeded collection), or `ok: false` on any error — the
 * add-flow distinguishes "no matches" from "search unavailable" using this and
 * still offers manual entry as a fallback either way.
 */
export async function searchPlaces(query: string, limit = 8): Promise<SearchPlacesResult> {
  const trimmed = query.trim();
  // Skip the round-trip for queries the server would reject anyway.
  if (trimmed.length < PLACE_SEARCH_MIN_CHARS) return { ok: true, places: [] };
  try {
    const { data } = await client.query<{ placeSearch: Place[] }>({
      query: PLACE_SEARCH,
      variables: { query: trimmed, limit },
      fetchPolicy: 'no-cache',
    });
    return { ok: true, places: data?.placeSearch ?? [] };
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'place-service', method: 'searchPlaces' },
      extra: { query: trimmed, limit },
    });
    return { ok: false };
  }
}


// ---------------------------------------------------------------------------
// lookupPlace — the persona agent's place chain
// ---------------------------------------------------------------------------

/**
 * countryCode -> bloc. Four named blocs, then a continent rung so a non-EU
 * user is never bucketless. `null` only for a code ISO does not know, which is
 * asserted exhaustively in the tests against `countries.getAlpha2Codes()` —
 * a superset of anything `placeSearch` can return, since the `places`
 * collection is GeoNames-seeded and GeoNames uses ISO alpha-2.
 *
 * This is DATA, not logic: large, static, and mechanically checked against a
 * list this repo does not maintain. `i18n-iso-countries` carries no continent
 * information, which is why the continent half is hand-owned.
 */
const EU27 = [
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT',
  'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
];

/**
 * Non-EU Europe.
 *
 * The transcontinental cases are decisions, not defaults, because each one
 * reaches the agent's prompt as fact: RU is Europe here, while TR, AM, GE, AZ
 * and KZ sit in ASIA below. CY is transcontinental too but resolves to 'EU'
 * on membership, which outranks any continent call.
 */
const EUROPE_OTHER = [
  'AL','AD','BY','BA','FO','GI','GG','IS','IM','JE','XK','LI','MK',
  'MD','MC','ME','NO','RU','SM','RS','SJ','CH','UA','VA','AX',
];
const ASIA = [
  'AM','GE','TR',
  'AF','AZ','BH','BD','BT','IO','BN','KH','CN','CX','CC','HK','IN','ID','IR',
  'IQ','IL','JP','JO','KZ','KP','KR','KW','KG','LA','LB','MO','MY','MV','MN',
  'MM','NP','OM','PK','PS','PH','QA','SA','SG','LK','SY','TW','TJ','TH','TL',
  'TM','AE','UZ','VN','YE',
];
const AFRICA = [
  'DZ','AO','BJ','BW','BF','BI','CM','CV','CF','TD','KM','CG','CD','CI','DJ',
  'EG','GQ','ER','SZ','ET','GA','GM','GH','GN','GW','KE','LS','LR','LY','MG',
  'MW','ML','MR','MU','YT','MA','MZ','NA','NE','NG','RE','RW','SH','ST','SN',
  'SC','SL','SO','ZA','SS','SD','TZ','TG','TN','UG','EH','ZM','ZW',
];
const NORTH_AMERICA = [
  'AI','AG','AW','BS','BB','BZ','BM','BQ','VG','CA','KY','CR','CU','CW','DM',
  'DO','SV','GL','GD','GP','GT','HT','HN','JM','MQ','MX','MS','NI','PA','PR',
  'BL','KN','LC','MF','PM','VC','SX','TT','TC','US','VI',
];
const SOUTH_AMERICA = [
  'AR','BO','BR','CL','CO','EC','FK','GF','GY','PY','PE','SR','UY','VE',
];
const OCEANIA = [
  'AS','AU','CK','FJ','PF','GU','KI','MH','FM','NR','NC','NZ','NU','NF','MP',
  'PW','PG','PN','WS','SB','TK','TO','TV','UM','VU','WF',
];
/** Antarctic territories. Known ISO codes with no continent among the six, so
 *  they get their own value rather than falling through to null. */
const ANTARCTICA = ['AQ','BV','GS','HM','TF'];

function buildBlocMap(): Readonly<Record<string, Bloc>> {
  const map: Record<string, Bloc> = {};
  const put = (codes: string[], bloc: Bloc) => {
    for (const c of codes) map[c] = bloc;
  };
  // Continents first, then the named blocs, which must WIN for their members:
  // DE is 'EU', not 'Europe'.
  put(EUROPE_OTHER, 'Europe');
  put(ASIA, 'Asia');
  put(AFRICA, 'Africa');
  put(NORTH_AMERICA, 'North America');
  put(SOUTH_AMERICA, 'South America');
  put(OCEANIA, 'Oceania');
  put(ANTARCTICA, 'Antarctica');
  put(EU27, 'EU');
  put(['IS', 'LI', 'NO'], 'EEA');
  put(['CH'], 'EFTA');
  put(['GB'], 'UK');
  return map;
}

const BLOC_BY_ALPHA2 = buildBlocMap();

/** The bloc for an ISO alpha-2 code, or null when ISO does not know the code. */
export function blocFor(alpha2: string): Bloc | null {
  return BLOC_BY_ALPHA2[(alpha2 ?? '').trim().toUpperCase()] ?? null;
}

/**
 * Country name from an ALPHA-2 code.
 *
 * Not `country-utils.getCountryName`, which takes ALPHA-3 and returns the code
 * back as its own fallback — so passing an alpha-2 there yields "NL" for the
 * Netherlands and looks like a working lookup.
 */
function countryNameFor(alpha2: string): string {
  const a2 = (alpha2 ?? '').trim().toUpperCase();
  return countries.getName(a2, 'en', { select: 'alias' }) || a2;
}

function toCandidate(row: Place): HarnessPlace {
  return {
    // Never set here: the server carries no neighbourhood data, so populating
    // it would mean inventing one. The agent fills it from the user's words.
    locality: row.city,
    admin1: row.region ?? null,
    countryCode: row.countryCode,
    countryName: countryNameFor(row.countryCode),
    bloc: blocFor(row.countryCode),
  };
}

/** How many candidates the agent is offered to disambiguate between. */
export const PLACE_CANDIDATE_LIMIT = 3;

/**
 * Resolve free text to up to three ranked place candidates.
 *
 * Returns CANDIDATES, not a choice: picking one would silently make a
 * "Springfield" disambiguation decision that belongs to the user. Order is the
 * server's population ranking, never re-sorted — it is the only ranking signal
 * available and a client-side heuristic would degrade it.
 *
 * `no_match` and `unavailable` are never collapsed: "there is no such place"
 * and "we could not reach the server" need different words in front of a user,
 * and only one of them is worth retrying.
 */
export async function lookupPlace(
  query: string,
  countryHint?: string,
): Promise<LookupPlaceResult> {
  const trimmed = query.trim();
  // Checked HERE, before the call: searchPlaces reports a sub-minimum query as
  // an empty SUCCESS, which is indistinguishable from a real zero-result.
  if (trimmed.length < PLACE_SEARCH_MIN_CHARS) {
    return { status: 'too_short', minChars: PLACE_SEARCH_MIN_CHARS as 2 };
  }

  const result = await searchPlaces(trimmed);
  if (!result.ok) return { status: 'unavailable' };

  const hint = countryHint?.trim().toUpperCase();
  // A hint FILTERS; it never picks a winner. A hint that matches nothing is
  // no_match, never a fall-through to another country.
  const rows = hint
    ? result.places.filter((p) => p.countryCode?.toUpperCase() === hint)
    : result.places;

  if (rows.length === 0) return { status: 'no_match', query: trimmed };

  return {
    status: 'resolved',
    places: rows.slice(0, PLACE_CANDIDATE_LIMIT).map(toCandidate),
  };
}
