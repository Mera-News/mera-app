// Individual steps of the feed sync flow, extracted from SuggestionSyncService.
// Each step is a pure async function that can be aborted via AbortSignal.

import { ArticleService } from '@/lib/article-service';
import {
  batchMarkAsScoredByIds,
  batchMarkExcluded,
  getCullableLowHeadlineIds,
  getLocalSuggestionServerIds,
  getUnscoredSuggestionsWithFacts,
  persistAndLinkV2Suggestions,
  getFactWeightById,
  type PersonaPersistMeta,
  type MatchedTopicMeta,
} from '@/lib/database/services/article-suggestion-service';
import { getFacts } from '@/lib/database/services/fact-service';
import {
  getActive as getActiveTopics,
  normalizeTopicText,
} from '@/lib/database/services/topic-service';
import { runPersonaMigrationIfNeeded } from '@/lib/services/persona-migration-service';
import { getAll as getAllLocations } from '@/lib/database/services/location-service';
import { getHeadlineDepths } from '@/lib/database/services/headline-depth-service';
import { buildRetrievalProfile } from '@/lib/news-harness/scoring-engine';
// The ONE admission predicate ("may this row enter scoring"), shared with the
// enqueue path and the bundle builders so a headline cannot be admitted by one
// and dropped by another.
import { isScorableCandidate } from '@/lib/news-harness/article-pipeline/scoring';
import {
  HeadlineScope,
  type ArticleWithClusters,
  type PersonaQueryInput,
} from '@/lib/generated/graphql-types';
import { gateUnscoredForScoring } from '@/lib/feed-grouping/score-propagation';
import {
  batchMarkAlreadyRead,
  loadReadStoryIndex,
  matchesReadStory,
  type ReadStoryCandidate,
  type ReadStoryIndex,
} from '@/lib/feed-grouping/read-story-filter';
import { loadUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import logger from '@/lib/logger';
import * as coldstartTimeline from '@/lib/diagnostics/coldstart-timeline';
import { withRetry } from '@/lib/utils/retry';
import { yieldToEventLoop } from '../idle';
import type { TaskContext } from '../scheduler-types';
import { reconcileTrackedStories } from './tracked-story-reconcile';
import { migrateLegacyTrackedStories } from '@/lib/tracking/track-actions';

/** Number of missing ids hydrated + persisted + enqueued per iteration. Kept at
 *  25 so each `getArticlesForTopicsByIds` call is a single server query (its
 *  internal chunk size is 50) and each enqueued batch is exactly one scoring
 *  batch (`BATCH_SIZE = 25` in scoring-pipeline). */
export const HYDRATE_CHUNK_SIZE = 25;

/** Round-4 B: hydrate up to this many chunks concurrently. WatermelonDB
 *  serializes writes internally, so per-chunk persists are safe to interleave;
 *  the gate+enqueue step is separately serialized behind a promise chain. */
export const HYDRATE_CONCURRENCY = 3;

/**
 * P9 hard-filter reconcile for the gate's propagation half. Propagated rows are
 * written terminal `complete` with a donor's relevance and never enter
 * computeMathStage/computeAndJudge — which is where `screenHardSuppressions`
 * runs — so without this a "Blocked" article can inherit a passing score and
 * render, defeating the badge's "never show me these at all" promise.
 *
 * This is the FULL sweep, not the scoped `purgeHardFilteredByIds`, because
 * `GateResult` reports a count and not the ids it wrote (see the HARD FILTERS
 * note in score-propagation.ts, which also explains why the chunk's own ids are
 * not a valid substitute). Cost is bounded the right way: the sweep returns
 * after a single persona read for any user with no hard filters — the common
 * case — and only pays for the row scan when filters actually exist.
 *
 * Lazy `require`, mirroring persona-mutation-sweeps::runSweep for the same
 * documented reason: module-graph weight. A static import drags stage-scoring →
 * llm/completeLocal → the native DB singleton into this module.
 */
const reconcileHardFilters = async (): Promise<void> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sweep = require('@/lib/services/suppression-sweep') as typeof import('@/lib/services/suppression-sweep');
  await sweep.purgeHardFilteredSuggestions();
};

/**
 * Convergence sweep for the LOW-band top-headline cull. The scoring paths cull
 * at score-persist time; this catches the two classes of row that never reach
 * that gate:
 *
 *   1. BACKFILL — LOW headlines persisted before the cull shipped are already
 *      on device and live out the full 48h TTL.
 *   2. PROPAGATION — `propagateToUnscoredSiblings` stamps a donor's relevance
 *      onto a headline sibling as terminal `complete` without ever entering the
 *      scoring stage, so a LOW donor score arrives pre-culled.
 *
 * Called ONCE per hydrate step, at the gate-drain point — not inside
 * `gateAndEnqueue`'s `propagatedCount > 0` branch, where the existing
 * `reconcileHardFilters` sits. That branch runs per CHUNK and only when
 * something propagated, so it would both repeat the sweep needlessly and skip
 * the backfill half entirely on a sync that propagated nothing. After the chain
 * drains, every propagation write of this run is committed.
 *
 * Not reached on a sync that found no new articles — FeedSyncMachine
 * short-circuits to `scoring` before this step. Harmless: that path can produce
 * no propagation leak (nothing propagated), and the backfill it defers is
 * deleted outright at the 48h TTL anyway.
 */
const cullLowHeadlines = async (): Promise<void> => {
  const ids = await getCullableLowHeadlineIds();
  if (ids.length === 0) return;
  await batchMarkExcluded(ids);
  // Unlike the persist-time culls (which fire before a row was ever visible),
  // rows reached here were `complete` and may already be laid out in the
  // persisted feed order — evict them the same filter-scoped way the
  // suppression sweep does: exactly these ids, nothing inferred.
  const { useFeedOrderStore } =
    require('@/lib/stores/feed-order-store') as typeof import('@/lib/stores/feed-order-store');
  useFeedOrderStore.getState().removeIds(ids);
  logger.info(`[feed-sync-steps] culled ${ids.length} LOW-band headline rows`);
};

/**
 * ALREADY-READ SCREEN, cheapest apply point (relevance v3 §3). A server-returned
 * article that re-serves a story the user already TAPPED OPEN is never persisted
 * at all: no suggestion row, no scoring pass, nothing to render or evict later.
 * The matching rules (article_id ∪ stable_cluster_id ∪ normalized-title Jaccard
 * ≥ 0.55) and the measurements behind them live in
 * `lib/feed-grouping/read-story-filter.ts`.
 *
 * The stable-cluster id is read from the article's own memberships first and
 * falls back to the persona metadata's per-article map, because the two sources
 * disagree in practice: `matchMeta.stableClusterId` (persona path) is populated
 * for retrieval hits whose membership list may arrive empty, and headline results
 * carry theirs in a parallel array. Taking whichever exists costs one lookup and
 * closes that gap.
 */
function articleReadCandidate(
  a: ArticleWithClusters,
  personaMeta: PersonaPersistMeta | undefined,
): ReadStoryCandidate {
  let stableClusterId: string | null = null;
  for (const m of a.clusters ?? []) {
    if (m?.stableClusterId) {
      stableClusterId = m.stableClusterId;
      break;
    }
  }
  return {
    articleId: a._id,
    stableClusterId: stableClusterId ?? personaMeta?.stableClusterId?.get(a._id) ?? null,
    title: a.title_en ?? a.title ?? null,
  };
}

/**
 * Split a hydrated chunk into "persist these" and "the user already read these".
 * Pure. Returns the input array identity when the index is inert so the common
 * (no reads recorded) case allocates nothing.
 */
export function splitAlreadyReadArticles(
  articles: ArticleWithClusters[],
  index: ReadStoryIndex,
  personaMeta: PersonaPersistMeta | undefined,
): { toPersist: ArticleWithClusters[]; readCount: number } {
  if (index.impressionCount === 0) return { toPersist: articles, readCount: 0 };
  const toPersist: ArticleWithClusters[] = [];
  let readCount = 0;
  for (const a of articles) {
    if (matchesReadStory(articleReadCandidate(a, personaMeta), index)) readCount += 1;
    else toPersist.push(a);
  }
  return { toPersist, readCount };
}

export interface FetchTopicIdsResult {
  articleToTopicTexts: Map<string, string[]>;
  serverArticleIds: string[];
  /** Persona-v3 metadata (present on the persona path; absent on the empty-
   *  topics-table fallback, which routes persist + scoring to the legacy path). */
  personaMeta?: PersonaPersistMeta;
  /** NORMALIZED texts of topics whose articles may be hydrated quota-FREE — i.e.
   *  texts carried ONLY by `provenance: 'tracked'` topics. See
   *  {@link computeFreeTopicTexts}. Absent on the legacy path (no topics table,
   *  so no tracked topics can exist). */
  freeTopicTexts?: Set<string>;
}

export interface DiffResult {
  serverArticleIds: string[];
  articleToTopicTexts: Map<string, string[]>;
  /** Every new-to-device id. Kept as the exact union of `storyIds` and
   *  `personaIds` so progress totals (FeedSyncMachine) are unaffected by the
   *  billing partition. */
  missingIds: string[];
  /** New-to-device ids matched ONLY by followed-story topics — hydrated through
   *  the quota-EXEMPT `articlesForStories` query. Disjoint from `personaIds`.
   *
   *  Optional so that a DiffResult built without the billing partition still
   *  works, and DELIBERATELY defaults to "everything metered" (see
   *  stepHydratePersistEnqueue): forgetting to partition must fall back to the
   *  pre-r12 behaviour of charging for everything, never to hydrating for free. */
  storyIds?: string[];
  /** Every other new-to-device id — hydrated through the METERED
   *  `articlesForTopicsByIds`. Disjoint from `storyIds`. Defaults to the whole
   *  `missingIds` set when the partition is absent. */
  personaIds?: string[];
  personaMeta?: PersonaPersistMeta;
}

/** Result of the merged hydrate + persist + enqueue step. */
export interface HydratePersistEnqueueResult {
  /** Total suggestion rows inserted across all chunks. */
  insertedCount: number;
  /** Total eligible ids handed to the scoring pipeline across all chunks. */
  enqueuedCount: number;
  /** True when the daily delivery cap clipped this run (partial or full). On a
   *  partial clip we still deliver what landed; the machine surfaces the limit
   *  banner immediately. A full clip with NOTHING delivered throws `daily-limit`
   *  instead. */
  dailyLimitReached: boolean;
  /** ISO reset timestamp, set only when `dailyLimitReached`. */
  resetAt?: string;
}

export interface HydratePersistEnqueueOptions {
  /** Reports cumulative completed-ids progress over the whole missingIds set. */
  onProgress: (completed: number) => void;
  /** Blocks between chunks while the machine is paused offline (hydrating is a
   *  NETWORK_DEPENDENT_STATE). Resolves immediately when not paused. */
  awaitResumeIfPaused: () => Promise<void>;
  /** Refreshes the For You store so freshly-persisted (still-unscored) articles
   *  render progressively, one chunk at a time. */
  refreshStore: () => Promise<void>;
  /** Hydrate and propagate, but hand nothing to the scoring pipeline: skips
   *  `enqueueCandidates` and the tail flush. Set when a scoring run is already
   *  in flight — appending fresh batches to a live run keeps it from ever
   *  finishing. The rows simply stay `Unscored`; the gate is a pure read for
   *  everything it elects (only propagated rows are written), so the pipeline's
   *  post-finalize kick re-derives and enqueues them with nothing lost. */
  suppressEnqueue?: boolean;
}

export async function stepFetchTopicIds(
  _userPersonaId: string,
  ctx: TaskContext,
): Promise<FetchTopicIdsResult> {
  if (ctx.signal.aborted) throw new Error('aborted');

  // P7e: close the sync-vs-migration race. On a fresh upgrade/login both
  // `feed-sync` and the one-time persona migration fire on app-foreground with
  // no ordering; if the sync wins, the `topics` table is still empty, so we fall
  // to the legacy path, which persists rows with matched_topics_json = null —
  // orphaning every article to "Also for you" (sticky, since re-sync never
  // rewrites the field). Run the (flag-guarded, instant no-op after first
  // completion) migration BEFORE the topics-path choice so the persona path is
  // taken from the first sync. A migration failure must never kill the sync — on
  // error we proceed exactly as before (legacy fallback if topics still empty).
  try {
    await runPersonaMigrationIfNeeded();
  } catch (err) {
    logger.captureException(err, {
      tags: { component: 'feed-sync-steps', method: 'runPersonaMigrationIfNeeded' },
    });
  }

  // Self-gating cutover: once the persona-v3 `topics` table is populated (the
  // one-time silent migration ran), use the privacy-lean persona retrieval;
  // until then fall back end-to-end to the legacy metadata.topics path so the
  // feed degrades gracefully on devices that haven't migrated yet.
  const activeTopics = await getActiveTopics();
  if (activeTopics.length === 0) {
    return fetchTopicIdsLegacy(ctx);
  }
  return fetchTopicIdsPersona(activeTopics, ctx);
}

/**
 * Normalized texts that may be hydrated QUOTA-FREE: the texts carried by
 * `provenance: 'tracked'` topics, MINUS every text carried by any other active
 * topic. Following a story must not consume the user's daily article
 * allowance — but only articles that arrived *solely* because of a followed
 * story qualify.
 *
 * WHY A SET DIFFERENCE AND NOT A MEMBERSHIP TEST. Two active topic rows can
 * legitimately carry the same text. `createTopics` dedupes on
 * `(normalized_text, fact_id)` — deliberately NOT on text alone, so that the
 * hygiene `duplicate_facts` detector can still see one text owned by two facts.
 * So a tracked topic ("gaza ceasefire", fact_id null) and an interest topic
 * ("Gaza ceasefire", owned by a fact) coexist by design. A plain
 * `trackedTexts.has(t)` would then hand every article matched by the INTEREST
 * free hydration too.
 *
 * WHY NOT PARTITION ON topicId. The obvious instinct — use ids, not strings —
 * does not work: the server keys its response by topic TEXT, so attributing a
 * returned id back to a row means going through `textToTopicId`, which is
 * first-writer-wins over duplicate texts. The id would be an arbitrary one of
 * the colliding rows, whose provenance may be the wrong one. The set difference
 * sidesteps id attribution entirely.
 *
 * Comparison is on NORMALIZED text so case/whitespace variants ("Gaza Ceasefire"
 * vs "gaza ceasefire") collapse onto the metered side rather than slipping past
 * the subtraction.
 *
 * Direction of failure is deliberate: a collision makes a followed story's
 * articles METERED (the status quo before this change), never the reverse. The
 * exemption can under-apply; it can never over-apply.
 */
export function computeFreeTopicTexts(
  activeTopics: { text: string; provenance: string }[],
): Set<string> {
  const tracked = new Set<string>();
  const nonTracked = new Set<string>();
  for (const t of activeTopics) {
    const key = normalizeTopicText(t.text ?? '');
    if (!key) continue;
    (t.provenance === 'tracked' ? tracked : nonTracked).add(key);
  }
  for (const key of nonTracked) tracked.delete(key);
  return tracked;
}

/**
 * Split new-to-device ids into the quota-EXEMPT (followed-story) set and the
 * METERED set.
 *
 * An id is free ONLY if every topic text that matched it is a free text, and it
 * did not also arrive via a headline scope (top-headline injection is ordinary
 * feed delivery and stays metered — mirroring the first-writer precedence the
 * headline pass already applies to `headlineScope`).
 *
 * METERED WINS on any overlap. An article matched by both a followed story and
 * a real interest is content the user would have received anyway.
 *
 * The two outputs are disjoint by construction, and their union is exactly the
 * input — the caller has already applied the new-to-device filter ONCE, and
 * this must not re-filter or drop anything.
 */
export function partitionStoryIds(
  missingIds: string[],
  articleToTopicTexts: Map<string, string[]>,
  freeTopicTexts: Set<string> | undefined,
  headlineScope?: Map<string, string>,
): { storyIds: string[]; personaIds: string[] } {
  if (!freeTopicTexts || freeTopicTexts.size === 0) {
    return { storyIds: [], personaIds: missingIds };
  }
  const storyIds: string[] = [];
  const personaIds: string[] = [];
  for (const id of missingIds) {
    const texts = articleToTopicTexts.get(id) ?? [];
    const free =
      texts.length > 0 &&
      !headlineScope?.has(id) &&
      texts.every((t) => freeTopicTexts.has(normalizeTopicText(t)));
    (free ? storyIds : personaIds).push(id);
  }
  return { storyIds, personaIds };
}

/** Persona-v3 privacy-lean retrieval: build the retrieval profile from weighted
 *  topics + locations, call articleIdsForPersona, and invert the per-topic
 *  matchMeta + headline results into the persist metadata. */
async function fetchTopicIdsPersona(
  activeTopics: Awaited<ReturnType<typeof getActiveTopics>>,
  ctx: TaskContext,
): Promise<FetchTopicIdsResult> {
  const [factWeights, locations, headlineDepths] = await Promise.all([
    getFactWeightById(),
    getAllLocations(),
    // Per-scope depth is a personalization nicety; a read failure must degrade
    // to the shipped default rather than wedge the whole feed sync (absence
    // already means "use the default" everywhere downstream).
    getHeadlineDepths().catch((err) => {
      logger.warn('[feed-sync-steps] headline depths unreadable — using defaults', err);
      return {} as Record<string, number>;
    }),
  ]);

  const profile = buildRetrievalProfile({
    topics: activeTopics.map((t) => ({
      topicId: t.id,
      text: t.text,
      weight: t.weight,
      highPriority: t.highPriority,
      factWeight: t.factId ? factWeights.get(t.factId) ?? 1 : 1,
    })),
    locations: locations.map((l) => ({
      countryCode: l.countryCode,
      role: l.role,
      weight: l.weight,
      validUntilMs: l.validUntil ?? undefined,
    })),
    // Absence-means-default: only scopes the reader actually overrode appear
    // here, and buildRetrievalProfile emits a `limit` only where the override
    // differs from the request-level default — so an untouched profile still
    // sends the byte-identical payload it sent before per-scope depth existed.
    headlineDepthByScope: headlineDepths,
  });

  if (profile.topics.length === 0) {
    // Topics exist but none has a positive effective weight → nothing to
    // retrieve (all negative/suppressed). Terminal, same as no-topics.
    throw Object.assign(new Error('no-topics-configured'), { code: 'no-topics-configured' });
  }

  const textToTopicId = new Map<string, string>();
  for (const t of profile.topics) {
    if (!textToTopicId.has(t.text)) textToTopicId.set(t.text, t.topicId);
  }

  const query: PersonaQueryInput = {
    topics: profile.topics.map((t) => ({ text: t.text, limit: t.limit })),
    // Query-level fallback only: the server prefers each topic's own `limit`
    // (set by buildRetrievalProfile, which now tops out at 40) and only falls
    // back to this when a topic omits one. Kept in step with that ceiling so
    // the two can't disagree — a larger value here was simply dead.
    limitPerTopic: 40,
    topHeadlines: {
      scopes: profile.headlineScopes.map((s) => ({
        scope: s.scope === 'COUNTRY' ? HeadlineScope.Country : HeadlineScope.Global,
        countryCode: s.countryCode ?? null,
        // OMITTED, not null, when this scope uses the request-level default.
        // buildRetrievalProfile only sets `limit` where an override actually
        // differs, and sending an explicit null on every scope would change
        // every user's payload for no behavioural gain.
        ...(s.limit === undefined ? {} : { limit: s.limit }),
      })),
      limitPerScope: profile.headlineLimitPerScope,
    },
  };

  ctx.log(`fetching persona ids for ${profile.topics.length} topics + ${profile.headlineScopes.length} scopes`);
  logger.debug(
    `[feed-sync-steps] calling articleIdsForPersona: ${profile.topics.length} topics, ${profile.headlineScopes.length} headline scopes`,
  );

  const res = await withRetry(() => ArticleService.getArticleIdsForPersona(query), ctx.signal);

  const articleToTopicTexts = new Map<string, string[]>();
  const matchedTopics = new Map<string, MatchedTopicMeta[]>();
  const headlineScope = new Map<string, string>();
  const headlineCountryCode = new Map<string, string>();
  const stableClusterId = new Map<string, string>();

  const pushMatched = (articleId: string, entry: MatchedTopicMeta) => {
    const bucket = matchedTopics.get(articleId) ?? [];
    bucket.push(entry);
    matchedTopics.set(articleId, bucket);
    const texts = articleToTopicTexts.get(articleId) ?? [];
    if (entry.text && !texts.includes(entry.text)) texts.push(entry.text);
    articleToTopicTexts.set(articleId, texts);
  };

  // Invert per-topic results → per-article matched topics.
  for (const tr of res.topicResults ?? []) {
    const topicId = textToTopicId.get(tr.topicText) ?? null;
    const metaByArticle = new Map(
      (tr.matchMeta ?? []).map((m) => [m.articleId, m]),
    );
    for (const articleId of tr.articleIds ?? []) {
      const mm = metaByArticle.get(articleId);
      pushMatched(articleId, {
        topicId,
        text: tr.topicText,
        vectorScore: mm?.vectorScore ?? null,
        stableClusterId: mm?.stableClusterId ?? null,
      });
      if (mm?.stableClusterId && !stableClusterId.has(articleId)) {
        stableClusterId.set(articleId, mm.stableClusterId);
      }
    }
  }

  // Headline injection: synthetic matched-topic (topicId null) + headline_scope.
  for (const hr of res.headlineResults ?? []) {
    const scopeLabel = hr.scope === HeadlineScope.Country ? 'COUNTRY' : 'GLOBAL';
    const label = `top headline · ${scopeLabel.toLowerCase()}`;
    // The scope's own country, normalized. GLOBAL results carry none by
    // construction; a COUNTRY result missing one is treated as unknown rather
    // than persisting an empty string.
    const scopeCountry =
      scopeLabel === 'COUNTRY' ? (hr.countryCode ?? '').trim().toUpperCase() : '';
    const ids = hr.articleIds ?? [];
    const stableIds = hr.stableClusterIds ?? [];
    ids.forEach((articleId, i) => {
      pushMatched(articleId, { topicId: null, text: label, vectorScore: null, stableClusterId: stableIds[i] ?? null });
      // Topic-retrieved match wins over a headline scope when both apply.
      // Scope LABEL and scope COUNTRY are written under the SAME first-writer
      // guard: setting them independently would let an article that appeared
      // in GLOBAL first and a COUNTRY scope second end up labelled GLOBAL
      // while carrying a country code — an incoherent row.
      if (!headlineScope.has(articleId)) {
        headlineScope.set(articleId, scopeLabel);
        if (scopeCountry) headlineCountryCode.set(articleId, scopeCountry);
      }
      const sid = stableIds[i];
      if (sid && !stableClusterId.has(articleId)) stableClusterId.set(articleId, sid);
    });
  }

  const serverArticleIds = [...matchedTopics.keys()];
  logger.debug(`[feed-sync-steps] articleIdsForPersona returned ${serverArticleIds.length} article ids`);
  ctx.log(`server returned ${serverArticleIds.length} article ids (persona path)`);

  return {
    articleToTopicTexts,
    serverArticleIds,
    personaMeta: { matchedTopics, headlineScope, headlineCountryCode, stableClusterId },
    // Billing partition input. Derived from the SAME activeTopics snapshot the
    // retrieval profile was built from, so the two can't disagree about which
    // texts were sent as tracked.
    freeTopicTexts: computeFreeTopicTexts(activeTopics),
  };
}

/** Legacy fallback: the pre-persona metadata.topics retrieval path, used until
 *  the persona-v3 migration has populated the `topics` table on this device. */
async function fetchTopicIdsLegacy(ctx: TaskContext): Promise<FetchTopicIdsResult> {
  const topicTexts = await getLocalTopicTextsForPersona();
  if (topicTexts.length === 0) {
    throw Object.assign(new Error('no-topics-configured'), { code: 'no-topics-configured' });
  }
  ctx.log(`fetching ids for ${topicTexts.length} topics (legacy path)`);
  logger.debug(`[feed-sync-steps] calling getArticleIdsForTopics with ${topicTexts.length} topics (legacy)`);

  const idsResponse = await withRetry(
    () =>
      ArticleService.getArticleIdsForTopics(
        topicTexts.map((text) => ({ topicText: text })),
        // Fetch everything per topic (server ceiling 100), same as the persona
        // path above. Was 20.
        { limitPerTopic: 100 },
      ),
    ctx.signal,
  );

  const articleToTopicTexts = new Map<string, string[]>();
  for (const result of idsResponse.results) {
    for (const id of result.articleIds) {
      const existing = articleToTopicTexts.get(id) ?? [];
      existing.push(result.topicText);
      articleToTopicTexts.set(id, existing);
    }
  }
  const serverArticleIds = [...articleToTopicTexts.keys()];

  logger.debug(`[feed-sync-steps] getArticleIdsForTopics returned ${serverArticleIds.length} article ids`);
  ctx.log(`server returned ${serverArticleIds.length} article ids`);
  return { articleToTopicTexts, serverArticleIds };
}

export async function stepDiff(
  result: FetchTopicIdsResult,
  ctx: TaskContext,
): Promise<DiffResult> {
  if (ctx.signal.aborted) throw new Error('aborted');

  const { serverArticleIds, articleToTopicTexts, personaMeta, freeTopicTexts } =
    result;
  const localIds = await getLocalSuggestionServerIds();
  const localIdSet = new Set(localIds);
  const missingIds = serverArticleIds.filter((id) => !localIdSet.has(id));
  ctx.log(`${missingIds.length} missing ids to hydrate`);

  // Billing partition. Deliberately AFTER the new-to-device filter and derived
  // from that single filtered array: the local-id read happens exactly once, so
  // the two hydration calls can never both see the same id, and there is no
  // window in which a stale local set could let one through twice.
  const { storyIds, personaIds } = partitionStoryIds(
    missingIds,
    articleToTopicTexts,
    freeTopicTexts,
    personaMeta?.headlineScope,
  );
  if (storyIds.length > 0) {
    ctx.log(
      `${storyIds.length} of them are followed-story only (hydrated quota-free)`,
    );
  }

  return {
    serverArticleIds,
    articleToTopicTexts,
    missingIds,
    storyIds,
    personaIds,
    personaMeta,
  };
}

/**
 * Merged hydrate + persist + enqueue step (runs under the `hydrating` state).
 *
 * Round-4 B: chunks are hydrated with concurrency `HYDRATE_CONCURRENCY` (a
 * simple promise pool, no new deps). For each chunk a worker downloads the full
 * records (one server query), persists + links them, marks ineligible rows
 * scored, refreshes the store for progressive rendering, and — if the chunk
 * produced eligible ids — runs the gate + enqueue step so full 25-article quanta
 * dispatch MID-hydration (greedy overlap) instead of only once at the end. The
 * gate+enqueue invocations are serialized behind a promise chain so they never
 * run concurrently (the gate re-derives its candidates from ALL unscored,
 * not-in-flight rows, and enqueueCandidates applies the strict quantum gate).
 *
 * Daily-limit semantics: the server charges the delivery cap here and clips the
 * response. If the cap leaves NOTHING to deliver on the whole run, throw a
 * terminal `daily-limit` error (decided AFTER the pool drains so a parallel dry
 * chunk can't pre-empt a sibling that did deliver). If it hits after some chunks
 * already landed, stop launching new chunks and keep what landed.
 */
export async function stepHydratePersistEnqueue(
  diffResult: DiffResult,
  ctx: TaskContext,
  opts: HydratePersistEnqueueOptions,
): Promise<HydratePersistEnqueueResult> {
  if (ctx.signal.aborted) throw new Error('aborted');

  const { missingIds, articleToTopicTexts, personaMeta } = diffResult;
  // Fail METERED, not free. A DiffResult that never went through the billing
  // partition hydrates exactly as it did before r12 — charging for everything —
  // rather than silently routing the whole run through the unmetered query.
  const storyIds = diffResult.storyIds ?? [];
  const personaIds = diffResult.personaIds ?? missingIds;

  // Two hydrators, one pool. Followed-story-only ids go through the quota-EXEMPT
  // `articlesForStories`; everything else through the METERED
  // `articlesForTopicsByIds`. The two id arrays are disjoint (partitioned once,
  // in stepDiff), so no article can be fetched — or charged — twice.
  //
  // Everything downstream of the response is IDENTICAL for both: same persist,
  // same link, same gate, same enqueue. The only thing that differs is which
  // server query delivered the rows.
  //
  // Story chunks are listed FIRST so that, if the metered path later trips the
  // daily cap and stops the pool, the followed-story articles the user
  // explicitly asked for have already landed.
  const chunks: { ids: string[]; free: boolean }[] = [
    ...chunkArray(storyIds, HYDRATE_CHUNK_SIZE).map((ids) => ({
      ids,
      free: true,
    })),
    ...chunkArray(personaIds, HYDRATE_CHUNK_SIZE).map((ids) => ({
      ids,
      free: false,
    })),
  ];

  let completedIds = 0;
  let insertedCount = 0;
  let deliveredAny = false;
  let dailyLimitReached = false;
  let resetAt: string | undefined;
  let enqueuedCount = 0;
  // Set once a chunk hits the cap dry (0 articles) or a mid-run abort/pause
  // ends — stops the pool from launching further chunks.
  let stopLaunching = false;

  // Lazy require (not a static import) breaks the module-load cycle
  // feed-sync-steps → scoring-pipeline → SuggestionSyncService → run-inference-
  // handler → feed-sync-steps. Same pattern as lib/database/hydrate-stores.ts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const scoringPipeline = require('@/lib/services/scoring-pipeline') as typeof import('@/lib/services/scoring-pipeline');
  const { enqueueCandidates, getNonTerminalCandidateIds } = scoringPipeline;

  // Serialize gate+enqueue: the gate scans ALL unscored rows and enqueueCandidates
  // dispatches quanta, so two concurrent invocations could double-count. A simple
  // promise chain guarantees one-at-a-time execution across the parallel workers.
  let gateChain: Promise<void> = Promise.resolve();
  const runGateSerialized = (fn: () => Promise<void>): Promise<void> => {
    const next = gateChain.then(fn, fn);
    // Keep the chain alive even if fn rejects, so one failure doesn't wedge the
    // rest. Individual failures still surface via the awaited `next`.
    gateChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // Resolve the user's geo/language context once for the whole run and reuse it
  // across every serialized gate call — its country/language priority steers
  // which sibling of a duplicate group gets elected to score. Fails open to
  // null (legacy, geo/language-blind election).
  const userCtx = await loadUserGeoLanguageContext();

  // Already-read index: ONE read of `story_impressions` for the whole run,
  // shared by the pre-persist screen (per chunk) and the unscored-backfill
  // screen inside `markIneligibleAndCollectEligible`. A sync is short relative
  // to the 30-day impression TTL, so a snapshot taken here cannot go
  // meaningfully stale mid-run; rebuilding per chunk would just re-read the same
  // table N times. Fails open to an inert index (nothing excluded).
  const readIndex = await loadReadStoryIndex();
  let readSkippedTotal = 0;

  // The gate re-derives its candidates from ALL unscored, not-in-flight rows —
  // not just this chunk's eligible ids — so any sibling held back or missed by a
  // failed batch on a prior chunk/sync is re-considered. Self-healing with no
  // persisted held-back state: a held-back sibling is either propagated (its rep
  // scored) or re-enqueued next pass.
  // The trailing sub-25 partial the most recent enqueue held back (empty when
  // nothing was deferred). Flushed to scoring once the whole lot is hydrated.
  let pendingDeferred: string[] = [];
  // That same pass's gate coverage (rep id → the duplicate group it stands in
  // for), carried alongside so the tail flush records the same article coverage
  // the greedy enqueues did — otherwise the flushed remainder would look like it
  // covers only itself and undercount the header's denominator.
  let pendingCoveredIdsByRep: Record<string, string[]> = {};

  const gateAndEnqueue = async (): Promise<void> => {
    const inFlight = await getNonTerminalCandidateIds();
    const gate = await gateUnscoredForScoring(inFlight, userCtx);
    if (gate.propagatedCount > 0) {
      // P9: propagated rows were written terminal `complete` WITHOUT passing
      // the scoring stage's hard screen. Reconcile against the live hard
      // filters BEFORE the store refresh, so a "Blocked" article never reaches
      // the feed even for one frame. Never fails the sync — the propagation is
      // already committed and the next filter mutation sweeps the table anyway.
      try {
        await reconcileHardFilters();
      } catch (err) {
        logger.captureException(err, {
          tags: { service: 'feed-sync-steps', step: 'reconcile-hard-filters' },
        });
      }
      // Propagated rows are now terminal `Complete` — surface them immediately.
      await opts.refreshStore();
    }
    // The propagation half above always runs — it is what turns a duplicate of
    // an already-scored story into a `Complete` row without any inference. Only
    // the dispatch is suppressed.
    if (!opts.suppressEnqueue && gate.enqueueIds.length > 0) {
      const res = await enqueueCandidates(
        gate.enqueueIds,
        false,
        gate.coveredIdsByRep,
      );
      pendingDeferred = res?.deferred ?? [];
      pendingCoveredIdsByRep = gate.coveredIdsByRep ?? {};
    }
    if (!opts.suppressEnqueue) enqueuedCount += gate.enqueueIds.length;
    readSkippedTotal += gate.readCount;
    const enqueuedLabel = opts.suppressEnqueue
      ? `${gate.enqueueIds.length} left unscored (enqueue suppressed)`
      : `enqueued ${gate.enqueueIds.length}`;
    const gateLine = `gate: propagated ${gate.propagatedCount}, held back ${gate.heldBackCount}, ${enqueuedLabel}, read ${gate.readCount}`;
    ctx.log(gateLine);
    logger.debug(`[feed-sync-steps] ${gateLine}`);
    coldstartTimeline.mark(
      'first-gate-enqueue',
      `enqueued=${gate.enqueueIds.length} heldBack=${gate.heldBackCount} propagated=${gate.propagatedCount}`,
    );
  };

  let nextChunk = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopLaunching) return;
      // Cooperative points: pause while offline, bail on abort.
      await opts.awaitResumeIfPaused();
      if (ctx.signal.aborted) {
        stopLaunching = true;
        return;
      }
      const i = nextChunk++;
      if (i >= chunks.length) return;
      const { ids: chunk, free } = chunks[i];

      const onChunkProgress = (chunkCompleted: number) =>
        opts.onProgress(completedIds + chunkCompleted);

      const response: {
        articles: ArticleWithClusters[];
        // Only the metered query can report the cap. The quota-exempt one has
        // no cap to hit, so these are absent on its result type by design.
        dailyLimitReached?: boolean;
        resetAt?: string;
      } = await withRetry(
        () =>
          free
            ? ArticleService.getArticlesForStories(chunk, onChunkProgress)
            : ArticleService.getArticlesForTopicsByIds(chunk, onChunkProgress),
        ctx.signal,
      );
      const chunkArticles = response.articles;
      if (response.dailyLimitReached) {
        dailyLimitReached = true;
        resetAt = resetAt ?? response.resetAt;
      }

      // ALREADY-READ SCREEN. Deliberately NOT folded into the `deliveredAny` /
      // daily-limit bookkeeping below, which stays on the RAW response length:
      // the server delivered (and charged for) these articles, so a chunk that
      // is entirely already-read is a delivered chunk, not the dry chunk that
      // signals the cap.
      const { toPersist, readCount: chunkReadSkipped } = splitAlreadyReadArticles(
        chunkArticles,
        readIndex,
        personaMeta,
      );
      readSkippedTotal += chunkReadSkipped;
      if (chunkReadSkipped > 0) {
        ctx.log(`skipped ${chunkReadSkipped} already-read articles`);
      }

      if (chunkArticles.length > 0) {
        deliveredAny = true;
      }

      if (toPersist.length > 0) {
        const { insertedCount: chunkInserted } =
          await persistAndLinkV2Suggestions(
            toPersist,
            articleToTopicTexts,
            personaMeta,
          );
        insertedCount += chunkInserted;
        coldstartTimeline.mark(
          'first-hydration-chunk-persisted',
          `persisted=${chunkInserted}`,
        );

        const chunkIdSet = new Set(toPersist.map((a) => a._id));
        const { ineligibleCount, alreadyReadCount, eligibleIds } =
          await markIneligibleAndCollectEligible(chunkIdSet, readIndex);
        if (ineligibleCount > 0) {
          ctx.log(`pre-scored ${ineligibleCount} ineligible articles`);
        }
        if (alreadyReadCount > 0) {
          readSkippedTotal += alreadyReadCount;
          ctx.log(`marked ${alreadyReadCount} already-synced rows as already read`);
        }

        // Progressive rendering: newly-persisted (unscored) articles appear now.
        await opts.refreshStore();
        // A6: yield the JS thread so the just-rendered chunk can paint.
        await yieldToEventLoop();

        // Greedy overlap: if this chunk produced eligible ids, run the
        // gate+enqueue now (serialized) so accumulated full quanta dispatch
        // mid-hydration instead of only once at the end.
        if (eligibleIds.length > 0) {
          await runGateSerialized(() => gateAndEnqueue());
        }
      }

      completedIds += chunk.length;
      opts.onProgress(completedIds);
      ctx.log(`chunk ${i + 1}/${chunks.length}: persisted ${toPersist.length}`);
      logger.debug(
        `[feed-sync-steps] chunk ${i + 1}/${chunks.length}: persisted ${toPersist.length}`,
      );

      // Daily cap ran dry for this chunk (nothing delivered) — stop launching
      // further chunks. The throw-vs-keep decision is made AFTER the pool drains.
      if (dailyLimitReached && chunkArticles.length === 0) {
        stopLaunching = true;
        logger.debug(
          '[feed-sync-steps] daily limit hit — stopping the hydration pool',
        );
        return;
      }
    }
  };

  const poolSize = Math.min(HYDRATE_CONCURRENCY, Math.max(1, chunks.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  // Drain any still-pending serialized gate invocation before deciding the
  // outcome / returning.
  await gateChain;

  // Every propagation write of this run is now committed — sweep the LOW-band
  // headline cull to convergence (backfill + propagation leak; see
  // `cullLowHeadlines`). Never fails the sync: the rows are already persisted
  // and the next sync sweeps them again.
  try {
    await cullLowHeadlines();
  } catch (err) {
    logger.captureException(err, {
      tags: { component: 'feed-sync-steps', method: 'cullLowHeadlines' },
    });
  }

  // Tail flush: the whole lot is now hydrated and we won't refetch until it's
  // scored, so dispatch the sub-MIN_DISPATCH remainder the gate held back
  // instead of letting it wait out MAX_UNSCORED_WAIT_MS (~30 min) for articles
  // that will never arrive this cycle. These ids were already gate-elected, so
  // we enqueue them directly with flushPartial=true (no extra gate pass). Never
  // let a flush failure fail the (already-hydrated) step.
  if (!ctx.signal.aborted) {
    try {
      if (!opts.suppressEnqueue && pendingDeferred.length > 0) {
        await enqueueCandidates(pendingDeferred, true, pendingCoveredIdsByRep);
      } else if (
        opts.suppressEnqueue &&
        (await scoringPipeline.getPipelineStatus()) === 'idle'
      ) {
        // Suppressed cycle: we hydrated rows but never enqueued them, because a
        // scoring run was in flight. If that run finished while we were
        // hydrating, WE are the handoff — the pipeline's own post-finalize kick
        // either ran before these rows landed, or skipped its flush precisely
        // because it saw feed-sync busy. Re-elect from the DB and flush, or
        // these rows sit unscored until the 30-minute staleness escape.
        await scoringPipeline.enqueueUnscoredEligible({ flushRemainder: true });
      }
    } catch (err) {
      logger.captureException(err, {
        tags: { component: 'feed-sync-steps', method: 'tailFlush' },
      });
    }
  }

  // Daily-limit outcome: throw ONLY if the cap blocked the entire run.
  if (dailyLimitReached && !deliveredAny) {
    logger.info('[feed-sync-steps] daily article-delivery limit reached');
    throw Object.assign(new Error('daily-limit'), {
      code: 'daily-limit',
      resetAt: resetAt ? Date.parse(resetAt) : undefined,
    });
  }

  ctx.log(
    `hydrated+persisted ${insertedCount} records, enqueued ${enqueuedCount}` +
      (readSkippedTotal > 0 ? `, already read ${readSkippedTotal}` : ''),
  );

  // Fire-and-forget: first upgrade any legacy stable-cluster follows to the
  // topic model (one-shot + idempotent — a cheap no-op once none remain), THEN
  // grow every followed topic from whatever this run just persisted (the
  // suggestions' matched_topics). Chained so a just-migrated story also grows
  // this same cycle. Runs after every persist attempt — including a
  // partial/daily-limit-clipped one, since whatever landed is still a valid
  // reconcile source — but must never fail or delay the sync itself.
  migrateLegacyTrackedStories()
    .catch((err) => {
      logger.captureException(err, {
        tags: { component: 'feed-sync-steps', method: 'migrateLegacyTrackedStories' },
      });
    })
    .finally(() => {
      reconcileTrackedStories().catch((err) => {
        logger.captureException(err, {
          tags: { component: 'feed-sync-steps', method: 'reconcileTrackedStories' },
        });
      });
    });

  return {
    insertedCount,
    enqueuedCount,
    dailyLimitReached,
    resetAt,
  };
}

export async function stepScore(ctx: TaskContext): Promise<number> {
  if (ctx.signal.aborted) throw new Error('aborted');
  const { runScoringPass } = await import('@/lib/services/SuggestionSyncService');
  return runScoringPass();
}

// --- Internal helpers ---

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function getLocalTopicTextsForPersona(): Promise<string[]> {
  const facts = await getFacts();
  const texts = new Set<string>();
  for (const fact of facts) {
    for (const topic of fact.metadata?.topics ?? []) {
      if (topic.length > 0) texts.add(topic);
    }
  }
  logger.debug(`[feed-sync-steps] found ${texts.size} topic texts from facts`);
  return Array.from(texts);
}

/**
 * Partition the currently-unscored suggestions: mark the ineligible ones
 * (missing English title/description, or factless AND not headline-sourced) as
 * scored so they never enter scoring, and return the eligible ids that belong to
 * THIS chunk so they can be enqueued. Global scan (like the pre-merge
 * `markIneligible…`), but the returned eligible set is scoped to the chunk just
 * persisted.
 *
 * The admission test is `isScorableCandidate`, NOT `isEligible`: a TOP-HEADLINE
 * row is factless by design (its matched topic is synthetic, `topicId: null`,
 * so `persistAndLinkV2Suggestions` links no fact to it). This ran at every
 * chunk, over ALL unscored rows, immediately after persist and BEFORE
 * gate+enqueue — so the old `relatedFacts.length === 0` test wrote every pure
 * headline terminal (`relevance 0`, `reason ''`, `status complete`) before any
 * scoring existed, with no timing window to escape through. Rows missing
 * title/description are still tombstoned: no prompt can score empty text.
 *
 * ALREADY-READ BACKFILL (relevance v3 §3). The pre-persist screen upstream only
 * sees THIS run's server response; it cannot help a row synced on an earlier
 * cycle and still `unscored` when the user finally read that story. This global
 * unscored scan is exactly where such a row is visible, so it doubles as the
 * backfill: matches are written terminal `already_read` (never enqueued, never
 * scored) instead of being marked ineligible-`complete`, which would be a lie
 * about why they are invisible. The read screen runs FIRST — a row that is both
 * already-read and ineligible is more usefully counted as already-read, and it
 * keeps the two counts from double-billing the same id.
 */
async function markIneligibleAndCollectEligible(
  chunkIds: Set<string>,
  readIndex: ReadStoryIndex,
): Promise<{ ineligibleCount: number; alreadyReadCount: number; eligibleIds: string[] }> {
  const all = await getUnscoredSuggestionsWithFacts();

  const alreadyRead =
    readIndex.impressionCount === 0
      ? []
      : all.filter((c) =>
          matchesReadStory(
            {
              // A suggestion's WMDB row id IS the server article id.
              articleId: c.id,
              stableClusterId: c.meta?.stableClusterId ?? null,
              title: c.titleEn,
            },
            readIndex,
          ),
        );
  if (alreadyRead.length > 0) {
    // Never fails the sync. If the write is lost these rows simply stay
    // `unscored` and the gate — which re-derives from ALL unscored rows on the
    // very next pass — marks them then. Self-healing, so swallowing is safe;
    // they are still withheld from THIS chunk's eligible ids either way.
    try {
      await batchMarkAlreadyRead(alreadyRead.map((c) => c.id));
    } catch (err) {
      logger.captureException(err, {
        tags: { component: 'feed-sync-steps', method: 'batchMarkAlreadyRead' },
      });
    }
  }
  const alreadyReadIds = new Set(alreadyRead.map((c) => c.id));
  const candidates = alreadyReadIds.size === 0 ? all : all.filter((c) => !alreadyReadIds.has(c.id));

  const ineligible = candidates.filter((c) => !isScorableCandidate(c));
  if (ineligible.length > 0) {
    await batchMarkAsScoredByIds(ineligible.map((c) => c.id));
  }
  const eligibleIds = candidates
    .filter(isScorableCandidate)
    .filter((c) => chunkIds.has(c.id))
    .map((c) => c.id);
  return {
    ineligibleCount: ineligible.length,
    alreadyReadCount: alreadyRead.length,
    eligibleIds,
  };
}
