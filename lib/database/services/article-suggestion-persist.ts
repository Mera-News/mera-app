// Article Suggestion Service: persisting server suggestions.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import { ArticleSuggestionStatus } from '../article-suggestion-status';
import type ArticleSuggestionModel from '../models/ArticleSuggestion';
import type ArticleSuggestionFactModel from '../models/ArticleSuggestionFact';
import type { ArticleWithClusters } from '../../generated/graphql-types';
import { getFacts } from './fact-service';
import logger from '../../logger';
import { toClusterMemberships, parseClusterMemberships, canonicalClusterMembershipsJson, parseDate, buildMatchedTopicsJson, isMatchedTopicsJsonEmpty, pickStableClusterId } from './article-suggestion-mappers';
import type { MatchedTopicMeta } from './article-suggestion-mappers';
import { resolveFactsByTopicIds } from './article-suggestion-reads';

const articleSuggestionsCol = database.get<ArticleSuggestionModel>('article_suggestions');
const articleSuggestionFactsCol = database.get<ArticleSuggestionFactModel>('article_suggestion_facts');

/**
 * Persona-v3 per-article metadata (supplied by feed-sync from the
 * `articleIdsForPersona` response, inverted per article). Present ⇒ the new
 * persona path: facts link via `topics.fact_id`, and matched_topics_json /
 * stable_cluster_id / headline_scope are persisted. Absent ⇒ the legacy
 * fallback path (metadata.topics fact-linking).
 */
export interface PersonaPersistMeta {
  /** articleId → inverted matchMeta [{ topicId, text, vectorScore? }]. */
  matchedTopics: Map<string, MatchedTopicMeta[]>;
  /** articleId → 'CITY' | 'COUNTRY' | 'GLOBAL' (top-headline injection). */
  headlineScope?: Map<string, string>;
  /** articleId → uppercase ISO country code the COUNTRY-scope headline came
   *  from. Only populated for the article's WINNING headline scope, and only
   *  when that scope is COUNTRY — a GLOBAL headline has no owning country, so
   *  it is absent here rather than carrying a misleading code. */
  headlineCountryCode?: Map<string, string>;
  /** articleId → stable cluster id (server's largest-cluster rule). */
  stableClusterId?: Map<string, string>;
}

/**
 * [Flow v2 + Persona v3] Persist articles returned by the stateless hydration
 * query. WMDB row id == articleId. When `personaMeta` is supplied (persona-v3
 * path), facts link via `topics.fact_id` and the persona scorer-input columns
 * (geo/entities/event_type/category/max_cluster_size/matched_topics/
 * stable_cluster_id/headline_scope) are persisted. Without it (fallback path),
 * facts link via fact metadata topic texts. Hydration metadata columns are
 * ALWAYS persisted from the row when the server sent them (nullable).
 */
export async function persistAndLinkV2Suggestions(
  fetched: ArticleWithClusters[],
  articleToTopicTexts: Map<string, string[]>,
  personaMeta?: PersonaPersistMeta,
): Promise<{ insertedCount: number; linkedCount: number }> {
  if (fetched.length === 0) return { insertedCount: 0, linkedCount: 0 };

  // Dedupe by article id BEFORE anything else. The hydration query returns one
  // row per (article, matched topic), so an article matching two topics — or
  // sitting in two clusters — arrives twice in `fetched`. Both copies then
  // missed the existing-row check identically and the SAME id was
  // prepareCreate'd twice into one batch, which SQLite rejects wholesale:
  // "sqlite error 1555 (UNIQUE constraint failed: article_suggestions.id)"
  // (MERA-APP-6K). The batch is atomic, so one duplicated article discarded the
  // entire sync's inserts, not just its own row.
  //
  // First copy wins: the per-article metadata below is derived from
  // `personaMeta` maps keyed by article id, which are identical for every copy,
  // so the copies are interchangeable.
  //
  // The read below happens outside `database.write`, so two CONCURRENT callers
  // (feed-sync racing a manual refresh) can both read "absent". The writer
  // therefore re-checks which of those ids are still absent before it creates
  // anything, so the loser skips what the winner inserted and still inserts its
  // own.
  const deduped: ArticleWithClusters[] = [];
  const seenIds = new Set<string>();
  for (const a of fetched) {
    if (seenIds.has(a._id)) continue;
    seenIds.add(a._id);
    deduped.push(a);
  }

  const existingRows = await articleSuggestionsCol
    .query(Q.where('id', Q.oneOf(deduped.map((a) => a._id))))
    .fetch();
  const existingById = new Map(existingRows.map((r) => [r.id, r]));
  const toInsert = deduped.filter((a) => !existingById.has(a._id));

  // Updates to already-persisted rows: a changed cluster membership and/or the
  // P7e matched-topics backfill. Each field is optional and applied only when
  // set, so an unchanged cluster is left alone while topics are healed and vice
  // versa.
  const existingUpdates: {
    row: ArticleSuggestionModel;
    nextClusterJson?: string;
    nextMatchedTopicsJson?: string;
  }[] = [];
  for (const a of deduped) {
    const row = existingById.get(a._id);
    if (!row) continue;
    const update: {
      row: ArticleSuggestionModel;
      nextClusterJson?: string;
      nextMatchedTopicsJson?: string;
    } = { row };
    let hasUpdate = false;

    const nextJson = canonicalClusterMembershipsJson(toClusterMemberships(a.clusters));
    const currentJson = canonicalClusterMembershipsJson(
      parseClusterMemberships(row.clusterMembershipsJson),
    );
    if (currentJson !== nextJson) {
      update.nextClusterJson = nextJson;
      hasUpdate = true;
    }

    // P7e: heal rows persisted during the topics-empty window. The legacy
    // fallback persisted matched_topics_json = null, so section ownership
    // orphaned every article to "Also for you" (sticky, since a re-sync only
    // ever touched clusterMembershipsJson). When we now have persona matched
    // topics for this article and the stored value is still null/empty, backfill
    // it — never overwriting a non-null value.
    if (personaMeta && isMatchedTopicsJsonEmpty(row.matchedTopicsJson)) {
      const matched = personaMeta.matchedTopics.get(a._id) ?? [];
      if (matched.length > 0) {
        update.nextMatchedTopicsJson = buildMatchedTopicsJson(matched);
        hasUpdate = true;
      }
    }

    if (hasUpdate) existingUpdates.push(update);
  }

  if (toInsert.length === 0 && existingUpdates.length === 0) {
    return { insertedCount: 0, linkedCount: 0 };
  }

  // --- Fact resolution: persona path uses topics.fact_id; fallback uses texts.
  let factsByTopicText: Map<string, string[]> | null = null;
  let factByTopicId: Map<string, string> | null = null;
  if (personaMeta) {
    const allTopicIds = Array.from(
      new Set(
        toInsert.flatMap((a) =>
          (personaMeta.matchedTopics.get(a._id) ?? [])
            .map((m) => m.topicId)
            .filter((id): id is string => !!id),
        ),
      ),
    );
    factByTopicId = await resolveFactsByTopicIds(allTopicIds);
  } else {
    const allTopicTexts = Array.from(
      new Set(toInsert.flatMap((a) => articleToTopicTexts.get(a._id) ?? [])),
    );
    factsByTopicText = await resolveFactsByTopicTexts(allTopicTexts);
  }

  let insertedCount = 0;
  let linkedCount = 0;

  await database.write(async () => {
    const ops: any[] = [];
    const now = new Date();

    // Atomic with the creates below: a concurrent writer that ran first has
    // committed its rows by now, and a second create of the same id would reject
    // this whole batch (the loser's own new article included).
    const takenNow = new Set(
      (
        await articleSuggestionsCol
          .query(Q.where('id', Q.oneOf(toInsert.map((a) => a._id))))
          .fetch()
      ).map((r) => r.id),
    );

    // A prune can destroy a planned row between the read above and this writer;
    // preparing an update on it would throw and fail the whole batch.
    const stillThere = new Set(
      (
        await articleSuggestionsCol
          .query(Q.where('id', Q.oneOf(existingUpdates.map((u) => u.row.id))))
          .fetch()
      ).map((r) => r.id),
    );

    for (const { row, nextClusterJson, nextMatchedTopicsJson } of existingUpdates) {
      if (!stillThere.has(row.id)) continue;
      ops.push(
        row.prepareUpdate((r) => {
          if (nextClusterJson !== undefined) r.clusterMembershipsJson = nextClusterJson;
          if (nextMatchedTopicsJson !== undefined) r.matchedTopicsJson = nextMatchedTopicsJson;
        }),
      );
    }

    for (const a of toInsert) {
      if (takenNow.has(a._id)) continue;
      const matched = personaMeta?.matchedTopics.get(a._id) ?? [];
      // Topic texts: persona path derives them from matchMeta entries; fallback
      // uses the caller-supplied text map. Kept for matched_topic_texts_json
      // (getArticleSuggestionsByTopicTexts / pruneOrphanedSuggestions readers).
      const topicTexts = personaMeta
        ? Array.from(new Set(matched.map((m) => m.text).filter((t) => t && t.length > 0)))
        : articleToTopicTexts.get(a._id) ?? [];
      const scope = personaMeta?.headlineScope?.get(a._id) ?? null;
      // Only meaningful alongside a COUNTRY scope; feed-sync already writes the
      // map under the same first-writer-wins guard as `headlineScope`, so the
      // two can never describe different scopes for the same article.
      const scopeCountry =
        scope === 'COUNTRY'
          ? personaMeta?.headlineCountryCode?.get(a._id) ?? null
          : null;
      const stableId = pickStableClusterId(a, personaMeta?.stableClusterId?.get(a._id));

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
        // ── Persona v3 scorer-input columns (hydration metadata always; the
        //    persona-specific ones only on the persona path) ──
        r.geoTagsJson = a.geo_tags && a.geo_tags.length > 0
          ? JSON.stringify(
              a.geo_tags.map((g) => ({
                city: g.city ?? undefined,
                region: g.region ?? undefined,
                countryCode: g.countryCode,
              })),
            )
          : null;
        r.entitiesJson = a.entities && a.entities.length > 0 ? JSON.stringify(a.entities) : null;
        r.eventType = a.event_type ?? null;
        r.category = a.category ?? null;
        r.maxClusterSize = a.maxClusterSize ?? null;
        r.stableClusterId = stableId;
        r.headlineScope = scope;
        r.headlineCountryCode = scopeCountry;
        r.matchedTopicsJson = personaMeta ? buildMatchedTopicsJson(matched) : null;
        r.computedScore = null;
        r.rawScore = null;
        r.scoreComponentsJson = null;
        r.createdAt = now;
        r.firstPubDate = parseDate(a.pubDate) ?? now;
      });
      ops.push(prepared);
      insertedCount++;

      // --- Fact links ---
      const linkedFactIds = new Set<string>();
      if (personaMeta && factByTopicId) {
        for (const m of matched) {
          if (!m.topicId) continue; // synthetic headline entry → no fact
          const factId = factByTopicId.get(m.topicId);
          if (factId) linkedFactIds.add(factId);
        }
      } else if (factsByTopicText) {
        for (const topicText of topicTexts) {
          for (const factId of factsByTopicText.get(topicText) ?? []) {
            linkedFactIds.add(factId);
          }
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
