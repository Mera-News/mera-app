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

/**
 * Every STABLE cluster id a row belongs to.
 *
 * Stable ids only, and deliberately not the raw `clusterId`s. Those live in a
 * different namespace: they are per-run HDBSCAN labels, they are not what
 * `stable_cluster_id` holds, and feeding them to a query against that column
 * matches nothing while looking like it widens the search.
 */
export function clusterIdsForRow(row: ArticleSuggestionModel): string[] {
  const ids = new Set<string>();
  if (row.stableClusterId) ids.add(row.stableClusterId);
  for (const m of parseClusterMemberships(row.clusterMembershipsJson)) {
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

  // Matched on the INDEXED `stable_cluster_id` alone. `cluster_memberships_json`
  // is JSON and therefore not queryable, and the alternative — scanning every
  // row and parsing each blob on every article-detail mount — is not worth it
  // for a block whose miss is a defined state.
  //
  // The accepted cost, stated rather than hidden: a sibling whose
  // `stable_cluster_id` is NULL is not found even when its membership list
  // overlaps the anchor's. That row simply does not produce a block, which is
  // exactly the "no subscribed sibling" state the UI already renders. It is a
  // missed opportunity, never a wrong answer.
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

/** What the article-detail block renders. */
export interface SubscribedCoverage {
  readonly siblingId: string;
  readonly publicationName: string | null;
  readonly titleEn: string | null;
  readonly articleUrl: string | null;
  readonly imageUrl: string | null;
  readonly firstPubDate: Date;
  /**
   * The AI read, or null when none has been written yet.
   *
   * NULL is a resting state, not a pending one. The block shows the card with
   * no read line: there is no spinner and no "analysing", because a read may
   * never arrive for this row and a permanent spinner is a lie.
   */
  readonly read: string | null;
}

/**
 * Resolves the subscribed-coverage block for an article detail screen.
 *
 * Returns null when there is nothing to show, which is the common case and is
 * exactly what makes the block absent rather than empty.
 */
export async function getSubscribedCoverageForArticle(
  articleId: string,
): Promise<SubscribedCoverage | null> {
  if (!articleId) return null;
  try {
    // The row id IS the server _id, and `article_id` is the other identifier
    // the detail screen may hold, so try both rather than assuming which one
    // the caller was given.
    let anchor: ArticleSuggestionModel | null = null;
    try {
      anchor = await suggestionsCollection.find(articleId);
    } catch {
      const byArticle = await suggestionsCollection
        .query(Q.where('article_id', articleId))
        .fetch();
      anchor = byArticle.find((r) => r.articleId === articleId) ?? null;
    }
    if (!anchor) return null;

    const sibling = await findPrimarySubscribedSibling(anchor);
    if (!sibling) return null;

    return {
      siblingId: sibling.id,
      publicationName: sibling.publicationName,
      titleEn: sibling.titleEn,
      articleUrl: sibling.articleUrl,
      imageUrl: sibling.imageUrl,
      firstPubDate: sibling.firstPubDate,
      read: anchor.subscriptionRead ?? null,
    };
  } catch {
    // A render-path read. Degrading to "no block" is always safe; throwing
    // here would take down the whole article detail screen.
    return null;
  }
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
