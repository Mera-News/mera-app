// Article Suggestion Service: row mappers and pure parsers.

import { ArticleSuggestionStatus } from '../article-suggestion-status';
import type ArticleSuggestionModel from '../models/ArticleSuggestion';
import type { ArticleWithClusters } from '../../generated/graphql-types';
import type { ForYouSuggestion, ClusterMembership } from '../../stores/for-you-store';
import type { StageCandidateRow } from '@/lib/news-harness/core/types';
import type { ScoredCandidateInput, MatchedTopicInput, HeadlineScope } from '@/lib/news-harness/scoring-engine/relevance';
import type { ArticleGeoTag } from '@/lib/news-harness/scoring-engine/geo';
import { supranationalName } from '@/lib/news-harness/scoring-engine/supranational-codes';
// The note-vs-article grounding check. Pure, RN-free, no edge back into this
// module — same import-safety argument as the `isCulledHeadlineRelevance` import in
// article-suggestion-reads.
import { isReasonGrounded } from '@/lib/news-harness/article-pipeline/reason-grounding';
import logger from '../../logger';

/** Effective-weight resolver for one topic id, supplied by the orchestrator
 *  (built from live topics × fact weights). */
export interface TopicWeightInfo {
  effectiveWeight: number;
  highPriority: boolean;
  locationId?: string | null;
}

export function parseJsonArray<T>(json: string | null | undefined): T[] {
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

/** Snapshot the persona-v3 scorer-input columns of a row (raw JSON). */
export function toStageRow(row: ArticleSuggestionModel): StageCandidateRow {
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
  /** Server story id (schema v56); null = no dedup edge. */
  storyKey?: string | null;
}

export function toGroupingRow(row: ArticleSuggestionModel): SuggestionGroupingRow {
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
    storyKey: row.storyKey ?? null,
  };
}

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
export function groundedReasonFor(
  row: ArticleSuggestionModel,
  reason: string,
  /** Which writer is asking — carried into the log so a rejection tells you
   *  WHICH mechanism produced the foreign sentence, which is the open question
   *  this whole change exists to answer. */
  source: 'score' | 'reason-sweep' | 'propagation',
): string {
  if (reason.trim().length === 0) return '';
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

/** `excluded` and `already_read` never render and no late writer may move a row out of them
 *  (a score or note landing after the row went terminal, DA12). */
export const isTerminalStatus = (status: string): boolean =>
  status === ArticleSuggestionStatus.Excluded || status === ArticleSuggestionStatus.AlreadyRead;

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
export function hasReadableReason(row: ArticleSuggestionModel): boolean {
  return (
    row.status !== ArticleSuggestionStatus.Excluded &&
    typeof row.reason === 'string' &&
    row.reason.trim().length > 0
  );
}

/**
 * The most specific human place name across an article's geo tags
 * (city → region → country code), or null when nothing is nameable. One
 * definition shared by the local-suggestion path and the standalone-article
 * path (ArticleFeedbackPrompt) so the two can't name the same article's place
 * differently.
 *
 * A SUPRANATIONAL countryCode ("MIDDLE_EAST", "EU", …) carries neither city
 * nor region, so it always falls through to the countryCode branch — resolved
 * through {@link supranationalName} to prose ("Middle East") rather than the
 * raw token, since this text feeds the `from_context_geo` negative-topic
 * search string (see `lib/news-harness/feedback-tree/resolve-leaf-actions.ts`).
 * A real ISO alpha-2 country code is unaffected (`supranationalName` returns
 * null for it) and keeps its historical raw-code text.
 */
export function geoTextFromTags(
  tags: { city?: string | null; region?: string | null; countryCode?: string | null }[],
): string | null {
  for (const tag of tags ?? []) {
    if (!tag) continue;
    const city = tag.city?.trim();
    if (city) return city;
    const region = tag.region?.trim();
    if (region) return region;
    const country = tag.countryCode?.trim();
    if (country) return supranationalName(country) ?? country;
  }
  return null;
}

/**
 * The same tag, the same field, UNCOOKED — the token a structured `place`
 * suppression compares against (`from_context_place`).
 *
 * It exists because {@link geoTextFromTags} is DISPLAY prose: it resolves a
 * supranational code through `supranationalName`, so an article tagged
 * `MIDDLE_EAST` yields "Middle East". A `place` filter matches by exact
 * normalized equality against a geo tag's own field, and `normCountry` only
 * trims and uppercases — so a filter built from that prose compares
 * "MIDDLE EAST" against the tag's "MIDDLE_EAST" and matches nothing, forever,
 * while looking perfectly applied.
 *
 * The walk is deliberately IDENTICAL to `geoTextFromTags`' (same tag order,
 * same city → region → countryCode precedence, same trim), because the label
 * the user reads and the value the filter carries must name the same place. A
 * test pins that they always pick the same tag and the same field.
 */
export function placeValueFromTags(
  tags: { city?: string | null; region?: string | null; countryCode?: string | null }[],
): string | null {
  for (const tag of tags ?? []) {
    if (!tag) continue;
    const city = tag.city?.trim();
    if (city) return city;
    const region = tag.region?.trim();
    if (region) return region;
    const country = tag.countryCode?.trim();
    if (country) return country;
  }
  return null;
}

export function toForYouSuggestion(
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
    storyKey: row.storyKey ?? null,
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
export function parseMatchedTopicRefs(
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
export function toClusterMemberships(
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

export function parseClusterMemberships(
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
export function canonicalClusterMembershipsJson(
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

export function parseTopicIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

export function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const t = new Date(value).getTime();
    return isNaN(t) ? null : new Date(t);
  }
  return null;
}

/** One inverted matchMeta entry for an article (persona-v3 path). */
export interface MatchedTopicMeta {
  topicId: string | null;
  text: string;
  vectorScore?: number | null;
  stableClusterId?: string | null;
}

/** Serialize matched-topic entries into the stored matched_topics_json shape.
 *  Shared by the insert path and the P7e existing-row backfill so both write the
 *  identical format. */
export function buildMatchedTopicsJson(matched: MatchedTopicMeta[]): string {
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
export function isMatchedTopicsJsonEmpty(json: string | null | undefined): boolean {
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
export function pickStableClusterId(
  a: ArticleWithClusters,
  fromMeta: string | undefined,
): string | null {
  if (fromMeta) return fromMeta;
  for (const c of a.clusters ?? []) {
    if (c.stableClusterId) return c.stableClusterId;
  }
  return null;
}
