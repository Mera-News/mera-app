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
import type { ForYouSuggestion } from '../../stores/for-you-store';
import type { StageCandidateRow } from '@/lib/news-harness/core/types';
// The ONE LOW-band top-headline cull predicate. Safe to import from a database
// service: `importance-filter` → `priority-order` is a two-module, PURE, RN-free
// leaf (no DB / expo / react-native imports and no edge back into this module),
// so it closes no cycle and drags nothing native into a harness-adjacent graph.
import { isCulledHeadlineRelevance } from '@/lib/feed-ordering/importance-filter';
import { normalizeKeyOrEmpty } from '@/lib/algorithms/normalize-key';
import { getFacts } from './fact-service';
import { describeFactPlaces } from '@/lib/news-harness/persona-management/fact-places';
import logger from '../../logger';
import { parseJsonArray, toForYouSuggestion, toStageRow, toGroupingRow, hasReadableReason, parseTopicIds, geoTextFromTags, placeValueFromTags } from './article-suggestion-mappers';
import type { SuggestionGroupingRow } from './article-suggestion-mappers';

const articleSuggestionsCol = database.get<ArticleSuggestionModel>('article_suggestions');
const articleSuggestionFactsCol = database.get<ArticleSuggestionFactModel>('article_suggestion_facts');
const factsCol = database.get<FactModel>('facts');
const topicsCol = database.get<TopicModel>('topics');

/** factId → fact-level weight multiplier (null/undefined ⇒ 1.0). Used by the
 *  orchestrators to compute topic effectiveWeight = topic.weight × factWeight. */
export async function getFactWeightById(): Promise<Map<string, number>> {
  const facts = await factsCol.query().fetch();
  const m = new Map<string, number>();
  for (const f of facts) m.set(f.id, f.weight ?? 1);
  return m;
}

/**
 * Resolve the owning fact for each topic id via the persona-v3 `topics` table
 * (topics.fact_id), replacing the old `resolveFactsByTopicTexts` scan of
 * fact.metadata.topics for the persona-v3 path. Returns topicId → factId for
 * topics that have an owning fact (headline/global topics with no fact_id are
 * simply absent → no fact link, which the reason path handles via the headline
 * label).
 */
export async function resolveFactsByTopicIds(
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

/**
 * Returns the ids of every article_suggestion row on-device. Since the WMDB
 * row id equals the server `_id`, these ids are directly diffable against
 * the server's id set.
 */
export async function getLocalSuggestionServerIds(): Promise<string[]> {
  const rows = await articleSuggestionsCol.query().fetch();
  return rows.map((r) => r.id);
}

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

// Canonical home is now lib/news-harness/core/types.ts; re-exported here so
// importers of ScoringCandidate from this service keep working unchanged.
import type { ScoringCandidate } from '@/lib/news-harness/core/types';

export type { ScoringCandidate };

/** A matched fact for scoring. `places` (names) reaches only the cloud prompts, through
 *  relatedFactLine; Kev and the on-device note read `statement` alone. */
function relatedFactOf(fact: FactModel): ScoringCandidate['relatedFacts'][number] {
  const places = describeFactPlaces({ statement: fact.statement, metadata: fact.metadata });
  return places ? { id: fact.id, statement: fact.statement, places } : { id: fact.id, statement: fact.statement };
}

/** Unscored rows, newest published first: what scoring reads next, so the day
 *  after a reading hold goes to today's news. Never gated by the hold (the
 *  dispatch site is); bookkeeping callers need every row. */
export async function getUnscoredSuggestionsWithFacts(
  limit?: number,
): Promise<ScoringCandidate[]> {
  const newestFirst = [
    Q.where('status', ArticleSuggestionStatus.Unscored),
    Q.sortBy('first_pub_date', Q.desc),
  ];
  const rows = await (limit !== undefined
    ? articleSuggestionsCol.query(...newestFirst, Q.take(limit)).fetch()
    : articleSuggestionsCol.query(...newestFirst).fetch());
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

  const factsBySuggestionId = new Map<string, ScoringCandidate['relatedFacts']>();
  for (const link of links) {
    const fact = factById.get(link.factId);
    if (!fact) continue;
    const bucket = factsBySuggestionId.get(link.articleSuggestionId) ?? [];
    bucket.push(relatedFactOf(fact));
    factsBySuggestionId.set(link.articleSuggestionId, bucket);
  }

  return rows.map((row) => ({
    id: row.id,
    titleEn: row.titleEn,
    descriptionEn: row.descriptionEn,
    countryCode: row.countryCode,
    publicationName: row.publicationName,
    languageCode: row.languageCode,
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

  const factsBySuggestionId = new Map<string, ScoringCandidate['relatedFacts']>();
  for (const link of links) {
    const fact = factById.get(link.factId);
    if (!fact) continue;
    const bucket = factsBySuggestionId.get(link.articleSuggestionId) ?? [];
    bucket.push(relatedFactOf(fact));
    factsBySuggestionId.set(link.articleSuggestionId, bucket);
  }

  return rows.map((row) => ({
    id: row.id,
    titleEn: row.titleEn,
    descriptionEn: row.descriptionEn,
    countryCode: row.countryCode,
    publicationName: row.publicationName,
    languageCode: row.languageCode,
    userTopicIds: parseTopicIds(row.matchedTopicTextsJson),
    relatedFacts: factsBySuggestionId.get(row.id) ?? [],
    relevance: row.relevance,
    meta: toStageRow(row),
  }));
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

/** All currently-unscored rows as grouping rows, newest published first: the
 *  gate keeps this order into `enqueueIds`, so it is cloud dispatch order. */
export async function getUnscoredGroupingRows(): Promise<SuggestionGroupingRow[]> {
  const rows = await articleSuggestionsCol
    .query(Q.where('status', ArticleSuggestionStatus.Unscored), Q.sortBy('first_pub_date', Q.desc))
    .fetch();
  return rows
    .filter((r) => r.status === ArticleSuggestionStatus.Unscored)
    .map(toGroupingRow);
}

/**
 * Score donors for sibling propagation: status not Unscored, Excluded or
 * AlreadyRead, a verdict (relevance > 0 OR scored_at set), AND
 * (scored_at >= sinceMs OR created_at >= sinceMs). The verdict clause drops the
 * verdict-less zeros written by `batchMarkAsScoredByIds` (relevance 0, scored_at
 * null), not a REAL zero verdict: a story's representative scored 0 donates, so
 * its siblings are not re-elected and re-scored every sync.
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
      Q.where('status', Q.notEq(ArticleSuggestionStatus.Excluded)),
      Q.where('status', Q.notEq(ArticleSuggestionStatus.AlreadyRead)),
      Q.or(Q.where('relevance', Q.gt(0)), Q.where('scored_at', Q.notEq(null))),
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
        r.status !== ArticleSuggestionStatus.Excluded &&
        r.status !== ArticleSuggestionStatus.AlreadyRead &&
        (r.relevance > 0 || r.scoredAt != null) &&
        ((typeof r.scoredAt === 'number' && r.scoredAt >= sinceMs) ||
          r.createdAt.getTime() >= sinceMs),
    )
    .map(toGroupingRow);
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
 * Find the newest local suggestion for an ARTICLE id (returns null if none).
 *
 * The retention path's lookup: a followed story is created from a
 * `FeedbackSubject`, which carries no description and no article URL, so the
 * keep has to reach for the local row before the 48h prune takes it. Unlike
 * {@link getReasonedSuggestionIdForArticle} this does NOT require a reason — a
 * reason-less row still holds the URL and description that make the article
 * openable, which is the only thing retention needs.
 */
export async function getSuggestionByArticleId(
  articleId: string,
): Promise<ForYouSuggestion | null> {
  if (!articleId) return null;
  try {
    const rows = await articleSuggestionsCol
      .query(Q.where('article_id', articleId), Q.sortBy('created_at', Q.desc))
      .fetch();
    // Mirror the SQL in JS so the result does not depend on the query engine
    // (and the predicate-ignoring test double stays honest).
    const row = rows.find((r) => r.articleId === articleId);
    if (!row) return null;
    const factIds = await loadFactIdsBySuggestion([row.id]);
    return toForYouSuggestion(row, factIds.get(row.id) ?? []);
  } catch {
    return null;
  }
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
 * Strict twin of getSuggestionByServerId: null ONLY for a missing row, any other
 * failure rethrows. For callers that act on "confirmed gone" (the detail screen
 * purges the card), where a transient read error must not look like a missing row.
 */
export async function findSuggestionByServerId(serverId: string): Promise<ForYouSuggestion | null> {
  try {
    const row = await articleSuggestionsCol.find(serverId);
    const factIds = await loadFactIdsBySuggestion([serverId]);
    return toForYouSuggestion(row, factIds.get(serverId) ?? []);
  } catch (err) {
    // ponytail: 3 copies of the missing-record test (here, saved-article-suggestion-service, inference-results.isRecordNotFoundError); P4 dedupes
    if (/Record\s+\S+\s+not\s+found/i.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
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
  /** Most specific place the article is tagged with, as DISPLAY prose — the
   *  feedback tree's `from_context_geo` placeholder ("More news from this
   *  place") and its `{{place}}` label variable. */
  geoText: string | null;
  /** The same tag's own field, VERBATIM — the feedback tree's
   *  `from_context_place` placeholder, i.e. the token a structured `place`
   *  filter compares against. See {@link placeValueFromTags}. */
  placeValue: string | null;
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
  const geoTags = parseJsonArray<{ city?: string; region?: string; countryCode?: string }>(
    row.geoTagsJson,
  );
  const geoText = geoTextFromTags(geoTags);
  // The same tag's own field, uncooked — the `place` FILTER's value, which
  // `geoText` cannot be (it resolves a supranational code to prose). Derived
  // here rather than from the projected suggestion so it is available on every
  // surface that has a ROW, including the ones whose ForYouSuggestion
  // projection carries no `geoTags` at all (e.g. a saved card).
  const placeValue = placeValueFromTags(geoTags);

  return {
    suggestion,
    matchedTopicTexts,
    linkedFacts,
    entities,
    category,
    clusterSize,
    geoText,
    placeValue,
  };
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
      const norm = normalizeKeyOrEmpty(row.publicationName);
      if (norm) names.add(norm);
    }
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'article-suggestion', method: 'getDistinctSuggestionPublicationNames' },
    });
  }
  return names;
}
