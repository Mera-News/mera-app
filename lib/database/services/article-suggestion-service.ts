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
import type TopicModel from '../models/Topic';
import type { ArticleWithClusters } from '../../generated/graphql-types';
import type { ForYouSuggestion, ClusterMembership } from '../../stores/for-you-store';
import type { StageCandidateRow } from '@/lib/news-harness/core/types';
import type {
  ScoredCandidateInput,
  MatchedTopicInput,
  ArticleGeoTag,
  HeadlineScope,
  RelevanceComponents,
} from '@/lib/news-harness/scoring-engine';
import { getSetting, setSetting, deleteSetting } from './setting-service';
import { getFacts } from './fact-service';
import logger from '../../logger';

const articleSuggestionsCol = database.get<ArticleSuggestionModel>('article_suggestions');
const articleSuggestionFactsCol = database.get<ArticleSuggestionFactModel>('article_suggestion_facts');
const factsCol = database.get<FactModel>('facts');
const topicsCol = database.get<TopicModel>('topics');

/** Effective-weight resolver for one topic id, supplied by the orchestrator
 *  (built from live topics × fact weights). */
export interface TopicWeightInfo {
  effectiveWeight: number;
  highPriority: boolean;
  locationId?: string | null;
}

function parseJsonArray<T>(json: string | null | undefined): T[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * Pure mapper: a persona-v3 suggestion row's raw metadata columns + a live
 * topic-weight resolver → the ScoredCandidateInput the math engine scores.
 * Missing/deleted topics (or synthetic headline entries with topicId null)
 * resolve to effectiveWeight 0. Absent geo/entities/event_type ⇒ the engine
 * routes the candidate to the backstop LLM path (isBackstop in relevance.ts).
 */
export function buildStageCandidateInput(
  row: StageCandidateRow,
  topicWeights: Map<string, TopicWeightInfo>,
): ScoredCandidateInput {
  const geoTags = parseJsonArray<{ city?: string; region?: string; countryCode?: string }>(
    row.geoTagsJson,
  )
    .filter((g) => g && typeof g.countryCode === 'string' && g.countryCode.length > 0)
    .map<ArticleGeoTag>((g) => ({
      city: g.city ?? undefined,
      region: g.region ?? undefined,
      countryCode: g.countryCode as string,
    }));

  const entities = parseJsonArray<string>(row.entitiesJson).filter(
    (e): e is string => typeof e === 'string' && e.length > 0,
  );

  const rawMatched = parseJsonArray<{
    topicId?: string | null;
    text?: string;
    vectorScore?: number | null;
  }>(row.matchedTopicsJson);
  const matchedTopics: MatchedTopicInput[] = rawMatched.map((m) => {
    const info = m.topicId ? topicWeights.get(m.topicId) : undefined;
    return {
      topicId: m.topicId ?? null,
      text: m.text,
      effectiveWeight: info?.effectiveWeight ?? 0,
      highPriority: info?.highPriority ?? false,
      locationId: info?.locationId ?? undefined,
      vectorScore: m.vectorScore ?? undefined,
    };
  });

  const headlineScope: HeadlineScope | null =
    row.headlineScope === 'CITY' ||
    row.headlineScope === 'COUNTRY' ||
    row.headlineScope === 'GLOBAL'
      ? (row.headlineScope as HeadlineScope)
      : null;

  return {
    id: row.id,
    titleEn: row.titleEn,
    descriptionEn: row.descriptionEn,
    publicationName: row.publicationName,
    countryCode: row.countryCode,
    pubDateMs: row.firstPubDateMs,
    maxClusterSize: row.maxClusterSize,
    eventType: row.eventType,
    category: row.category,
    geoTags,
    entities,
    matchedTopics,
    headlineScope,
    stableClusterId: row.stableClusterId,
  };
}

/** factId → fact-level weight multiplier (null/undefined ⇒ 1.0). Used by the
 *  orchestrators to compute topic effectiveWeight = topic.weight × factWeight. */
export async function getFactWeightById(): Promise<Map<string, number>> {
  const facts = await factsCol.query().fetch();
  const m = new Map<string, number>();
  for (const f of facts) m.set(f.id, f.weight ?? 1);
  return m;
}

/** Snapshot the persona-v3 scorer-input columns of a row (raw JSON). */
function toStageRow(row: ArticleSuggestionModel): StageCandidateRow {
  const pubMs = row.firstPubDate?.getTime?.();
  return {
    id: row.id,
    titleEn: row.titleEn,
    descriptionEn: row.descriptionEn,
    publicationName: row.publicationName,
    countryCode: row.countryCode,
    firstPubDateMs: Number.isFinite(pubMs) ? (pubMs as number) : null,
    maxClusterSize: row.maxClusterSize,
    eventType: row.eventType,
    category: row.category,
    geoTagsJson: row.geoTagsJson,
    entitiesJson: row.entitiesJson,
    matchedTopicsJson: row.matchedTopicsJson,
    headlineScope: row.headlineScope,
    stableClusterId: row.stableClusterId,
  };
}

/**
 * Resolve the owning fact for each topic id via the persona-v3 `topics` table
 * (topics.fact_id), replacing the old `resolveFactsByTopicTexts` scan of
 * fact.metadata.topics for the persona-v3 path. Returns topicId → factId for
 * topics that have an owning fact (headline/global topics with no fact_id are
 * simply absent → no fact link, which the reason path handles via the headline
 * label).
 */
async function resolveFactsByTopicIds(
  topicIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (topicIds.length === 0) return result;
  const rows = await topicsCol.query(Q.where('id', Q.oneOf(topicIds))).fetch();
  for (const t of rows) {
    if (t.factId) result.set(t.id, t.factId);
  }
  return result;
}

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
  // Intentionally uncapped: article_suggestions is bounded by the server's 48h
  // suggestion TTL, not by a query limit here.
  const rows = await articleSuggestionsCol.query().fetch();
  if (rows.length === 0) return [];
  const factIdsBySuggestion = await loadFactIdsBySuggestion(rows.map((r) => r.id));
  return rows.map((row) =>
    toForYouSuggestion(row, factIdsBySuggestion.get(row.id) ?? []),
  );
}

/** Batch-load the linked fact ids for a set of suggestion ids →
 *  suggestionId → factId[] (empty for orphan/headline rows). */
async function loadFactIdsBySuggestion(
  ids: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  const links = await articleSuggestionFactsCol
    .query(Q.where('article_suggestion_id', Q.oneOf(ids)))
    .fetch();
  for (const link of links) {
    const bucket = map.get(link.articleSuggestionId) ?? [];
    bucket.push(link.factId);
    map.set(link.articleSuggestionId, bucket);
  }
  return map;
}

// --- Read: unscored with linked facts (scoring input) ---

// Canonical home is now lib/news-harness/core/types.ts; re-exported here so
// importers of ScoringCandidate from this service keep working unchanged.
import type { ScoringCandidate } from '@/lib/news-harness/core/types';
export type { ScoringCandidate };

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
    meta: toStageRow(row),
  }));
}

export async function countUnscoredSuggestions(): Promise<number> {
  return articleSuggestionsCol
    .query(Q.where('status', ArticleSuggestionStatus.Unscored))
    .fetchCount();
}

/**
 * Returns the created-at timestamp (ms) of the oldest still-unscored row, or
 * null when no unscored rows exist. Backs the scoring-pipeline min-run-size
 * gate's 30-minute escape (a slow trickle shouldn't hide news indefinitely).
 */
export async function getOldestUnscoredCreatedAt(): Promise<number | null> {
  const rows = await articleSuggestionsCol
    .query(
      Q.where('status', ArticleSuggestionStatus.Unscored),
      Q.sortBy('created_at', Q.asc),
      Q.take(1),
    )
    .fetch();
  return rows[0]?.createdAt.getTime() ?? null;
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
    meta: toStageRow(row),
  }));
}

// --- Read: story-grouping projections (skip-gate / sibling propagation) ---

/** Minimal projection of a suggestion row for story-grouping decisions
 *  (structurally compatible with feed-grouping's GroupableItem). */
export interface SuggestionGroupingRow {
  id: string;
  title: string | null; // titleEn ?? titleOriginal
  clusters: { clusterId: string; confidence: number; stableClusterId?: string | null }[]; // parsed memberships
  relevance: number;
  reason: string;
  status: ArticleSuggestionStatus;
  firstPubDateMs: number; // epoch ms, 0 if invalid
  hasDescription: boolean; // !!descriptionEn — used for representative election
}

function toGroupingRow(row: ArticleSuggestionModel): SuggestionGroupingRow {
  const pubMs = row.firstPubDate?.getTime?.();
  return {
    id: row.id,
    title: row.titleEn ?? row.titleOriginal,
    clusters: parseClusterMemberships(row.clusterMembershipsJson),
    relevance: row.relevance,
    reason: row.reason,
    status: row.status,
    firstPubDateMs: Number.isFinite(pubMs) ? (pubMs as number) : 0,
    hasDescription: !!row.descriptionEn,
  };
}

/** Grouping rows for specific suggestion ids (skip-gate candidates). */
export async function getGroupingRowsByIds(ids: string[]): Promise<SuggestionGroupingRow[]> {
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  const rows = await articleSuggestionsCol
    .query(Q.where('id', Q.oneOf(ids)))
    .fetch();
  // The unit-test fake DB layer doesn't evaluate Q.where predicates (see
  // mockDatabase.ts), so re-assert the id filter in memory too.
  return rows.filter((r) => idSet.has(r.id)).map(toGroupingRow);
}

/** All currently-unscored rows as grouping rows. */
export async function getUnscoredGroupingRows(): Promise<SuggestionGroupingRow[]> {
  const rows = await articleSuggestionsCol
    .query(Q.where('status', ArticleSuggestionStatus.Unscored))
    .fetch();
  return rows
    .filter((r) => r.status === ArticleSuggestionStatus.Unscored)
    .map(toGroupingRow);
}

/**
 * Score donors for sibling propagation: status != Unscored, created_at >= sinceMs,
 * relevance > 0. The relevance > 0 filter excludes the ineligible tombstones
 * written by `batchMarkAsScoredByIds` (relevance=0), which carry no real
 * scoring signal and would otherwise look like a confident "not relevant" donor.
 */
export async function getScoredDonorRows(sinceMs: number): Promise<SuggestionGroupingRow[]> {
  const rows = await articleSuggestionsCol
    .query(
      Q.where('status', Q.notEq(ArticleSuggestionStatus.Unscored)),
      Q.where('created_at', Q.gte(sinceMs)),
      Q.where('relevance', Q.gt(0)),
    )
    .fetch();
  // Same defensive re-filter as above — the fake query() ignores Q.where.
  return rows
    .filter(
      (r) =>
        r.status !== ArticleSuggestionStatus.Unscored &&
        r.createdAt.getTime() >= sinceMs &&
        r.relevance > 0,
    )
    .map(toGroupingRow);
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
  params: {
    relevance: number;
    reason: string;
    reasonSkipped: boolean;
    /** Persona-v3 audit: pre-judge deterministic math score. */
    computedScore?: number;
    /** Persona-v3 audit: final post-judge raw score (section ordering). */
    rawScore?: number;
    /** Persona-v3 audit: RelevanceComponents breakdown, JSON-encoded. */
    scoreComponentsJson?: string;
  },
): Promise<void> {
  const { relevance, reason, reasonSkipped, computedScore, rawScore, scoreComponentsJson } = params;
  const row = await articleSuggestionsCol.find(localSuggestionId);
  await database.write(async () => {
    await row.update((r) => {
      r.relevance = relevance;
      r.reason = reason;
      if (computedScore !== undefined) r.computedScore = computedScore;
      if (rawScore !== undefined) r.rawScore = rawScore;
      if (scoreComponentsJson !== undefined) r.scoreComponentsJson = scoreComponentsJson;
      // Round-3: stamp scored_at the moment the row leaves `unscored`. Only set
      // it once (a later reason write must not slide the "added" time forward).
      if (r.scoredAt == null) r.scoredAt = Date.now();
      r.status =
        reason.length > 0 || reasonSkipped
          ? ArticleSuggestionStatus.Complete
          : ArticleSuggestionStatus.ReasonPending;
    });
  });
}

/**
 * Round-3 B1: persist the deterministic math result for a batch of judge-mode
 * rows in ONE write, at SUBMIT time — bucketed `relevance`, `reason:''`, the
 * audit columns (computed/raw/components), a fresh `scored_at`, and the derived
 * status: `complete` for sub-threshold rows (reasonSkipped — terminal, no note
 * owed) else `reason_pending` (the combined judge+notes job fills the note at
 * decode). This makes cards renderable immediately; a later judge failure
 * fail-opens to exactly these persisted scores. Missing rows are skipped.
 */
export async function batchSaveMathScores(
  entries: {
    id: string;
    relevance: number;
    reasonSkipped: boolean;
    computedScore: number;
    rawScore: number;
    scoreComponentsJson: string;
  }[],
  nowMs: number = Date.now(),
): Promise<void> {
  if (entries.length === 0) return;
  const rows = await Promise.all(
    entries.map((e) => articleSuggestionsCol.find(e.id).catch(() => null)),
  );
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const present = rows.filter((r): r is ArticleSuggestionModel => r != null);
  if (present.length === 0) return;
  await database.write(async () => {
    await database.batch(
      present.map((row) => {
        const e = entryById.get(row.id)!;
        return row.prepareUpdate((r) => {
          r.relevance = e.relevance;
          r.reason = '';
          r.computedScore = e.computedScore;
          r.rawScore = e.rawScore;
          r.scoreComponentsJson = e.scoreComponentsJson;
          if (r.scoredAt == null) r.scoredAt = nowMs;
          r.status = e.reasonSkipped
            ? ArticleSuggestionStatus.Complete
            : ArticleSuggestionStatus.ReasonPending;
        });
      }),
    );
  });
}

/**
 * Round-3 B1: read the persisted RelevanceComponents (+ computed_score) for a
 * small set of ids — the cloud judge-decode path needs them to build a
 * CalibrationCase for each overridden row (the advisory judge score vs the math,
 * with its component breakdown). Rows missing / with unparseable components are
 * simply absent from the returned map. Read-only.
 */
export async function getComputedComponentsByIds(
  ids: string[],
): Promise<Map<string, { computedScore: number | null; components: RelevanceComponents }>> {
  const out = new Map<string, { computedScore: number | null; components: RelevanceComponents }>();
  if (ids.length === 0) return out;
  const rows = await articleSuggestionsCol
    .query(Q.where('id', Q.oneOf(ids)))
    .fetch();
  for (const row of rows) {
    if (!row.scoreComponentsJson) continue;
    try {
      const components = JSON.parse(row.scoreComponentsJson) as RelevanceComponents;
      out.set(row.id, { computedScore: row.computedScore, components });
    } catch {
      // Unparseable audit JSON — skip (calibration just loses this one case).
    }
  }
  return out;
}

/**
 * Persist the persona-v3 math audit columns for a batch of rows WITHOUT
 * touching relevance/reason/status. Used by the E2EE pipeline at submit time
 * (doSubmitRelevance): the math (computed_score/components) runs on-device
 * before the judge job is sent, so a later judge failure fail-opens to
 * computed_score as the source of truth. One batched write.
 */
export async function batchSaveComputedScores(
  entries: { id: string; computedScore: number; rawScore: number; scoreComponentsJson: string }[],
): Promise<void> {
  if (entries.length === 0) return;
  const rows = await Promise.all(
    entries.map((e) => articleSuggestionsCol.find(e.id).catch(() => null)),
  );
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const present = rows.filter((r): r is ArticleSuggestionModel => r != null);
  if (present.length === 0) return;
  await database.write(async () => {
    await database.batch(
      present.map((row) => {
        const e = entryById.get(row.id)!;
        return row.prepareUpdate((r) => {
          r.computedScore = e.computedScore;
          r.rawScore = e.rawScore;
          r.scoreComponentsJson = e.scoreComponentsJson;
        });
      }),
    );
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
 * One batched write applying propagated scores (sibling stories inheriting a
 * donor's relevance + reason). Status is ALWAYS Complete — never ReasonPending,
 * or the orphaned-reasons sweep would re-spend the LLM calls this propagation
 * just saved. Mirrors batchMarkAsScoredByIds's prepareUpdate+batch shape.
 */
export async function batchPropagateScores(
  entries: { id: string; relevance: number; reason: string }[],
): Promise<void> {
  if (entries.length === 0) return;
  const rows = await Promise.all(entries.map((e) => articleSuggestionsCol.find(e.id)));
  const entryById = new Map(entries.map((e) => [e.id, e]));
  await database.write(async () => {
    await database.batch(
      rows.map((row) => {
        const entry = entryById.get(row.id)!;
        return row.prepareUpdate((r) => {
          r.relevance = entry.relevance;
          r.reason = entry.reason;
          r.status = ArticleSuggestionStatus.Complete;
        });
      }),
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
    const factIds = await loadFactIdsBySuggestion([serverId]);
    return toForYouSuggestion(row, factIds.get(serverId) ?? []);
  } catch {
    return null;
  }
}

/**
 * Assemble the context an article-feedback agent needs: the suggestion row,
 * the topic texts that matched it, and the facts that produced those topics.
 * Looks up by `suggestionId` (server id) or, failing that, by `articleId`
 * (newest matching row). Returns null when no suggestion row exists on-device
 * (non-personalized article — the agent falls back to a generic prompt).
 */
export async function getSuggestionFeedbackContext(opts: {
  suggestionId?: string;
  articleId?: string;
}): Promise<{
  suggestion: ForYouSuggestion;
  matchedTopicTexts: string[];
  linkedFacts: { id: string; statement: string }[];
  entities: string[];
  category: string | null;
} | null> {
  let row: ArticleSuggestionModel | null = null;

  if (opts.suggestionId) {
    row = await articleSuggestionsCol.find(opts.suggestionId).catch(() => null);
  }
  if (!row && opts.articleId) {
    const rows = await articleSuggestionsCol
      .query(Q.where('article_id', opts.articleId), Q.sortBy('created_at', Q.desc))
      .fetch();
    row = rows[0] ?? null;
  }
  if (!row) return null;

  const suggestion = toForYouSuggestion(row);
  const matchedTopicTexts = parseTopicIds(row.matchedTopicTextsJson);

  // Join article_suggestion_facts → facts (same pattern as resolveFactsByTopicTexts).
  const links = await articleSuggestionFactsCol
    .query(Q.where('article_suggestion_id', row.id))
    .fetch();
  const linkedFactIds = new Set(links.map((l) => l.factId));
  const linkedFacts: { id: string; statement: string }[] = [];
  if (linkedFactIds.size > 0) {
    const facts = await getFacts();
    for (const fact of facts) {
      if (linkedFactIds.has(fact.id)) {
        linkedFacts.push({ id: fact.id, statement: fact.statement });
      }
    }
  }

  // Entities (≤8) + category feed the "less of this" choose-one alternatives.
  const entities = parseJsonArray<string>(row.entitiesJson)
    .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    .slice(0, 8);
  const category = row.category ?? null;

  return { suggestion, matchedTopicTexts, linkedFacts, entities, category };
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

function toForYouSuggestion(
  row: ArticleSuggestionModel,
  factIds: string[] = [],
): ForYouSuggestion {
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
    // Persona v3 fields for the fact-sectioned feed selector (nullable).
    rawScore: row.rawScore,
    eventType: row.eventType,
    headlineScope:
      row.headlineScope === 'CITY' ||
      row.headlineScope === 'COUNTRY' ||
      row.headlineScope === 'GLOBAL'
        ? row.headlineScope
        : null,
    matchedTopics: parseMatchedTopicRefs(row.matchedTopicsJson),
    // Round-3 fact-rows fields.
    factIds,
    scoredAt: typeof row.scoredAt === 'number' ? row.scoredAt : null,
  };
}

/** Parse `matched_topics_json` → [{topicId, text}] refs for the feed selector.
 *  Malformed / absent JSON yields an empty list (legacy rows). */
function parseMatchedTopicRefs(
  json: string | null | undefined,
): { topicId: string | null; text: string }[] {
  const raw = parseJsonArray<{ topicId?: string | null; text?: string }>(json);
  const out: { topicId: string | null; text: string }[] = [];
  for (const m of raw) {
    if (!m) continue;
    out.push({
      topicId: typeof m.topicId === 'string' && m.topicId.length > 0 ? m.topicId : null,
      text: typeof m.text === 'string' ? m.text : '',
    });
  }
  return out;
}

/** Strip GraphQL `__typename` from the hydrated `clusters` field down to the
 *  plain `{ clusterId, confidence }` shape we persist and feed the UI. */
function toClusterMemberships(
  clusters: ArticleWithClusters['clusters'] | null | undefined,
): ClusterMembership[] {
  if (!clusters) return [];
  return clusters.map((c) => {
    const m: ClusterMembership = { clusterId: c.clusterId, confidence: c.confidence };
    // Only carry stableClusterId when the server actually set it (multi-member
    // clusters). Singletons/unclustered → omitted, keeping the persisted JSON
    // (and its canonical equality key) minimal and unchanged for those rows.
    if (c.stableClusterId) m.stableClusterId = c.stableClusterId;
    return m;
  });
}

function parseClusterMemberships(
  json: string | null | undefined,
): ClusterMembership[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is ClusterMembership =>
          m != null &&
          typeof m.clusterId === 'string' &&
          m.clusterId.length > 0 &&
          typeof m.confidence === 'number',
      )
      .map((m) => {
        // Normalize: keep stableClusterId only when it's a non-empty string.
        // Old rows (persisted before this field existed) simply lack it → the
        // grouping path treats absence as "no stable id" (falls back to
        // clusterId/title edges), never crashes.
        const out: ClusterMembership = { clusterId: m.clusterId, confidence: m.confidence };
        if (typeof m.stableClusterId === 'string' && m.stableClusterId.length > 0) {
          out.stableClusterId = m.stableClusterId;
        }
        return out;
      });
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
    .map((m) => {
      const out: ClusterMembership = { clusterId: m.clusterId, confidence: m.confidence };
      // Thread stableClusterId through the persisted shape (omitted when absent
      // so rows without one keep their exact prior canonical encoding).
      if (m.stableClusterId) out.stableClusterId = m.stableClusterId;
      return out;
    })
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

/** One inverted matchMeta entry for an article (persona-v3 path). */
export interface MatchedTopicMeta {
  topicId: string | null;
  text: string;
  vectorScore?: number | null;
  stableClusterId?: string | null;
}

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
  /** articleId → stable cluster id (server's largest-cluster rule). */
  stableClusterId?: Map<string, string>;
}

/** Pick the article's stable cluster id: prefer the server's largest-cluster
 *  rule (matchMeta / headline), else the first non-empty membership stable id. */
function pickStableClusterId(
  a: ArticleWithClusters,
  fromMeta: string | undefined,
): string | null {
  if (fromMeta) return fromMeta;
  for (const c of a.clusters ?? []) {
    if (c.stableClusterId) return c.stableClusterId;
  }
  return null;
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

    for (const { row, nextJson } of clusterRefreshes) {
      ops.push(row.prepareUpdate((r) => { r.clusterMembershipsJson = nextJson; }));
    }

    for (const a of toInsert) {
      const matched = personaMeta?.matchedTopics.get(a._id) ?? [];
      // Topic texts: persona path derives them from matchMeta entries; fallback
      // uses the caller-supplied text map. Kept for matched_topic_texts_json
      // (getArticleSuggestionsByTopicTexts / pruneOrphanedSuggestions readers).
      const topicTexts = personaMeta
        ? Array.from(new Set(matched.map((m) => m.text).filter((t) => t && t.length > 0)))
        : articleToTopicTexts.get(a._id) ?? [];
      const scope = personaMeta?.headlineScope?.get(a._id) ?? null;
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
        r.matchedTopicsJson = personaMeta
          ? JSON.stringify(
              matched.map((m) => ({
                topicId: m.topicId,
                text: m.text,
                ...(m.vectorScore != null ? { vectorScore: m.vectorScore } : {}),
              })),
            )
          : null;
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

export async function getTotalArticleSuggestionCount(): Promise<number> {
  return articleSuggestionsCol.query().fetchCount();
}

