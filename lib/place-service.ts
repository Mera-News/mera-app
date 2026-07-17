import { gql } from '@apollo/client';
import client from './apollo-client';
import type { Place } from './generated/graphql-types';
import logger from './logger';

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
    }
  }
`;

/** Minimum query length the server will act on (shorter → guaranteed []). */
export const PLACE_SEARCH_MIN_CHARS = 2;

export type { Place };

/**
 * Prefix-search places for the add-location type-ahead. Returns
 * population-sorted matches, or [] for short queries / an unseeded collection /
 * any error (the add-flow falls back to manual entry on an empty result).
 */
export async function searchPlaces(query: string, limit = 8): Promise<Place[]> {
  const trimmed = query.trim();
  // Skip the round-trip for queries the server would reject anyway.
  if (trimmed.length < PLACE_SEARCH_MIN_CHARS) return [];
  try {
    const { data } = await client.query<{ placeSearch: Place[] }>({
      query: PLACE_SEARCH,
      variables: { query: trimmed, limit },
      fetchPolicy: 'no-cache',
    });
    return data?.placeSearch ?? [];
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'place-service', method: 'searchPlaces' },
      extra: { query: trimmed, limit },
    });
    return [];
  }
}
