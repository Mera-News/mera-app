import { Q } from '@nozbe/watermelondb';

import database from '../index';
import ArticleSuggestionModel from '../models/ArticleSuggestion';
import { parseClusterMemberships } from './article-suggestion-service';
import {
  getSubscribedSourceNameSet,
  normalizeSubscriptionName,
} from './user-publication-subscription-service';

/**
 * Finding the articles from a user's subscribed publications that cover the
 * same story as a given suggestion.
 *
 * Sibling lookup is LOCAL. Rows already carry `stableClusterId` and
 * `clusterMembershipsJson`, so this is a query against `article_suggestions`
 * rather than a GraphQL round trip per suggestion. Both the article-detail
 * block and the post-scoring read stage use this one function, so they can
 * never disagree about what a sibling is.
 */

const suggestionsCollection = database.get<ArticleSuggestionModel>('article_suggestions');

/**
 * Epsilon for "this row's publication date is indistinguishable from its sync
 * time". `article-suggestion-service` writes `firstPubDate = parseDate(pubDate)
 * ?? now` and `createdAt = now` in the same statement, so a feed that supplies
 * no `pubDate` silently gets sync time as its publication date. Treating those
 * two timestamps as equal within a second is how we detect it.
 */
const UNKNOWN_PUB_DATE_EPSILON_MS = 1_000;

/** True when a row's publication date is really just its sync time. */
export function hasUnknownPubDate(row: {
  firstPubDate: Date;
  createdAt: Date;
}): boolean {
  return Math.abs(row.firstPubDate.getTime() - row.createdAt.getTime()) < UNKNOWN_PUB_DATE_EPSILON_MS;
}

/**
 * The freshness gate: may `sibling` be read as coverage of `anchor`?
 *
 * Publication time against publication time, never against `createdAt`.
 * `createdAt` is local SYNC time and siblings land in the same batch with the
 * same value, so a `firstPubDate > createdAt` comparison would pass almost
 * always and amount to no gate at all.
 *
 * A sibling published AFTER the anchor is skipped permanently, not deferred:
 * the decision is "never read newer coverage for this suggestion", so a later
 * rebuild must reach the same answer.
 *
 * A sibling whose publication date is unknown is skipped, which is the
 * conservative reading of the same rule.
 */
export function siblingIsReadable(
  anchor: { firstPubDate: Date; createdAt: Date },
  sibling: { firstPubDate: Date; createdAt: Date },
): boolean {
  if (hasUnknownPubDate(sibling)) return false;
  return sibling.firstPubDate.getTime() <= anchor.firstPubDate.getTime();
}

/** Every cluster id a row belongs to, stable ids included. */
export function clusterIdsForRow(row: ArticleSuggestionModel): string[] {
  const ids = new Set<string>();
  if (row.stableClusterId) ids.add(row.stableClusterId);
  for (const m of parseClusterMemberships(row.clusterMembershipsJson)) {
    if (m.clusterId) ids.add(m.clusterId);
    if (m.stableClusterId) ids.add(m.stableClusterId);
  }
  return [...ids];
}

/**
 * Rows in the same story as `anchor`, published by a subscribed source,
 * excluding the anchor itself.
 *
 * Ordered newest publication first. The block that renders these is sourced
 * locally rather than partitioned out of the server-paged related list, so it
 * inherits no ordering from `orderRelatedArticles` and has to state its own.
 * Newest first is the natural reading order for "what else has my
 * subscription said about this", and it agrees with the freshness gate, which
 * has already removed anything newer than the anchor.
 *
 * `subscribedNames` is optional so a caller looping over many anchors can
 * resolve the set once instead of per row.
 */
export async function findSubscribedSiblings(
  anchor: ArticleSuggestionModel,
  subscribedNames?: Set<string>,
): Promise<ArticleSuggestionModel[]> {
  const names = subscribedNames ?? (await getSubscribedSourceNameSet());
  if (names.size === 0) return [];

  const clusterIds = clusterIdsForRow(anchor);
  if (clusterIds.length === 0) return [];

  // Query on the indexed stable id, then filter memberships in JS. The
  // membership list is JSON, so it is not queryable; this narrows the scan to
  // the story first rather than reading the whole table.
  const candidates = await suggestionsCollection
    .query(Q.where('stable_cluster_id', Q.oneOf(clusterIds)))
    .fetch();

  const seen = new Set<string>();
  const out: ArticleSuggestionModel[] = [];
  for (const row of candidates) {
    if (row.id === anchor.id) continue;
    if (seen.has(row.id)) continue;
    if (!names.has(normalizeSubscriptionName(row.publicationName ?? ''))) continue;
    if (!siblingIsReadable(anchor, row)) continue;
    seen.add(row.id);
    out.push(row);
  }

  out.sort((a, b) => b.firstPubDate.getTime() - a.firstPubDate.getTime());
  return out;
}

/**
 * The single sibling the article-detail block renders, or null.
 *
 * One, not a list: the block answers "does my subscription cover this", and a
 * list of near-identical wire copy from the same publisher answers a question
 * nobody asked. The newest readable sibling is the one shown.
 */
export async function findPrimarySubscribedSibling(
  anchor: ArticleSuggestionModel,
  subscribedNames?: Set<string>,
): Promise<ArticleSuggestionModel | null> {
  const siblings = await findSubscribedSiblings(anchor, subscribedNames);
  return siblings[0] ?? null;
}

/** Records a read against the ANCHOR row, which is where it renders. */
export async function saveSubscriptionRead(
  anchorId: string,
  read: string,
): Promise<void> {
  const row = await suggestionsCollection.find(anchorId);
  await database.write(async () => {
    await row.update((r) => {
      r.subscriptionRead = read;
      r.subscriptionReadAt = Date.now();
    });
  });
}
