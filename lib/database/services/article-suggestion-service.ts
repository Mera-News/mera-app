// Article Suggestion Service — hydrates the ForYou feed from local cache.
// The local cache holds a single parent (article_suggestions) and a single
// child (article_suggestion_facts) — related siblings are fetched fresh from
// the server when the detail screen opens (relatedArticles).

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import { ArticleSuggestionStatus } from '../article-suggestion-status';
import type ArticleSuggestionModel from '../models/ArticleSuggestion';
import type ArticleSuggestionFactModel from '../models/ArticleSuggestionFact';
import type FactModel from '../models/Fact';
import type { ArticleWithClusters } from '../../generated/graphql-types';
import type { ForYouSuggestion, ClusterMembership } from '../../stores/for-you-store';
import { getSetting, setSetting, deleteSetting } from './setting-service';
import { getFacts } from './fact-service';
import logger from '../../logger';

const articleSuggestionsCol = database.get<ArticleSuggestionModel>('article_suggestions');
const articleSuggestionFactsCol = database.get<ArticleSuggestionFactModel>('article_suggestion_facts');
const factsCol = database.get<FactModel>('facts');

// --- Read: server ids only ---

/**
 * Returns the ids of every article_suggestion row on-device. Since the WMDB
 * row id equals the server `_id`, these ids are directly diffable against
 * the server's id set.
 */
export async function getLocalSuggestionServerIds(): Promise<string[]> {
  const rows = await articleSuggestionsCol.query().fetch();
  return rows.map((r) => r.id);
}

// --- Read: full feed ---

export async function loadSuggestions(): Promise<ForYouSuggestion[]> {
  const rows = await articleSuggestionsCol.query().fetch();
  if (rows.length === 0) return [];
  return rows.map(toForYouSuggestion);
}

// --- Read: unscored with linked facts (scoring input) ---

export interface ScoringCandidate {
  id: string; // WMDB row id == server `_id` of ArticleSuggestion
  titleEn: string | null;
  descriptionEn: string | null;
  countryCode: string | null;
  userTopicIds: string[];
  relatedFacts: { id: string; statement: string }[];
  /** Already-persisted relevance. Populated only by the reason-retry query
   *  (where the row was scored previously but the reason came back empty);
   *  omitted for the unscored-candidates query. */
  relevance?: number;
}

export async function getUnscoredSuggestionsWithFacts(
  limit?: number,
): Promise<ScoringCandidate[]> {
  const rows = await (limit !== undefined
    ? articleSuggestionsCol
        .query(Q.where('status', ArticleSuggestionStatus.Unscored), Q.take(limit))
        .fetch()
    : articleSuggestionsCol
        .query(Q.where('status', ArticleSuggestionStatus.Unscored))
        .fetch());
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const links = await articleSuggestionFactsCol
    .query(Q.where('article_suggestion_id', Q.oneOf(ids)))
    .fetch();

  const factIds = [...new Set(links.map((l) => l.factId))];
  const facts = factIds.length
    ? await factsCol.query(Q.where('id', Q.oneOf(factIds))).fetch()
    : [];
  const factById = new Map(facts.map((f) => [f.id, f]));

  const factsBySuggestionId = new Map<string, { id: string; statement: string }[]>();
  for (const link of links) {
    const fact = factById.get(link.factId);
    if (!fact) continue;
    const bucket = factsBySuggestionId.get(link.articleSuggestionId) ?? [];
    bucket.push({ id: fact.id, statement: fact.statement });
    factsBySuggestionId.set(link.articleSuggestionId, bucket);
  }

  return rows.map((row) => ({
    id: row.id,
    titleEn: row.titleEn,
    descriptionEn: row.descriptionEn,
    countryCode: row.countryCode,
    userTopicIds: parseTopicIds(row.matchedTopicTextsJson),
    relatedFacts: factsBySuggestionId.get(row.id) ?? [],
  }));
}

export async function countUnscoredSuggestions(): Promise<number> {
  return articleSuggestionsCol
    .query(Q.where('status', ArticleSuggestionStatus.Unscored))
    .fetchCount();
}

// --- Read: scored rows with empty reason (reason-retry input) ---

export async function getScoredSuggestionsWithoutReasons(
  limit?: number,
): Promise<ScoringCandidate[]> {
  // Re-attempt rows that are scored but still awaiting a reason. A failed reason
  // attempt leaves the row in reason_pending, so this query re-fetches it.
  const rows = await (limit !== undefined
    ? articleSuggestionsCol
        .query(Q.where('status', ArticleSuggestionStatus.ReasonPending), Q.take(limit))
        .fetch()
    : articleSuggestionsCol
        .query(Q.where('status', ArticleSuggestionStatus.ReasonPending))
        .fetch());
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const links = await articleSuggestionFactsCol
    .query(Q.where('article_suggestion_id', Q.oneOf(ids)))
    .fetch();

  const factIds = [...new Set(links.map((l) => l.factId))];
  const facts = factIds.length
    ? await factsCol.query(Q.where('id', Q.oneOf(factIds))).fetch()
    : [];
  const factById = new Map(facts.map((f) => [f.id, f]));

  const factsBySuggestionId = new Map<string, { id: string; statement: string }[]>();
  for (const link of links) {
    const fact = factById.get(link.factId);
    if (!fact) continue;
    const bucket = factsBySuggestionId.get(link.articleSuggestionId) ?? [];
    bucket.push({ id: fact.id, statement: fact.statement });
    factsBySuggestionId.set(link.articleSuggestionId, bucket);
  }

  return rows.map((row) => ({
    id: row.id,
    titleEn: row.titleEn,
    descriptionEn: row.descriptionEn,
    countryCode: row.countryCode,
    userTopicIds: parseTopicIds(row.matchedTopicTextsJson),
    relatedFacts: factsBySuggestionId.get(row.id) ?? [],
    relevance: row.relevance,
  }));
}

// --- Write: delete by server ids (cascades to fact links) ---

export async function deleteSuggestionsByServerIds(
  serverIds: string[],
): Promise<number> {
  if (serverIds.length === 0) return 0;

  // Row id == server id, so query the primary-key column directly.
  const suggestions = await articleSuggestionsCol
    .query(Q.where('id', Q.oneOf(serverIds)))
    .fetch();
  if (suggestions.length === 0) return 0;

  const ids = suggestions.map((s) => s.id);
  const links = await articleSuggestionFactsCol
    .query(Q.where('article_suggestion_id', Q.oneOf(ids)))
    .fetch();

  await database.write(async () => {
    await database.batch([
      ...links.map((l) => l.prepareDestroyPermanently()),
      ...suggestions.map((s) => s.prepareDestroyPermanently()),
    ]);
  });

  return suggestions.length;
}

export async function deleteSuggestionByServerId(
  serverId: string,
): Promise<boolean> {
  return (await deleteSuggestionsByServerIds([serverId])) > 0;
}

export async function deleteOldSuggestions(cutoffMs: number): Promise<number> {
  const suggestions = await articleSuggestionsCol
    .query(Q.where('created_at', Q.lt(cutoffMs)))
    .fetch();
  if (suggestions.length === 0) return 0;

  const ids = suggestions.map((s) => s.id);
  const links = await articleSuggestionFactsCol
    .query(Q.where('article_suggestion_id', Q.oneOf(ids)))
    .fetch();

  await database.write(async () => {
    await database.batch([
      ...links.map((l) => l.prepareDestroyPermanently()),
      ...suggestions.map((s) => s.prepareDestroyPermanently()),
    ]);
  });

  return suggestions.length;
}

// --- Write: score ---

/**
 * Persists the result of a scoring pass. Callers only invoke this when the
 * relevance step succeeded, so the row leaves `unscored`. The resulting `status`
 * captures where the reason step landed:
 *   - reason non-empty               → complete (reason shown)
 *   - reasonSkipped (sub-threshold)  → complete (terminal, no reason → fact chips)
 *   - otherwise                      → reason_pending (loading; retried next sweep)
 */
export async function saveScoringResult(
  localSuggestionId: string,
  params: { relevance: number; reason: string; reasonSkipped: boolean },
): Promise<void> {
  const { relevance, reason, reasonSkipped } = params;
  const row = await articleSuggestionsCol.find(localSuggestionId);
  await database.write(async () => {
    await row.update((r) => {
      r.relevance = relevance;
      r.reason = reason;
      r.status =
        reason.length > 0 || reasonSkipped
          ? ArticleSuggestionStatus.Complete
          : ArticleSuggestionStatus.ReasonPending;
    });
  });
}

/**
 * Mark multiple articles as ineligible for scoring in a single batched write.
 * All rows get relevance=0 and a terminal `complete` status (no reason). Use
 * instead of calling saveScoringResult in a loop — one database.write instead of N.
 */
export async function batchMarkAsScoredByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await Promise.all(ids.map((id) => articleSuggestionsCol.find(id)));
  await database.write(async () => {
    await database.batch(
      rows.map((row) =>
        row.prepareUpdate((r) => {
          r.relevance = 0;
          r.reason = '';
          r.status = ArticleSuggestionStatus.Complete;
        }),
      ),
    );
  });
}

/**
 * Mark already-scored rows as reason-skipped (no eligible facts/title) in one
 * batched write. Keeps existing relevance; reason stays '' and status becomes
 * terminal `complete`.
 */
export async function batchMarkReasonSkipped(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await Promise.all(ids.map((id) => articleSuggestionsCol.find(id)));
  await database.write(async () => {
    await database.batch(
      rows.map((row) =>
        row.prepareUpdate((r) => {
          r.status = ArticleSuggestionStatus.Complete;
        }),
      ),
    );
  });
}

/**
 * Updates the reason for an already-scored row. A non-empty reason transitions
 * the row to `complete`; an empty reason leaves it `reason_pending` for the
 * next sweep.
 */
export async function saveReason(
  localSuggestionId: string,
  reason: string,
): Promise<void> {
  const row = await articleSuggestionsCol.find(localSuggestionId);
  await database.write(async () => {
    await row.update((r) => {
      r.reason = reason;
      r.status =
        reason.length > 0
          ? ArticleSuggestionStatus.Complete
          : ArticleSuggestionStatus.ReasonPending;
    });
  });
}

/**
 * Find a suggestion by server id (returns null if not present).
 */
export async function getSuggestionByServerId(serverId: string): Promise<ForYouSuggestion | null> {
  try {
    const row = await articleSuggestionsCol.find(serverId);
    return toForYouSuggestion(row);
  } catch {
    return null;
  }
}

// --- Clear / TTL ---

export async function clearSuggestions(): Promise<void> {
  const [suggestions, links] = await Promise.all([
    articleSuggestionsCol.query().fetch(),
    articleSuggestionFactsCol.query().fetch(),
  ]);

  if (suggestions.length === 0 && links.length === 0) {
    await deleteSetting(FEED_META_KEY);
    return;
  }

  await database.write(async () => {
    await database.batch([
      ...links.map((l) => l.prepareDestroyPermanently()),
      ...suggestions.map((s) => s.prepareDestroyPermanently()),
    ]);
  });

  await deleteSetting(FEED_META_KEY);
}

/**
 * Deletes suggestions whose matched topic texts are entirely absent from
 * current active facts. Suggestions that still overlap with at least one
 * active topic are preserved (along with their relevance scores).
 * Returns the number of deleted suggestion rows, or -1 if a full clear
 * was performed because no active topics exist.
 */
export async function pruneOrphanedSuggestions(): Promise<number> {
  const facts = await getFacts();
  const activeTopics = new Set<string>();
  for (const fact of facts) {
    for (const topic of fact.metadata?.topics ?? []) {
      if (topic.length > 0) activeTopics.add(topic);
    }
  }

  if (activeTopics.size === 0) {
    await clearSuggestions();
    return -1;
  }

  const allSuggestions = await articleSuggestionsCol.query().fetch();
  const toDelete = allSuggestions.filter((s) => {
    const matched = parseTopicIds(s.matchedTopicTextsJson);
    return matched.length > 0 && matched.every((t) => !activeTopics.has(t));
  });

  if (toDelete.length === 0) return 0;

  const toDeleteIds = new Set(toDelete.map((s) => s.id));
  const allLinks = await articleSuggestionFactsCol.query().fetch();
  const linksToDelete = allLinks.filter((l) => toDeleteIds.has(l.articleSuggestionId));

  await database.write(async () => {
    await database.batch([
      ...linksToDelete.map((l) => l.prepareDestroyPermanently()),
      ...toDelete.map((s) => s.prepareDestroyPermanently()),
    ]);
  });

  return toDelete.length;
}

// --- Feed metadata (cold-start counters) ---

const FEED_META_KEY = 'feed_metadata';

export interface FeedMetadata {
  articleCount: number;
  relevantArticleCount: number;
  hasGeneratedTopics: boolean;
  lastProcessingRunFinishedAt?: number | null;
}

export async function persistFeedMetadata(meta: FeedMetadata): Promise<void> {
  await setSetting(FEED_META_KEY, JSON.stringify(meta));
}

export async function loadFeedMetadata(): Promise<FeedMetadata | null> {
  const raw = await getSetting(FEED_META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FeedMetadata;
  } catch {
    return null;
  }
}

// --- Internal helpers ---

function toForYouSuggestion(row: ArticleSuggestionModel): ForYouSuggestion {
  return {
    _id: row.id,
    articleId: row.articleId,
    clusters: parseClusterMemberships(row.clusterMembershipsJson),
    relevance: row.relevance,
    reason: row.reason,
    status: row.status,
    country_code: row.countryCode,
    language_code: row.languageCode,
    publication_name: row.publicationName,
    title_en: row.titleEn,
    title_original: row.titleOriginal,
    description_en: row.descriptionEn,
    article_url: row.articleUrl,
    image_url: row.imageUrl,
    userTopicIds: parseTopicIds(row.matchedTopicTextsJson),
    createdAt: row.createdAt.toISOString(),
    firstPubDate: row.firstPubDate.toISOString(),
  };
}

/** Strip GraphQL `__typename` from the hydrated `clusters` field down to the
 *  plain `{ clusterId, confidence }` shape we persist and feed the UI. */
function toClusterMemberships(
  clusters: ArticleWithClusters['clusters'] | null | undefined,
): ClusterMembership[] {
  if (!clusters) return [];
  return clusters.map((c) => ({ clusterId: c.clusterId, confidence: c.confidence }));
}

function parseClusterMemberships(
  json: string | null | undefined,
): ClusterMembership[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ClusterMembership =>
        m != null &&
        typeof m.clusterId === 'string' &&
        m.clusterId.length > 0 &&
        typeof m.confidence === 'number',
    );
  } catch {
    return [];
  }
}

/** Sorted JSON encoding (by clusterId) so equality checks are stable
 *  regardless of the order the server returned the memberships in. */
function canonicalClusterMembershipsJson(
  memberships: ClusterMembership[],
): string {
  const normalized = memberships
    .map((m) => ({ clusterId: m.clusterId, confidence: m.confidence }))
    .sort((a, b) => (a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0));
  return JSON.stringify(normalized);
}

function parseTopicIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

/** Returns a count of cached article_suggestions per topic text. */
export async function getArticleCountByTopicTexts(): Promise<Map<string, number>> {
  const rows = await articleSuggestionsCol.query().fetch();
  const counts = new Map<string, number>();
  for (const row of rows) {
    const topics = parseTopicIds(row.matchedTopicTextsJson);
    for (const topic of topics) {
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
  }
  return counts;
}

export async function getArticleSuggestionsByTopicTexts(
  topicTexts: string[],
): Promise<ArticleSuggestionModel[]> {
  if (topicTexts.length === 0) return [];
  const topicSet = new Set(topicTexts);
  const rows = await articleSuggestionsCol
    .query(Q.sortBy('first_pub_date', Q.desc))
    .fetch();
  return rows.filter(row => {
    const topics = parseTopicIds(row.matchedTopicTextsJson);
    return topics.some(t => topicSet.has(t));
  });
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const t = new Date(value).getTime();
    return isNaN(t) ? null : new Date(t);
  }
  return null;
}

// --- Flow v2: persist ArticleWithClusters rows (keyed by articleId) ---

/**
 * [Flow v2] Persist articles returned by the stateless `articlesForTopicsByIds`
 * query. WMDB row id == articleId (no server-side suggestion document). Facts
 * are linked via fact metadata topic texts using the topic texts that matched
 * each article (supplied by the caller from the `articleIdsForTopics` response).
 */
export async function persistAndLinkV2Suggestions(
  fetched: ArticleWithClusters[],
  articleToTopicTexts: Map<string, string[]>,
): Promise<{ insertedCount: number; linkedCount: number }> {
  if (fetched.length === 0) return { insertedCount: 0, linkedCount: 0 };

  const existingRows = await articleSuggestionsCol
    .query(Q.where('id', Q.oneOf(fetched.map((a) => a._id))))
    .fetch();
  const existingById = new Map(existingRows.map((r) => [r.id, r]));
  const toInsert = fetched.filter((a) => !existingById.has(a._id));

  const clusterRefreshes: { row: ArticleSuggestionModel; nextJson: string }[] = [];
  for (const a of fetched) {
    const row = existingById.get(a._id);
    if (!row) continue;
    const nextJson = canonicalClusterMembershipsJson(toClusterMemberships(a.clusters));
    const currentJson = canonicalClusterMembershipsJson(
      parseClusterMemberships(row.clusterMembershipsJson),
    );
    if (currentJson !== nextJson) clusterRefreshes.push({ row, nextJson });
  }

  if (toInsert.length === 0 && clusterRefreshes.length === 0) {
    return { insertedCount: 0, linkedCount: 0 };
  }

  const allTopicTexts = Array.from(
    new Set(toInsert.flatMap((a) => articleToTopicTexts.get(a._id) ?? [])),
  );
  const factsByTopicText = await resolveFactsByTopicTexts(allTopicTexts);

  let insertedCount = 0;
  let linkedCount = 0;

  await database.write(async () => {
    const ops: any[] = [];
    const now = new Date();

    for (const { row, nextJson } of clusterRefreshes) {
      ops.push(row.prepareUpdate((r) => { r.clusterMembershipsJson = nextJson; }));
    }

    for (const a of toInsert) {
      const topicTexts = articleToTopicTexts.get(a._id) ?? [];
      const prepared = articleSuggestionsCol.prepareCreate((r) => {
        r._raw.id = a._id;
        r.articleId = a._id;
        r.clusterMembershipsJson = canonicalClusterMembershipsJson(
          toClusterMemberships(a.clusters),
        );
        r.relevance = 0;
        r.reason = '';
        r.status = ArticleSuggestionStatus.Unscored;
        r.countryCode = a.country_code ?? null;
        r.languageCode = a.language_code ?? null;
        r.publicationName = a.publication_name ?? null;
        if (a.title_en && a.title_en === a.title && a.language_code && a.language_code !== 'en') {
          logger.warn('[ArticleSuggestionService] title_en matches original-language title', {
            articleId: a._id,
            languageCode: a.language_code,
          });
        }
        r.titleEn = a.title_en ?? null;
        r.titleOriginal = a.title ?? null;
        r.descriptionEn = a.description_en ?? null;
        r.articleUrl = a.article_url ?? null;
        r.imageUrl = a.image_url ?? null;
        r.matchedTopicTextsJson = JSON.stringify(topicTexts);
        r.createdAt = now;
        r.firstPubDate = parseDate(a.pubDate) ?? now;
      });
      ops.push(prepared);
      insertedCount++;

      const linkedFactIds = new Set<string>();
      for (const topicText of topicTexts) {
        for (const factId of factsByTopicText.get(topicText) ?? []) {
          linkedFactIds.add(factId);
        }
      }
      for (const factId of linkedFactIds) {
        ops.push(
          articleSuggestionFactsCol.prepareCreate((r) => {
            r.articleSuggestionId = prepared.id;
            r.factId = factId;
            r.createdAt = now;
          }),
        );
        linkedCount++;
      }
    }

    if (ops.length > 0) await database.batch(ops);
  });

  return { insertedCount, linkedCount };
}

async function resolveFactsByTopicTexts(
  topicTexts: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (topicTexts.length === 0) return result;

  const topicSet = new Set(topicTexts);
  const facts = await getFacts();
  for (const fact of facts) {
    for (const topic of fact.metadata?.topics ?? []) {
      if (topicSet.has(topic)) {
        const bucket = result.get(topic) ?? [];
        bucket.push(fact.id);
        result.set(topic, bucket);
      }
    }
  }
  return result;
}

export async function getTotalArticleSuggestionCount(): Promise<number> {
  return articleSuggestionsCol.query().fetchCount();
}

