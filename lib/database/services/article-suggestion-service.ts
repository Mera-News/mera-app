// Article Suggestion Service — hydrates the ForYou feed from local cache.
// The local cache holds a single parent (article_suggestions) and a single
// child (article_suggestion_facts) — related siblings are fetched fresh from
// the server when the detail screen opens (relatedArticles).

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type ArticleSuggestionModel from '../models/ArticleSuggestion';
import type ArticleSuggestionFactModel from '../models/ArticleSuggestionFact';
import type FactModel from '../models/Fact';
import type FactTopicLinkModel from '../models/FactTopicLink';
import type SyncedSuggestionIdModel from '../models/SyncedSuggestionId';
import type { ArticleSuggestionWithMetadata, ArticleWithClusters } from '../../generated/graphql-types';
import type { ForYouSuggestion } from '../../stores/for-you-store';
import { getSetting, setSetting, deleteSetting } from './setting-service';
import { getNoisyTopicIds } from './noisy-user-topic-service';

const articleSuggestionsCol = database.get<ArticleSuggestionModel>('article_suggestions');
const articleSuggestionFactsCol = database.get<ArticleSuggestionFactModel>('article_suggestion_facts');
const factsCol = database.get<FactModel>('facts');
const factTopicLinksCol = database.get<FactTopicLinkModel>('fact_topic_links');
const syncedSuggestionIdsCol = database.get<SyncedSuggestionIdModel>('synced_suggestion_ids');

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
        .query(Q.where('relevance_generation_completed', false), Q.take(limit))
        .fetch()
    : articleSuggestionsCol
        .query(Q.where('relevance_generation_completed', false))
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
    userTopicIds: parseTopicIds(row.userTopicIdsJson),
    relatedFacts: factsBySuggestionId.get(row.id) ?? [],
  }));
}

export async function countUnscoredSuggestions(): Promise<number> {
  return articleSuggestionsCol.query(Q.where('relevance_generation_completed', false)).fetchCount();
}

// --- Read: scored rows with empty reason (reason-retry input) ---

export async function getScoredSuggestionsWithoutReasons(
  limit?: number,
): Promise<ScoringCandidate[]> {
  const rows = await (limit !== undefined
    ? articleSuggestionsCol
        .query(
          Q.where('relevance_generation_completed', true),
          Q.where('reason_generation_completed', false),
          Q.take(limit),
        )
        .fetch()
    : articleSuggestionsCol
        .query(
          Q.where('relevance_generation_completed', true),
          Q.where('reason_generation_completed', false),
        )
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
    userTopicIds: parseTopicIds(row.userTopicIdsJson),
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

// --- Write: insert new + link facts in one atomic write ---

export async function persistAndLinkNewSuggestions(
  fetched: ArticleSuggestionWithMetadata[],
): Promise<{ insertedCount: number; linkedCount: number; noisyDiscardedCount: number }> {
  if (fetched.length === 0)
    return { insertedCount: 0, linkedCount: 0, noisyDiscardedCount: 0 };

  // DEPRECATED: Noise injection — see deprecate-article-suggestion-flow.md
  // Noise removal is bypassed while evaluating Flow v2. The noisy-topic
  // concept may be removed entirely once v2 is validated.
  // const noisyIds = await getNoisyTopicIds();
  // let noisyDiscardedCount = 0;
  // if (noisyIds.size > 0) {
  //   fetched = fetched.filter((s) => {
  //     const topicIds = s.userTopicIds ?? [];
  //     if (topicIds.length === 0) return true;
  //     const allNoise = topicIds.every((id) => noisyIds.has(id));
  //     if (allNoise) { noisyDiscardedCount++; return false; }
  //     return true;
  //   });
  // }
  // if (fetched.length === 0)
  //   return { insertedCount: 0, linkedCount: 0, noisyDiscardedCount };
  let noisyDiscardedCount = 0;
  if (fetched.length === 0)
    return { insertedCount: 0, linkedCount: 0, noisyDiscardedCount };

  // Dedupe by `_id` — the server can return the same id across chunks of the
  // by-ids query, and a single batch with duplicate primary keys trips
  // SQLite's UNIQUE constraint on article_suggestions.id.
  const dedupedById = new Map<string, ArticleSuggestionWithMetadata>();
  for (const s of fetched) {
    if (!dedupedById.has(s._id)) dedupedById.set(s._id, s);
  }
  const uniqueFetched = [...dedupedById.values()];

  // Also skip any ids that already exist locally for the insert path. We
  // still refresh `clusterIds` on those existing rows below so the For-You
  // stacked-cards grouping reflects the latest HDBSCAN pass.
  const existingRows = await articleSuggestionsCol
    .query(Q.where('id', Q.oneOf(uniqueFetched.map((s) => s._id))))
    .fetch();
  const existingById = new Map(existingRows.map((r) => [r.id, r]));
  const toInsert = uniqueFetched.filter((s) => !existingById.has(s._id));

  // Compute cluster-ids refreshes for already-present rows: only touch rows
  // where the server's cluster set has actually changed (cuts SQLite writes).
  // Compare by canonical JSON of a sorted copy.
  const clusterIdsRefreshes: { row: ArticleSuggestionModel; nextJson: string }[] = [];
  for (const s of uniqueFetched) {
    const row = existingById.get(s._id);
    if (!row) continue;
    const nextJson = canonicalClusterIdsJson(s.clusterIds ?? []);
    const currentJson = canonicalClusterIdsJson(parseClusterIds(row.clusterIdsJson));
    if (currentJson !== nextJson) {
      clusterIdsRefreshes.push({ row, nextJson });
    }
  }

  if (toInsert.length === 0 && clusterIdsRefreshes.length === 0)
    return { insertedCount: 0, linkedCount: 0, noisyDiscardedCount };

  // Pre-load fact lookups outside the write block: WatermelonDB disallows
  // .query().fetch() during database.write().
  const factsByTopicId = await resolveFactIdsForSuggestions(toInsert);

  let insertedCount = 0;
  let linkedCount = 0;

  await database.write(async () => {
    const ops: any[] = [];
    const now = new Date();

    for (const { row, nextJson } of clusterIdsRefreshes) {
      ops.push(
        row.prepareUpdate((r) => {
          r.clusterIdsJson = nextJson;
        }),
      );
    }

    for (const s of toInsert) {
      const topicIds = s.userTopicIds ?? [];
      const prepared = articleSuggestionsCol.prepareCreate((r) => {
        // Seed the WMDB primary key with the server `_id` so they match.
        r._raw.id = s._id;
        r.articleId = s.articleId;
        r.clusterIdsJson = canonicalClusterIdsJson(s.clusterIds ?? []);
        r.relevance = 0;
        r.reason = '';
        r.relevanceGenerationCompleted = false;
        r.reasonGenerationCompleted = false;
        r.countryCode = s.country_code ?? null;
        r.languageCode = s.language_code ?? null;
        r.publicationName = s.publication_name ?? null;
        r.titleEn = s.title_en ?? null;
        r.descriptionEn = s.description_en ?? null;
        r.articleUrl = s.article_url ?? null;
        r.imageUrl = s.image_url ?? null;
        r.userTopicIdsJson = JSON.stringify(topicIds);
        r.createdAt = parseDate(s.createdAt) ?? now;
        r.firstPubDate =
          parseDate(s.firstPubDate) ?? r.createdAt;
      });
      ops.push(prepared);
      insertedCount++;

      const linkedFactIds = new Set<string>();
      for (const topicId of topicIds) {
        for (const factId of factsByTopicId.get(topicId) ?? []) {
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

  return { insertedCount, linkedCount, noisyDiscardedCount };
}

// --- Write: score ---

/**
 * Persists the result of a scoring pass.
 *
 * relevanceGenerationCompleted is set to true — callers only invoke this when
 * the relevance step succeeded. reasonGenerationCompleted reflects whether the
 * reason step reached a terminal state: either the LLM returned usable text
 * (reason non-empty) OR the row is sub-threshold and we deliberately skipped
 * generation (reasonSkipped=true). A failed-and-retryable reason is signalled
 * by reason='' AND reasonSkipped=false.
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
      r.relevanceGenerationCompleted = true;
      r.reasonGenerationCompleted = reasonSkipped || reason.length > 0;
    });
  });
}

/**
 * Updates the reason for an already-scored row.
 */
export async function saveReason(
  localSuggestionId: string,
  reason: string,
): Promise<void> {
  const row = await articleSuggestionsCol.find(localSuggestionId);
  await database.write(async () => {
    await row.update((r) => {
      r.reason = reason;
      r.reasonGenerationCompleted = reason.length > 0;
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
  const [suggestions, links, syncedIds] = await Promise.all([
    articleSuggestionsCol.query().fetch(),
    articleSuggestionFactsCol.query().fetch(),
    syncedSuggestionIdsCol.query().fetch(),
  ]);

  if (suggestions.length === 0 && links.length === 0 && syncedIds.length === 0) {
    await deleteSetting(FEED_META_KEY);
    await deleteSetting('synced_ids_last_fetched_at');
    return;
  }

  await database.write(async () => {
    await database.batch([
      ...links.map((l) => l.prepareDestroyPermanently()),
      ...suggestions.map((s) => s.prepareDestroyPermanently()),
      ...syncedIds.map((r) => r.prepareDestroyPermanently()),
    ]);
  });

  await deleteSetting(FEED_META_KEY);
  await deleteSetting('synced_ids_last_fetched_at');
}

const SUGGESTION_TTL_MS = 24 * 60 * 60 * 1000;

export async function deleteExpiredSuggestions(): Promise<number> {
  const threshold = Date.now() - SUGGESTION_TTL_MS;

  const expired = await articleSuggestionsCol
    .query(Q.where('created_at', Q.lt(threshold)))
    .fetch();
  if (expired.length === 0) return 0;

  const expiredLocalIds = expired.map((s) => s.id);
  const links = await articleSuggestionFactsCol
    .query(Q.where('article_suggestion_id', Q.oneOf(expiredLocalIds)))
    .fetch();

  await database.write(async () => {
    await database.batch([
      ...links.map((l) => l.prepareDestroyPermanently()),
      ...expired.map((s) => s.prepareDestroyPermanently()),
    ]);
  });

  return expired.length;
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
    clusterIds: parseClusterIds(row.clusterIdsJson),
    relevance: row.relevance,
    reason: row.reason,
    relevanceGenerationCompleted: row.relevanceGenerationCompleted,
    reasonGenerationCompleted: row.reasonGenerationCompleted,
    country_code: row.countryCode,
    language_code: row.languageCode,
    publication_name: row.publicationName,
    title_en: row.titleEn,
    description_en: row.descriptionEn,
    article_url: row.articleUrl,
    image_url: row.imageUrl,
    userTopicIds: parseTopicIds(row.userTopicIdsJson),
    createdAt: row.createdAt.toISOString(),
    firstPubDate: row.firstPubDate.toISOString(),
  };
}

function parseClusterIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

/** Sorted JSON encoding so equality checks are stable regardless of the
 *  order the server returned the cluster ids in. */
function canonicalClusterIdsJson(ids: string[]): string {
  return JSON.stringify([...ids].sort());
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

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const t = new Date(value).getTime();
    return isNaN(t) ? null : new Date(t);
  }
  return null;
}

/**
 * Resolve the set of local fact ids linked to each incoming server topic id
 * via the `fact_topic_links` table.
 */
async function resolveFactIdsForSuggestions(
  fetched: ArticleSuggestionWithMetadata[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  const topicIds = [
    ...new Set(fetched.flatMap((s) => s.userTopicIds ?? [])),
  ];
  if (topicIds.length === 0) return result;

  const links = await factTopicLinksCol
    .query(Q.where('server_topic_id', Q.oneOf(topicIds)))
    .fetch();
  for (const link of links) {
    const bucket = result.get(link.serverTopicId) ?? [];
    bucket.push(link.factId);
    result.set(link.serverTopicId, bucket);
  }

  return result;
}

// --- Flow v2: persist ArticleWithClusters rows (keyed by articleId) ---

/**
 * [Flow v2] Persist articles returned by the stateless `articlesForTopicsByIds`
 * query. WMDB row id == articleId (no server-side suggestion document). Facts
 * are linked via `fact_topic_links.topic_text` using the topic texts that
 * matched each article (supplied by the caller from the `articleIdsForTopics`
 * response).
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

  const clusterIdsRefreshes: { row: ArticleSuggestionModel; nextJson: string }[] = [];
  for (const a of fetched) {
    const row = existingById.get(a._id);
    if (!row) continue;
    const nextJson = canonicalClusterIdsJson(a.clusterIds ?? []);
    const currentJson = canonicalClusterIdsJson(parseClusterIds(row.clusterIdsJson));
    if (currentJson !== nextJson) clusterIdsRefreshes.push({ row, nextJson });
  }

  if (toInsert.length === 0 && clusterIdsRefreshes.length === 0) {
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

    for (const { row, nextJson } of clusterIdsRefreshes) {
      ops.push(row.prepareUpdate((r) => { r.clusterIdsJson = nextJson; }));
    }

    for (const a of toInsert) {
      const topicTexts = articleToTopicTexts.get(a._id) ?? [];
      const prepared = articleSuggestionsCol.prepareCreate((r) => {
        r._raw.id = a._id;
        r.articleId = a._id;
        r.clusterIdsJson = canonicalClusterIdsJson(a.clusterIds ?? []);
        r.relevance = 0;
        r.reason = '';
        r.relevanceGenerationCompleted = false;
        r.reasonGenerationCompleted = false;
        r.countryCode = a.country_code ?? null;
        r.languageCode = a.language_code ?? null;
        r.publicationName = a.publication_name ?? null;
        r.titleEn = a.title_en ?? null;
        r.descriptionEn = a.description_en ?? null;
        r.articleUrl = a.article_url ?? null;
        r.imageUrl = a.image_url ?? null;
        r.userTopicIdsJson = JSON.stringify(topicTexts);
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

  const links = await factTopicLinksCol
    .query(Q.where('topic_text', Q.oneOf(topicTexts)))
    .fetch();

  for (const link of links) {
    const bucket = result.get(link.topicText) ?? [];
    bucket.push(link.factId);
    result.set(link.topicText, bucket);
  }
  return result;
}

// --- synced_suggestion_ids: server's "what's open in the 24h window" set ---

/**
 * Reconcile the local `synced_suggestion_ids` table with the server's current
 * id set.
 */
export async function replaceSyncedIdSet(serverIds: string[]): Promise<void> {
  const serverSet = new Set(serverIds);
  const existing = await syncedSuggestionIdsCol.query().fetch();
  const existingIds = new Set(existing.map((r) => r.id));

  const toDelete = existing.filter((r) => !serverSet.has(r.id));
  const toInsert = serverIds.filter((id) => !existingIds.has(id));

  if (toDelete.length === 0 && toInsert.length === 0) return;

  const now = Date.now();
  await database.write(async () => {
    const ops: any[] = [];
    for (const row of toDelete) ops.push(row.prepareDestroyPermanently());
    for (const id of toInsert) {
      ops.push(
        syncedSuggestionIdsCol.prepareCreate((r) => {
          r._raw.id = id;
          r.fetchedAt = now;
          r.processedAt = null;
        }),
      );
    }
    if (ops.length > 0) await database.batch(ops);
  });
}

/**
 * Pick the next batch of ids the server says are open AND we don't already
 * have hydrated locally.
 */
export async function getUnprocessedSyncedIds(limit?: number): Promise<string[]> {
  const unprocessed = await syncedSuggestionIdsCol
    .query(Q.where('processed_at', null))
    .fetch();
  if (unprocessed.length === 0) return [];

  const haveLocal = new Set(
    (
      await articleSuggestionsCol
        .query(Q.where('id', Q.oneOf(unprocessed.map((r) => r.id))))
        .fetch()
    ).map((r) => r.id),
  );

  const result: string[] = [];
  for (const row of unprocessed) {
    if (haveLocal.has(row.id)) continue;
    result.push(row.id);
    if (limit !== undefined && result.length >= limit) break;
  }
  return result;
}

export async function markSyncedIdsProcessed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await syncedSuggestionIdsCol
    .query(Q.where('id', Q.oneOf(ids)))
    .fetch();
  const now = Date.now();
  await database.write(async () => {
    await database.batch(
      rows
        .filter((r) => r.processedAt === null)
        .map((r) =>
          r.prepareUpdate((rec) => {
            rec.processedAt = now;
          }),
        ),
    );
  });
}

export async function countUnprocessedSyncedIds(): Promise<number> {
  return await syncedSuggestionIdsCol
    .query(Q.where('processed_at', null))
    .fetchCount();
}

export async function countProcessedSyncedIds(): Promise<number> {
  return await syncedSuggestionIdsCol
    .query(Q.where('processed_at', Q.notEq(null)))
    .fetchCount();
}

export async function countTotalSyncedIds(): Promise<number> {
  return await syncedSuggestionIdsCol.query().fetchCount();
}

/**
 * Drop `article_suggestions` rows whose id is no longer in
 * `synced_suggestion_ids`.
 */
export async function deleteAgedOutSuggestions(): Promise<number> {
  const allLocal = await articleSuggestionsCol.query().fetch();
  if (allLocal.length === 0) return 0;
  const syncedIds = new Set(
    (await syncedSuggestionIdsCol.query().fetch()).map((r) => r.id),
  );
  const toDeleteIds = allLocal
    .filter((r) => !syncedIds.has(r.id))
    .map((r) => r.id);
  if (toDeleteIds.length === 0) return 0;
  return await deleteSuggestionsByServerIds(toDeleteIds);
}
