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
// The ONE LOW-band top-headline cull predicate. Safe to import from a database
// service: `importance-filter` → `priority-order` is a two-module, PURE, RN-free
// leaf (no DB / expo / react-native imports and no edge back into this module),
// so it closes no cycle and drags nothing native into a harness-adjacent graph.
import { isCulledHeadlineRelevance } from '@/lib/feed-ordering/importance-filter';
// The note-vs-article grounding check. Pure, RN-free, no edge back into this
// module — same import-safety argument as `isCulledHeadlineRelevance` above.
import { isReasonGrounded } from '@/lib/news-harness/article-pipeline/reason-grounding';
import { getSetting, setSetting, deleteSetting } from './setting-service';
/**
 * Is relevance v3 the scorer producing scores RIGHT NOW? Stamped onto each row
 * at write time so the render gate can later be chosen per row rather than from
 * whatever the flag happens to be at read time (see `gateForRow`).
 *
 * ALWAYS FALSE NOW — the v3 scorer is retired, so nothing this app writes is
 * v3-vintage. The stamp is NOT deleted along with it, and that is the whole
 * point: a device that ran the beta can hold v3-scored rows for up to the 48h
 * feed window, and one of them can be RE-scored (score propagation, a re-run
 * after a failed batch). Dropping the write would leave such a row carrying a
 * stale `true` next to a fresh v1-vintage score, gating it at 0.55 — silently
 * deleting a row that should render. Writing `false` retires the vintage with
 * the score it describes.
 */
function isRelevanceV3Active(): boolean {
  return false;
}
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
    // Only carried when the label agrees — a stale country on a GLOBAL row
    // would be worse than none.
    headlineCountryCode: headlineScope === 'COUNTRY' ? row.headlineCountryCode ?? null : null,
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
    headlineCountryCode: row.headlineCountryCode,
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
  //
  // The `reason_pending`-ONLY predicate (rather than "any non-unscored status
  // without a reason") is what keeps terminally `excluded` rows out of
  // retryMissingReasons / enqueueOrphanedReasons: an excluded row has no reason
  // and will never get one, so a status-notEq(unscored) predicate here would
  // re-spend LLM calls on it forever. Do not widen this query.
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
  countryCode: string | null; // publishing country, ISO alpha-3 (as stored) — geo/language priority
  languageCode: string | null; // article/publication language (may be a full tag) — geo/language priority
  /** Scorer vintage (schema v50). Carried here because these rows act as
   *  score-propagation DONORS: the recipient inherits this row's `relevance`,
   *  so it must inherit the gate that relevance was calibrated for too.
   *  Optional so the existing grouping-row fixtures keep compiling. */
  scoredWithV3?: boolean | null;
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
    countryCode: row.countryCode,
    languageCode: row.languageCode,
    // Normalised like the `loadSuggestions` mapper: SQLite returns 0/1.
    scoredWithV3: row.scoredWithV3 === true || (row.scoredWithV3 as unknown) === 1,
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
 * Score donors for sibling propagation: status != Unscored, relevance > 0, AND
 * (scored_at >= sinceMs OR created_at >= sinceMs). The relevance > 0 filter
 * excludes the ineligible tombstones written by `batchMarkAsScoredByIds`
 * (relevance=0), which carry no real scoring signal and would otherwise look
 * like a confident "not relevant" donor.
 *
 * BUG FIX (was `created_at >= sinceMs` only): prod logs showed
 * `propagated 0, held back N` every cycle — a row scored minutes ago but
 * created before the 48h lookback window never qualified as a donor, so no
 * group ever had one. The two clauses now cover both cases a donor can arise
 * from:
 *   - `scored_at >= sinceMs`  — the fix. A row scored recently is a fresh,
 *     trustworthy signal regardless of how old the underlying article is.
 *   - `created_at >= sinceMs` — kept for rows that themselves inherited a
 *     score via propagation (`batchPropagateScores`), which may leave
 *     `scored_at` null (see that function's status handling) while still
 *     carrying a copied relevance + reason. These were eligible donors before
 *     this fix and must stay eligible — the `OR` makes the change strictly
 *     additive: no row that qualified before now fails to qualify.
 */
export async function getScoredDonorRows(sinceMs: number): Promise<SuggestionGroupingRow[]> {
  const rows = await articleSuggestionsCol
    .query(
      Q.where('status', Q.notEq(ArticleSuggestionStatus.Unscored)),
      // A `reason_skipped` row is NEVER a donor. It carries a real, renderable
      // relevance and NO reason by design, so donating it would hand every
      // same-story sibling a renderable score with a blank note — and, since a
      // reason-less recipient lands in `reason_pending`, re-spend the very LLM
      // call the gate skipped, once per sibling. `pickDonor` prefers a donor
      // that HAS a reason, but that is a preference: a group whose only donor is
      // gated would still propagate. This is the guarantee.
      Q.where('status', Q.notEq(ArticleSuggestionStatus.ReasonSkipped)),
      Q.where('relevance', Q.gt(0)),
      Q.or(
        Q.where('scored_at', Q.gte(sinceMs)),
        Q.where('created_at', Q.gte(sinceMs)),
      ),
    )
    .fetch();
  // Same defensive re-filter as above — the fake query() ignores Q.where.
  return rows
    .filter(
      (r) =>
        r.status !== ArticleSuggestionStatus.Unscored &&
        r.status !== ArticleSuggestionStatus.ReasonSkipped &&
        r.relevance > 0 &&
        ((typeof r.scoredAt === 'number' && r.scoredAt >= sinceMs) ||
          r.createdAt.getTime() >= sinceMs),
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
 * THE choke point for "may this sentence be persisted onto this row?".
 *
 * Every path that writes `reason` funnels through here, which is the whole
 * design: the three ways a foreign sentence can reach a row (positional batch
 * decode, propagated donor reason, a model echoing a prompt exemplar) have
 * nothing in common upstream, but they all end at a `prepareUpdate` in this
 * file. Checking here costs one comparison per write and cannot be bypassed by
 * adding a fourth producer later.
 *
 * The article side is read off the ROW being written rather than passed in by
 * the caller. That is deliberate — `saveScoringResult` and `saveReason` take
 * only an id and a string, and threading title/description/tags through every
 * call site (and through the E2EE job boundary) would be a wide change for a
 * value the row already holds. It also means the comparison is against the
 * article as PERSISTED, which is exactly the article the reader will see next
 * to the note.
 *
 * Rejection is logged, not thrown: a wrong note is a product defect, not a
 * write failure, and the row still needs its score. The caller's own
 * empty-reason branch then lands it on `reason_pending`, where the existing
 * orphaned-reason sweep can earn it a real one.
 */
function groundedReasonFor(
  row: ArticleSuggestionModel,
  reason: string,
  /** Which writer is asking — carried into the log so a rejection tells you
   *  WHICH mechanism produced the foreign sentence, which is the open question
   *  this whole change exists to answer. */
  source: 'score' | 'reason-sweep' | 'propagation',
): string {
  if (reason.length === 0) return reason;
  const geoTags = parseJsonArray<{ city?: string; region?: string; countryCode?: string }>(
    row.geoTagsJson,
  ).flatMap((g) =>
    [g?.city, g?.region, g?.countryCode].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    ),
  );
  const entities = parseJsonArray<string>(row.entitiesJson).filter(
    (e): e is string => typeof e === 'string' && e.length > 0,
  );
  const grounded = isReasonGrounded(reason, {
    title: row.titleEn,
    description: row.descriptionEn,
    entities,
    geoTags,
  });
  if (grounded) return reason;
  logger.warn('[article-suggestion-service] dropped an ungrounded reason', {
    source,
    suggestionId: row.id,
    title: (row.titleEn ?? '').slice(0, 80),
    reason: reason.slice(0, 120),
  });
  return '';
}

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
  // An ungrounded note becomes '' here, which the status expression below then
  // reads as "no reason yet" — so the row lands on `reason_pending` unless the
  // caller already declared none was owed (`reasonSkipped`).
  const grounded = groundedReasonFor(row, reason, 'score');
  await database.write(async () => {
    await row.update((r) => {
      r.relevance = relevance;
      // Stamp the scorer VINTAGE alongside the score, UNCONDITIONALLY (unlike
      // `scored_at` below, which is a once-only "when did this row leave
      // unscored"). This is a property of THIS score: if a row is ever
      // re-scored by a different scorer, the gate must move with it.
      r.scoredWithV3 = isRelevanceV3Active();
      r.reason = grounded;
      if (computedScore !== undefined) r.computedScore = computedScore;
      if (rawScore !== undefined) r.rawScore = rawScore;
      if (scoreComponentsJson !== undefined) r.scoreComponentsJson = scoreComponentsJson;
      // Round-3: stamp scored_at the moment the row leaves `unscored`. Only set
      // it once (a later reason write must not slide the "added" time forward).
      if (r.scoredAt == null) r.scoredAt = Date.now();
      r.status =
        grounded.length > 0 || reasonSkipped
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
          // See `saveScore`: the vintage is a property of this score, so it is
          // written unconditionally rather than once-only like `scored_at`.
          r.scoredWithV3 = isRelevanceV3Active();
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
 * How many stored notes are SHARED between articles.
 *
 * WHY THIS IS THE READOUT THAT MATTERS. When a note turns up describing a
 * different article than the one it sits on, there are three candidate causes
 * and they are otherwise indistinguishable after the fact: a batch decode that
 * zipped results to articles by array position, a propagated donor reason, or a
 * model that echoed one of its prompt's worked examples. Only ONE of them
 * duplicates a string — propagation copies the donor's sentence byte for byte,
 * so its fingerprint is the same `reason` on two article ids. A decode shift or
 * a confabulation produces a sentence that exists exactly once. So a non-zero
 * `sharedNoteGroups` says "propagation", and a zero says "look at the decoder
 * or the prompt" — without needing an extra column or a single write.
 *
 * Note that sharing is NORMAL and expected in moderation: propagation exists on
 * purpose, so story siblings legitimately share a note. It is the SIZE and the
 * membership of a group that indict it — a group spanning articles that are not
 * the same story is a grouping false positive.
 */
export interface SharedNoteBreakdown {
  /** Rows carrying a non-empty note at all (the denominator). */
  rowsWithNote: number;
  /** Distinct note strings among them. */
  distinctNotes: number;
  /** Notes appearing on 2+ article ids. Zero ⇒ nothing was propagated. */
  sharedNoteGroups: number;
  /** Rows whose note is shared with at least one other row. */
  rowsSharingANote: number;
  /** Size of the biggest shared group. */
  largestGroupSize: number;
  /** The biggest group, for eyeballing: is this really one story? Truncated —
   *  the note to 120 chars, the titles to 80, and at most 6 members. */
  largestGroup: { note: string; titles: string[] } | null;
}

/**
 * Count how many stored notes are shared across articles. See
 * {@link SharedNoteBreakdown} for why this is the diagnostic that discriminates
 * propagation from a decode shift.
 *
 * ON-DEMAND ONLY (the Observability screen's refresh), like
 * {@link getScoringModeBreakdown} beside it: it fetches every row carrying a
 * note. Read-only, and it never throws — a caller renders '—' on failure.
 */
export async function getSharedNoteBreakdown(): Promise<SharedNoteBreakdown> {
  const empty: SharedNoteBreakdown = {
    rowsWithNote: 0,
    distinctNotes: 0,
    sharedNoteGroups: 0,
    rowsSharingANote: 0,
    largestGroupSize: 0,
    largestGroup: null,
  };
  // `reason` is NOT NULL with '' for absent, so an inequality against '' is the
  // whole predicate — no null branch needed.
  const rows = await articleSuggestionsCol
    .query(Q.where('reason', Q.notEq('')))
    .fetch();
  if (rows.length === 0) return empty;

  const byNote = new Map<string, ArticleSuggestionModel[]>();
  for (const row of rows) {
    const note = (row.reason ?? '').trim();
    if (note.length === 0) continue;
    const bucket = byNote.get(note);
    if (bucket) bucket.push(row);
    else byNote.set(note, [row]);
  }

  let sharedNoteGroups = 0;
  let rowsSharingANote = 0;
  let largest: ArticleSuggestionModel[] = [];
  let largestNote = '';
  for (const [note, members] of byNote) {
    if (members.length < 2) continue;
    sharedNoteGroups++;
    rowsSharingANote += members.length;
    if (members.length > largest.length) {
      largest = members;
      largestNote = note;
    }
  }

  return {
    rowsWithNote: rows.length,
    distinctNotes: byNote.size,
    sharedNoteGroups,
    rowsSharingANote,
    largestGroupSize: largest.length,
    largestGroup:
      largest.length > 0
        ? {
            note: largestNote.slice(0, 120),
            titles: largest.slice(0, 6).map((r) => (r.titleEn ?? '').slice(0, 80)),
          }
        : null,
  };
}

/** Whether each stored row's article arrived TAGGED. Counted from the `mode`
 *  recorded in the `score_components_json` audit — no parallel record, no extra
 *  column.
 *
 *  Named for the routing it used to describe. Since the judge was removed every
 *  row is scored by the LLM, so this is a property of the ARTICLE, not of the
 *  scorer. */
export interface ScoringModeBreakdown {
  /** The article carried geo/entity/event tags (`math`). */
  math: number;
  /** The article was untagged (`backstop`). */
  backstop: number;
  /** Scored, but the audit blob is missing, unparseable, or predates the `mode`
   *  field. Reported rather than folded into either bucket — attributing these
   *  to a path we cannot actually observe is exactly the kind of quiet lie this
   *  diagnostic exists to avoid. */
  unknown: number;
}

/**
 * Count the stored suggestions by whether their article carried server tags.
 *
 * ON-DEMAND ONLY (the Observability screen's refresh). It reads every scored
 * row's audit JSON, so it is deliberately absent from the render, ingest and
 * scroll paths. Read-only.
 *
 * This is how the tagging backfill becomes observable: rows move from
 * `backstop` to `math` as the server starts emitting
 * `geo_tags`/`entities`/`event_type`. Rows scored before the
 * `USE_ARTICLE_TAGS` blanking was removed all read `backstop`, whatever their
 * article actually carried.
 */
export async function getScoringModeBreakdown(): Promise<ScoringModeBreakdown> {
  const out: ScoringModeBreakdown = { math: 0, backstop: 0, unknown: 0 };
  const rows = await articleSuggestionsCol
    .query(Q.where('scored_at', Q.notEq(null)))
    .fetch();
  for (const row of rows) {
    if (!row.scoreComponentsJson) {
      out.unknown++;
      continue;
    }
    try {
      const { mode } = JSON.parse(row.scoreComponentsJson) as RelevanceComponents;
      if (mode === 'math') out.math++;
      else if (mode === 'backstop') out.backstop++;
      else out.unknown++;
    } catch {
      out.unknown++;
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
  // Delete-tolerant: a row can be hard-deleted underneath an in-flight scoring
  // batch (48h TTL sweep, clearSuggestions, pruneOrphanedSuggestions, migration
  // wipes). A bare find(id) throws `Record ... not found` and rejects the whole
  // Promise.all, so resolve missing rows to null and update only the survivors.
  const rows = (
    await Promise.all(
      ids.map((id) => articleSuggestionsCol.find(id).catch(() => null)),
    )
  ).filter((r): r is ArticleSuggestionModel => r != null);
  if (rows.length === 0) return;
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
 * Mark rows as terminally EXCLUDED by a hard "not interested" filter — one
 * batched write, no scoring of any kind. Relevance/rawScore/computedScore are
 * zeroed and the reason cleared so every downstream gate reads them as
 * invisible: the render gate needs relevance > 0.3, `getScoredDonorRows` needs
 * relevance > 0, and `getScoredSuggestionsWithoutReasons` only ever selects
 * `reason_pending`, so an excluded row is never swept for a missing reason.
 *
 * `scored_at` is stamped only when still null — the column means "when this row
 * left `unscored`", and a purge sweep over already-scored rows must not slide
 * an existing "added" time forward.
 *
 * Delete-tolerant, exactly like batchMarkAsScoredByIds: a row can be
 * hard-deleted underneath an in-flight batch, and a bare find() would reject
 * the whole write.
 */
export async function batchMarkExcluded(
  ids: string[],
  nowMs: number = Date.now(),
): Promise<void> {
  if (ids.length === 0) return;
  const rows = (
    await Promise.all(
      ids.map((id) => articleSuggestionsCol.find(id).catch(() => null)),
    )
  ).filter((r): r is ArticleSuggestionModel => r != null);
  if (rows.length === 0) return;
  await database.write(async () => {
    await database.batch(
      rows.map((row) =>
        row.prepareUpdate((r) => {
          r.relevance = 0;
          r.reason = '';
          r.rawScore = 0;
          r.computedScore = 0;
          r.status = ArticleSuggestionStatus.Excluded;
          if (r.scoredAt == null) r.scoredAt = nowMs;
        }),
      ),
    );
  });
}

/**
 * The un-exclude direction (D12c): send rows back to `unscored` so the next
 * scoring pass treats them as new. Used ONLY by the sweep that runs when a hard
 * filter is retired, and only for rows the sweep has already re-screened
 * against every still-active hard filter. Scores are cleared so a stale 0 can
 * never be mistaken for a real verdict.
 *
 * Delete-tolerant (see batchMarkExcluded).
 */
export async function batchResetToUnscored(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = (
    await Promise.all(
      ids.map((id) => articleSuggestionsCol.find(id).catch(() => null)),
    )
  ).filter((r): r is ArticleSuggestionModel => r != null);
  if (rows.length === 0) return;
  await database.write(async () => {
    await database.batch(
      rows.map((row) =>
        row.prepareUpdate((r) => {
          r.relevance = 0;
          r.reason = '';
          r.rawScore = null;
          r.computedScore = null;
          r.scoreComponentsJson = null;
          r.scoredAt = null;
          r.status = ArticleSuggestionStatus.Unscored;
        }),
      ),
    );
  });
}

/**
 * Stage rows for the retroactive hard-filter sweep. `excluded: false` (default)
 * returns every row a hard filter could still newly kill; `excluded: true`
 * returns the already-excluded rows the un-exclude sweep re-screens.
 *
 * Deliberately does NOT load `article_suggestion_facts`: hard screening reads
 * only the ScoredCandidateInput fields, and the fact links exist purely for the
 * legacy backstop payload.
 */
export async function getStageRowsForScreening(
  opts: { excluded?: boolean } = {},
): Promise<StageCandidateRow[]> {
  const wantExcluded = opts.excluded === true;
  const rows = await articleSuggestionsCol
    .query(
      wantExcluded
        ? Q.where('status', ArticleSuggestionStatus.Excluded)
        : Q.where('status', Q.notEq(ArticleSuggestionStatus.Excluded)),
    )
    .fetch();
  // Defensive re-filter — the unit-test fake DB layer ignores Q.where.
  return rows
    .filter((r) => (r.status === ArticleSuggestionStatus.Excluded) === wantExcluded)
    .map(toStageRow);
}

/**
 * Stage rows for a SCOPED hard-filter screen: exactly these ids, minus the ones
 * already terminal `excluded` (re-screening them would be a no-op). This is the
 * cheap counterpart to `getStageRowsForScreening` — used by the propagation
 * reconcile, which knows precisely which rows just inherited a score and must
 * not pay for a full-table scan on every sync chunk.
 */
export async function getStageRowsByIds(ids: string[]): Promise<StageCandidateRow[]> {
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  const rows = await articleSuggestionsCol
    .query(Q.where('id', Q.oneOf(ids)))
    .fetch();
  // The unit-test fake DB layer doesn't evaluate Q.where predicates (see
  // mockDatabase.ts), so re-assert the id filter in memory too — same defensive
  // shape as getGroupingRowsByIds.
  return rows
    .filter((r) => idSet.has(r.id) && r.status !== ArticleSuggestionStatus.Excluded)
    .map(toStageRow);
}

/**
 * The CONVERGENCE half of the LOW-band top-headline cull: the ids of stored
 * headline rows (`headline_scope` set) that carry a scored relevance below the
 * MEDIUM band and are still renderable. Feed to `batchMarkExcluded`.
 *
 * The persist-time culls in the scoring paths are the primary gate; this exists
 * because two classes of row never pass through them:
 *   1. BACKFILL — rows persisted before the cull shipped are already on device
 *      and live out the full 48h TTL.
 *   2. PROPAGATION — `propagateToUnscoredSiblings` copies a donor's relevance
 *      onto a headline sibling and writes it terminal `complete` directly,
 *      bypassing the persist-time cull entirely.
 *
 * Scored statuses only: `unscored` has no verdict to judge yet, and `excluded`
 * is already terminal (re-marking it would be a pointless write).
 */
export async function getCullableLowHeadlineIds(): Promise<string[]> {
  const rows = await articleSuggestionsCol
    .query(Q.where('headline_scope', Q.notEq(null)))
    .fetch();
  // Defensive re-filter — the unit-test fake DB layer ignores Q.where (see
  // mockDatabase.ts), same shape as getStageRowsForScreening.
  return rows
    .filter(
      (r) =>
        r.headlineScope != null &&
        (r.status === ArticleSuggestionStatus.Complete ||
          r.status === ArticleSuggestionStatus.ReasonPending) &&
        isCulledHeadlineRelevance(r.relevance),
    )
    .map((r) => r.id);
}

/**
 * Mark already-scored rows as reason-skipped (no eligible facts/title) in one
 * batched write. Keeps existing relevance; reason stays '' and status becomes
 * terminal `complete`.
 */
export async function batchMarkReasonSkipped(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  // Delete-tolerant (see batchMarkAsScoredByIds): a row deleted mid-flight must
  // not reject the whole batch — update only the rows still present. This is the
  // writer behind discardLowRelevance, the path the pipeline's apply step drove
  // forever when a row vanished (MERA-APP-53/55).
  const rows = (
    await Promise.all(
      ids.map((id) => articleSuggestionsCol.find(id).catch(() => null)),
    )
  ).filter((r): r is ArticleSuggestionModel => r != null);
  if (rows.length === 0) return;
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
 * Terminal write for the v4 tag reason-gate: the row KEEPS its real relevance
 * and moves to `reason_skipped`.
 *
 * Deliberately NOT `batchMarkReasonSkipped` above, which sets `complete` — that
 * one is for rows whose score already put them under the render gate, so
 * `complete` is harmless (they are invisible on score alone). A gated row is
 * ABOVE the gate; marking it `complete` would render it with a blank note.
 *
 * Relevance is untouched on purpose. The previous implementation overwrote it
 * with `feedVerifierDemoteScore` (0.28) to force invisibility, which threw away
 * a score an LLM call had just produced and misreported "we chose not to write a
 * note" as "this scored badly". Invisibility now comes from the status.
 */
export async function batchMarkGateSkipped(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  // Delete-tolerant, same rationale as batchMarkReasonSkipped.
  const rows = (
    await Promise.all(
      ids.map((id) => articleSuggestionsCol.find(id).catch(() => null)),
    )
  ).filter((r): r is ArticleSuggestionModel => r != null);
  if (rows.length === 0) return;
  await database.write(async () => {
    await database.batch(
      rows.map((row) =>
        row.prepareUpdate((r) => {
          r.status = ArticleSuggestionStatus.ReasonSkipped;
        }),
      ),
    );
  });
}

/**
 * One batched write applying propagated scores (sibling stories inheriting a
 * donor's relevance + reason).
 *
 * STATUS IS CONDITIONAL, and the condition is "was a reason actually
 * propagated?":
 *   - reason non-empty → `complete`. Terminal, and the orphaned-reasons sweep
 *     never touches it — which is the entire point: propagation just saved that
 *     row's LLM reason call, and re-spending it would defeat the mechanism.
 *   - reason EMPTY     → `reason_pending`, and `reason` is left untouched.
 *
 * This was an UNCONDITIONAL `complete`, justified by that same "don't re-spend
 * the saved LLM calls" argument. The argument only holds when a reason was
 * actually copied. `getScoredDonorRows` qualifies donors on
 * `status != unscored ∧ relevance > 0` with NO reason predicate, so a donor
 * still sitting in `reason_pending` (scored, reason not back yet) is fully
 * eligible and donates `''`. Stamping `complete` on that copy produced a row
 * that was VISIBLE (the inherited relevance clears the render gate),
 * REASON-LESS (so the card fell back to its fact chips), and UNREACHABLE by
 * `getScoredSuggestionsWithoutReasons`, which selects `reason_pending` ONLY.
 * That is permanently broken, not transient — the donor later self-corrects via
 * `saveReason` while the propagated sibling never does. Leaving it
 * `reason_pending` costs exactly one reason call and hands the row to the
 * recovery sweep that already exists (`enqueueOrphanedReasons` keeps rows with
 * `relevance > REASON_RELEVANCE_THRESHOLD`, which an inherited above-gate
 * relevance satisfies). Do not restore the unconditional write.
 *
 * `reason` is deliberately NOT written when empty, so a propagation from a
 * reason-less donor can never CLEAR a reason the row already had. That keeps
 * reason-presence monotonic — a card can gain an explanation, never lose one.
 *
 * A donor sentence that fails `groundedReasonFor` against the RECIPIENT's
 * article is treated exactly like an empty one (see the note at the call site).
 * The relevance still propagates either way — grouping is evidence about the
 * story, and holding a score back would silently hide the row.
 *
 * Mirrors batchMarkAsScoredByIds's prepareUpdate+batch shape.
 */
/** One inherited score. `scoredWithV3` is the DONOR's scorer vintage — it
 *  travels with the score so the recipient is gated at the cutoff that score
 *  was calibrated for (see `gateForRow`, lib/stores/fact-rows-selector.ts).
 *  Null/absent = legacy vintage. */
export interface PropagateEntry {
  id: string;
  relevance: number;
  reason: string;
  scoredWithV3?: boolean | null;
}

export async function batchPropagateScores(
  entries: PropagateEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  // Delete-tolerant (see batchMarkAsScoredByIds): skip entries whose row was
  // deleted mid-flight rather than rejecting the whole batch.
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const rows = (
    await Promise.all(
      entries.map((e) => articleSuggestionsCol.find(e.id).catch(() => null)),
    )
  ).filter((r): r is ArticleSuggestionModel => r != null);
  if (rows.length === 0) return;
  await database.write(async () => {
    await database.batch(
      rows.map((row) => {
        const entry = entryById.get(row.id)!;
        // `?? ''` is defensive only — the type says string, but this value comes
        // from a donor ROW, and a partially-written row can carry null.
        const propagatedReason = (entry.reason ?? '').trim();
        // The donor's sentence is checked against THIS row's article, not the
        // donor's. That is the whole point: story grouping is union-find, so a
        // transitive merge (A–B by cluster id, B–C by title overlap) can hand C
        // a verdict written about A. The relevance still propagates — grouping
        // is evidence about the STORY — but a sentence naming A's event, place
        // or policy is simply false on C's card, and this is where that is
        // caught. A rejected donor leaves the row exactly where a reason-less
        // donor leaves it: `reason_pending`, owed its own call.
        const grounded = groundedReasonFor(row, propagatedReason, 'propagation');
        return row.prepareUpdate((r) => {
          r.relevance = entry.relevance;
          // The gate is chosen by the scorer that produced the SCORE, and this
          // row's score is the donor's. Leaving the recipient's own vintage in
          // place would judge an inherited v3 number at the legacy 0.4 gate.
          // `?? null` keeps pre-v50 donors reading as legacy.
          r.scoredWithV3 = entry.scoredWithV3 ?? null;
          if (grounded.length > 0) {
            r.reason = grounded;
            r.status = ArticleSuggestionStatus.Complete;
          } else {
            r.status = ArticleSuggestionStatus.ReasonPending;
          }
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
  // Dropped here, the row simply stays `reason_pending` and the sweep that
  // brought us here will try again — which is the right outcome: this path
  // exists precisely to fill a missing note, so a wrong one is no progress.
  const grounded = groundedReasonFor(row, reason, 'reason-sweep');
  await database.write(async () => {
    await row.update((r) => {
      r.reason = grounded;
      r.status =
        grounded.length > 0
          ? ArticleSuggestionStatus.Complete
          : ArticleSuggestionStatus.ReasonPending;
    });
  });
}

/**
 * Does this row carry a reason a reader could actually READ?
 *
 * `suggestion-detail`'s screen variant renders exactly one explanatory element
 * — `ArticleSuggestionContainer`'s `reasonBoxEl` (metaRow / title / aboveReason
 * / reasonBox / footer; note `factChipsEl` is CARD-only). So:
 *   - `excluded`        → relevance 0, no reason, never scored ⇒ nothing to show.
 *   - `unscored`        → `relevanceReady` false ⇒ the box doesn't render at all.
 *   - `reason_pending`  → the box renders a perpetual StreamingIndicator, not text.
 *   - `complete` + ''   → the box doesn't render (screen variant has no chips).
 * Only reason TEXT makes the reason screen worth landing on, so that — plus an
 * explicit `excluded` guard — is the whole gate. Deliberately NOT gated on
 * relevance: a relevance-0 row that still has reason text has the exact thing
 * the reader came for.
 */
function hasReadableReason(row: ArticleSuggestionModel): boolean {
  return (
    row.status !== ArticleSuggestionStatus.Excluded &&
    typeof row.reason === 'string' &&
    row.reason.trim().length > 0
  );
}

/**
 * Tap-time lookup: articleId → the server id of the newest suggestion for that
 * article that has a readable reason, or null.
 *
 * Deliberately the NARROWEST query that answers the question — one indexed
 * `article_id` hit, no fact joins, no topic parsing, no `toForYouSuggestion`
 * mapping (contrast `getSuggestionFeedbackContext`, which does all four). This
 * runs on every article tap on four surfaces, so it must stay a single index
 * probe over ~1 row.
 *
 * The Q predicates are mirrored by the JS filter below: the SQL narrows for
 * real, the JS makes the result independent of the query engine (and keeps the
 * predicate-ignoring test double honest).
 */
export async function getReasonedSuggestionIdForArticle(
  articleId: string,
): Promise<string | null> {
  if (!articleId) return null;
  const rows = await articleSuggestionsCol
    .query(
      Q.where('article_id', articleId),
      Q.where('status', Q.notEq(ArticleSuggestionStatus.Excluded)),
      Q.sortBy('created_at', Q.desc),
    )
    .fetch();
  // Newest-first; take the newest row that actually has a reason rather than
  // the newest row outright — a re-synced duplicate can land reason-less
  // alongside an older, fully-reasoned sibling.
  const hit = rows.find((r) => r.articleId === articleId && hasReadableReason(r));
  // The WatermelonDB `id` IS the server ArticleSuggestion `_id` (see the model
  // docstring) — that, NOT `articleId`, is what suggestion-detail resolves.
  return hit?.id ?? null;
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
  /** Story-cluster size (`max_cluster_size`) — the feedback tree's
   *  `cluster_size_gte` gate (e.g. "Browse related coverage"). */
  clusterSize: number | null;
  /** Most specific place the article is tagged with — the feedback tree's
   *  `from_context_geo` placeholder ("More news from this place"). */
  geoText: string | null;
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

  // Two more context fields the feedback tree gates/resolves on. Both were
  // already on the row and simply never read, which left
  // `nudge_browse_related` (cluster_size_gte) and every `from_context_geo`
  // leaf dead on EVERY surface, feed included.
  const clusterSize =
    typeof row.maxClusterSize === 'number' && Number.isFinite(row.maxClusterSize)
      ? row.maxClusterSize
      : null;
  const geoText = geoTextFromTags(
    parseJsonArray<{ city?: string; region?: string; countryCode?: string }>(row.geoTagsJson),
  );

  return {
    suggestion,
    matchedTopicTexts,
    linkedFacts,
    entities,
    category,
    clusterSize,
    geoText,
  };
}

/**
 * The most specific human place name across an article's geo tags
 * (city → region → country code), or null when nothing is nameable. One
 * definition shared by the local-suggestion path and the standalone-article
 * path (ArticleFeedbackPrompt) so the two can't name the same article's place
 * differently.
 */
export function geoTextFromTags(
  tags: { city?: string | null; region?: string | null; countryCode?: string | null }[],
): string | null {
  for (const tag of tags ?? []) {
    if (!tag) continue;
    const name = tag.city?.trim() || tag.region?.trim() || tag.countryCode?.trim();
    if (name) return name;
  }
  return null;
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
  /** UTC date string (`YYYY-MM-DD`) of the last daily-limit notice shown to
   *  the user. Persisted (not just in-memory) so the notice re-arms only once
   *  per UTC day and survives app restarts — see FeedSyncMachine's
   *  `daily-limit` branch. Absent/null = never shown. */
  dailyLimitNoticeDay?: string | null;
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
    // Same parse shape as `buildStageCandidateInput` above, so story-grouping's
    // entity edge and the scorer see byte-identical entity lists.
    entities: parseJsonArray<string>(row.entitiesJson).filter(
      (e): e is string => typeof e === 'string' && e.length > 0,
    ),
    // Same parse + same non-empty-countryCode filter as
    // `buildStageCandidateInput`, so a `place` filter and this row can never
    // disagree about which places an article carries.
    geoTags: parseJsonArray<{ city?: string; region?: string; countryCode?: string }>(
      row.geoTagsJson,
    )
      .filter((g) => g && typeof g.countryCode === 'string' && g.countryCode.length > 0)
      .map((g) => ({
        city: g.city ?? undefined,
        region: g.region ?? undefined,
        countryCode: g.countryCode as string,
      })),
    headlineScope:
      row.headlineScope === 'CITY' ||
      row.headlineScope === 'COUNTRY' ||
      row.headlineScope === 'GLOBAL'
        ? row.headlineScope
        : null,
    // Same guard as buildStageCandidateInput above: only carried when the label
    // agrees, since a stale country on a GLOBAL row is worse than none. Without
    // this line every COUNTRY row reaches the Dashboard with a null country, so
    // the per-country headline sections silently never render.
    headlineCountryCode:
      row.headlineScope === 'COUNTRY' ? row.headlineCountryCode ?? null : null,
    matchedTopics: parseMatchedTopicRefs(row.matchedTopicsJson),
    // Round-3 fact-rows fields.
    factIds,
    scoredAt: typeof row.scoredAt === 'number' ? row.scoredAt : null,
    // Scorer vintage (schema v50). Normalised to a strict boolean: SQLite hands
    // booleans back as 0/1, and `gateForRow` tests `=== true`, so a raw 1 would
    // silently fall through to the legacy gate.
    scoredWithV3: row.scoredWithV3 === true || (row.scoredWithV3 as unknown) === 1,
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
  /** articleId → uppercase ISO country code the COUNTRY-scope headline came
   *  from. Only populated for the article's WINNING headline scope, and only
   *  when that scope is COUNTRY — a GLOBAL headline has no owning country, so
   *  it is absent here rather than carrying a misleading code. */
  headlineCountryCode?: Map<string, string>;
  /** articleId → stable cluster id (server's largest-cluster rule). */
  stableClusterId?: Map<string, string>;
}

/** Serialize matched-topic entries into the stored matched_topics_json shape.
 *  Shared by the insert path and the P7e existing-row backfill so both write the
 *  identical format. */
function buildMatchedTopicsJson(matched: MatchedTopicMeta[]): string {
  return JSON.stringify(
    matched.map((m) => ({
      topicId: m.topicId,
      text: m.text,
      ...(m.vectorScore != null ? { vectorScore: m.vectorScore } : {}),
    })),
  );
}

/** True when a stored matched_topics_json holds no topics (null, empty string,
 *  or a JSON empty array) — the marker of a row persisted via the legacy
 *  topics-empty fallback. Unparseable non-empty values are treated as present so
 *  the P7e backfill never clobbers real data. */
function isMatchedTopicsJsonEmpty(json: string | null | undefined): boolean {
  if (!json) return true;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
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

  // Updates to already-persisted rows: a changed cluster membership and/or the
  // P7e matched-topics backfill. Each field is optional and applied only when
  // set, so an unchanged cluster is left alone while topics are healed and vice
  // versa.
  const existingUpdates: {
    row: ArticleSuggestionModel;
    nextClusterJson?: string;
    nextMatchedTopicsJson?: string;
  }[] = [];
  for (const a of fetched) {
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

    for (const { row, nextClusterJson, nextMatchedTopicsJson } of existingUpdates) {
      ops.push(
        row.prepareUpdate((r) => {
          if (nextClusterJson !== undefined) r.clusterMembershipsJson = nextClusterJson;
          if (nextMatchedTopicsJson !== undefined) r.matchedTopicsJson = nextMatchedTopicsJson;
        }),
      );
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

export async function getTotalArticleSuggestionCount(): Promise<number> {
  return articleSuggestionsCol.query().fetchCount();
}


/**
 * Distinct `publication_name` values present in the local suggestion cache,
 * normalized (lower-cased, whitespace-collapsed) and deduped.
 *
 * source-pref v47 (D5) — the CORROBORATION set for a named-publication
 * preference. `pubPref` matching is exact normalized-name equality, so a model
 * that invents "Times of India Group" would mint a row that shows up on the
 * Source-preferences screen and can never fire: a preference that looks live
 * and does nothing. Pairing this with `getTopVisitedPublications()` gives the
 * sanitizer names that provably exist in the USER'S OWN data, so an
 * uncorroborated proposal can be dropped outright (there is no keyword fallback
 * for a preference the way there is for a filter).
 *
 * Never throws: a read failure yields an empty set, which drops every named
 * proposal — the safe direction.
 */
export async function getDistinctSuggestionPublicationNames(): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const rows = await articleSuggestionsCol.query().fetch();
    for (const row of rows) {
      const norm = (row.publicationName ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
      if (norm) names.add(norm);
    }
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-suggestion', method: 'getDistinctSuggestionPublicationNames' },
    });
  }
  return names;
}

/**
 * Destroy suggestions that survive only because of topics that no longer exist.
 *
 * Deleting a fact removes the interest AND (since the cascade fix) its topics —
 * but the suggestions those topics retrieved stayed on the device forever.
 * They are not merely stale: the Dashboard resolves a suggestion to its section
 * through matched topic → fact, so a suggestion whose every matched topic is
 * gone can never render a section again. It occupies the local feed, counts
 * toward "analysed for you", and is re-read on every rebuild, for an interest
 * the user explicitly deleted. Measured 2026-08-03: a device that deleted all
 * but one fact carried 417 such rows and rendered an empty Dashboard.
 *
 * Conservative by construction — a row is destroyed ONLY when all three hold:
 *   1. it carries at least one matched topic with a real `topicId` (rows with
 *      no topic evidence are never judged here), AND
 *   2. none of those topic ids still exists, AND
 *   3. it is not a top-headline row (`headline_scope` set) — those belong to a
 *      scope section and never depended on a fact in the first place.
 *
 * Returns the number destroyed. Never throws: a failure here must not turn a
 * committed fact deletion into an error.
 */
export async function purgeSuggestionsForDeadTopics(
  liveTopicIds: Set<string>,
): Promise<number> {
  try {
    const rows = await articleSuggestionsCol.query().fetch();
    const doomed: ArticleSuggestionModel[] = [];
    for (const row of rows) {
      if (row.headlineScope) continue; // has a scope section regardless
      const refs = parseMatchedTopicRefs(row.matchedTopicsJson);
      const owned = refs.filter((r): r is { topicId: string; text: string } => !!r.topicId);
      if (owned.length === 0) continue; // no topic evidence — leave it alone
      if (owned.some((r) => liveTopicIds.has(r.topicId))) continue; // still owned
      doomed.push(row);
    }
    if (doomed.length === 0) return 0;

    // The join rows carry the suggestion id, so they must go in the same batch
    // or they outlive their parent as unreachable orphans of their own.
    const suggestionIds = new Set(doomed.map((r) => r.id));
    const joins = await articleSuggestionFactsCol.query().fetch();
    const doomedJoins = joins.filter((j) => suggestionIds.has(j.articleSuggestionId));

    await database.write(async () => {
      await database.batch([
        ...doomed.map((r) => r.prepareDestroyPermanently()),
        ...doomedJoins.map((j) => j.prepareDestroyPermanently()),
      ]);
    });
    return doomed.length;
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-suggestion', method: 'purgeSuggestionsForDeadTopics' },
    });
    return 0;
  }
}
