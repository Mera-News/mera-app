import { normPublicationName } from '../feed-grouping/geo-language-priority';
import logger from '../logger';
import { SourceService } from '../source-service';

/**
 * Resolving a SOURCE name back to the publisher that owns it, so a screen
 * holding nothing but a publication name can offer the publisher's own
 * subscribe page.
 *
 * WHY THIS IS NEEDED AT ALL. The reading-history screens are backed by the
 * local `publication_visits` table, not by GraphQL: a row carries
 * `publication_name` and `country_code` and nothing else. `publication_name`
 * is the SOURCE's name, and a source's name is not guaranteed equal to its
 * publisher's name (see `UserPublicationSubscription.sourceNamesJson`, which
 * exists for exactly that reason). The subscribe URI lives on the PUBLISHER.
 * So a name has to be resolved to a publisher before anything can be offered.
 *
 * WHY `searchPublishers` AND NOT A NEW SERVER FIELD. `searchPublishers`
 * already matches `publication_source.publication_name` and
 * `publication_url` and already returns `subscription_uri` on each hit, and
 * `lib/source-service.ts` already selects it. A dedicated exact-match query
 * would be tidier and cheaper, but it would need a server deploy to reach
 * anybody, and this needs none.
 */

/** A publisher resolved from a source name, with everything the flow needs. */
export interface ResolvedPublisher {
  readonly publisherId: string;
  readonly publisherName: string;
  readonly countryCode: string;
  /**
   * Explicit null, never undefined: a publisher confirmed to have no consumer
   * subscription product must read the same as one whose field was never set.
   * Mirrors `ChosenPublisher.subscriptionUri`, which this shape satisfies
   * structurally so the same flow accepts both.
   */
  readonly subscriptionUri: string | null;
}

/** Server-side floor. Mirrored so a 1-character name never fires a 400. */
const MIN_QUERY_LENGTH = 2;

/**
 * Session cache, keyed on the NORMALISED source name.
 *
 * `null` is cached as hard as a hit: "this name resolves to no publisher" is
 * an answer, and re-asking it on every remount would fire a regex collection
 * scan per visit to a screen whose answer cannot change within a session.
 * Deliberately module-level and in-memory rather than a WatermelonDB table:
 * the catalogue does change, just far more slowly than a session, and a
 * durable cache would need an invalidation story for no measured benefit.
 * Not keyed on country: see `resolvePublisherForSourceName` below, where
 * country is a tie-break and never a filter.
 */
const cache = new Map<string, ResolvedPublisher | null>();

/** Test seam. Nothing in the app calls this. */
export function __clearPublisherLookupCache(): void {
  cache.clear();
}

/**
 * The publisher that owns `publicationName`, or null.
 *
 * FAILS CLOSED, and that is the whole contract: every caller renders a
 * subscribe affordance only when this returns a publisher WITH a URI, so a
 * wrong guess here is a button that sends a reader to somebody else's
 * paywall. The search is a candidate generator only. A candidate is accepted
 * on an EXACT normalised name match, never on the fuzzy match that produced
 * it.
 *
 * Two branches, and the second is required rather than a nicety:
 *
 *  1. One of the hit's `matchingSources` is named exactly this. The ordinary
 *     case, and the only one that proves the publisher really owns this feed.
 *  2. The hit's OWN name is exactly this. `matchingSources` is deliberately
 *     the filtered subset that matched the query string, so a publisher that
 *     matched on its own `name` or `website_url` comes back with
 *     `matchingSources: []` (documented in `publisher-sources.ts`). Without
 *     this branch every publisher whose name equals its feed's name, which is
 *     most of them, would silently resolve to nothing.
 *
 * COUNTRY IS A TIE-BREAK, NEVER A FILTER. `VisitedPublication.countryCode` is
 * nullable, and a publisher's own code is not always an alpha-3 at all ("The
 * Next Web" is `'GLOBAL'`). Filtering on it would drop correct answers for
 * both reasons. It only ever chooses between two hits that ALREADY matched
 * the name exactly.
 */
export async function resolvePublisherForSourceName(
  publicationName: string,
  countryCode: string | null,
): Promise<ResolvedPublisher | null> {
  const norm = normPublicationName(publicationName);
  if (!norm || norm.length < MIN_QUERY_LENGTH) return null;

  const cached = cache.get(norm);
  if (cached !== undefined) return cached;

  let resolved: ResolvedPublisher | null = null;
  try {
    const res = await SourceService.searchPublishers({
      query: publicationName.trim(),
      first: 20,
    });

    const exact = (res.publishers ?? []).filter(
      (hit) =>
        (hit.matchingSources ?? []).some(
          (s) => normPublicationName(s.publication_name) === norm,
        ) || normPublicationName(hit.name) === norm,
    );

    // Among exact name matches only, prefer the one from the same country.
    const chosen =
      (countryCode
        ? exact.find((hit) => hit.country_code === countryCode)
        : undefined) ?? exact[0];

    if (chosen) {
      resolved = {
        publisherId: chosen._id,
        publisherName: chosen.name,
        countryCode: chosen.country_code,
        subscriptionUri: chosen.subscription_uri ?? null,
      };
    }
  } catch (error) {
    // A failed lookup is a missing affordance, never a broken screen. It is
    // deliberately NOT cached: the next mount should try again, because the
    // cause is usually connectivity rather than the catalogue.
    logger.captureException(error, {
      tags: { service: 'publisher-lookup', method: 'resolvePublisherForSourceName' },
      extra: { publicationName, countryCode },
    });
    return null;
  }

  cache.set(norm, resolved);
  return resolved;
}
