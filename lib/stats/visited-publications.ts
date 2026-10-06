// visited-publications — pure helpers over the `publication_visits` reads that
// back the Library's Visited page and the publication page's History sub-tab.
//
// RN-free and DB-free (type imports only), so both screens and their tests can
// use them without building the WatermelonDB adapter.
//
// Like the rest of `lib/stats/`, this adds no table, column or counter. It
// regroups rows the app already keeps to run Visited.

import { normPublicationName } from '@/lib/feed-grouping/geo-language-priority';
import type {
  VisitedArticle,
  VisitedPublication,
} from '@/lib/database/services/publication-visit-service';

/**
 * `getTopVisitedPublications` groups by the EXACT name plus country, so one
 * publication can arrive as several rows ("Der Spiegel" / "DER SPIEGEL", or
 * the same outlet filed under two countries). That split the Visited top card:
 * the real leader could rank second behind its own other half.
 *
 * Rows merge on the normalised name (case and spacing ignored, country
 * ignored). Counts add, which is exact: `recordPublicationVisit` keys a row on
 * its article id within one name and country, so the halves never share an
 * article. The merged row keeps the name and country of its biggest part (ties
 * to the most recent), which is the pair the publication page and the
 * publisher lookup then receive.
 *
 * Sorted the way the service sorts: count, then most recent visit.
 */
export function mergeVisitedByName(rows: readonly VisitedPublication[]): VisitedPublication[] {
  const groups = new Map<string, { merged: VisitedPublication; lead: VisitedPublication }>();
  for (const row of rows) {
    const key = normPublicationName(row.publicationName);
    if (!key) continue;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { merged: { ...row }, lead: row });
      continue;
    }
    existing.merged.visitCount += row.visitCount;
    existing.merged.lastVisitedAt = Math.max(existing.merged.lastVisitedAt, row.lastVisitedAt);
    const lead = existing.lead;
    if (
      row.visitCount > lead.visitCount ||
      (row.visitCount === lead.visitCount && row.lastVisitedAt > lead.lastVisitedAt)
    ) {
      existing.lead = row;
    }
  }

  return [...groups.values()]
    .map(({ merged, lead }) => ({
      ...merged,
      publicationName: lead.publicationName,
      countryCode: lead.countryCode,
    }))
    .sort((a, b) =>
      b.visitCount !== a.visitCount ? b.visitCount - a.visitCount : b.lastVisitedAt - a.lastVisitedAt,
    );
}

/**
 * Whether the first row may be called "more than any other": strictly more
 * visits than the second. A tie would make the line false, so a tie gets no
 * top card. One publication alone qualifies.
 */
export function hasClearLeader(rows: readonly VisitedPublication[]): boolean {
  if (rows.length === 0) return false;
  return rows.length === 1 || rows[0].visitCount > rows[1].visitCount;
}

/**
 * The visits that belong to one publication page, matched on every name the
 * page knows it by (its raw name, the profile's name and source names),
 * normalised and in any country, the same rule the Visited merge uses. So a
 * page opened by publisher id shows the same history as one opened by name.
 * Keeps the input order (the service returns newest first).
 */
export function visitsForNames(
  visits: readonly VisitedArticle[],
  names: readonly (string | null | undefined)[],
): VisitedArticle[] {
  const wanted = new Set(
    names.map((n) => normPublicationName(n)).filter((n): n is string => n !== null),
  );
  if (wanted.size === 0) return [];
  return visits.filter((v) => {
    const key = normPublicationName(v.publicationName);
    return key !== null && wanted.has(key);
  });
}

/** The two columns of a subscription row this needs; satisfied structurally
 *  by the WatermelonDB model, so no DB import reaches this file. */
export interface SubscriptionNames {
  readonly publisherName: string;
  readonly sourceNamesJson: string | null;
}

/**
 * Every name the reader's active subscriptions cover, normalised: each
 * publisher's own name plus the source names stored with it. Visited marks a
 * row "You pay" from this set alone, so it works offline and before the
 * publisher lookup answers, and flips the moment "I already pay" writes a row.
 *
 * The normalisation is `normPublicationName`, character for character the
 * same rule as `normalizeSubscriptionName`, which wrote `sourceNamesJson`.
 * A malformed blob covers nothing rather than throwing on the render path.
 */
export function subscribedNameSet(items: readonly SubscriptionNames[]): Set<string> {
  const set = new Set<string>();
  const add = (name: unknown) => {
    const key = typeof name === 'string' ? normPublicationName(name) : null;
    if (key) set.add(key);
  };
  for (const item of items) {
    add(item.publisherName);
    try {
      const parsed: unknown = item.sourceNamesJson ? JSON.parse(item.sourceNamesJson) : [];
      if (Array.isArray(parsed)) parsed.forEach(add);
    } catch {
      // A truncated blob matches nothing; the publisher name above still does.
    }
  }
  return set;
}
