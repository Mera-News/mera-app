// Shared by the feed-sync step seam tests (and data-U6b): a real TaskContext, seeding through the
// app's own services, per-test server handlers for the id and hydrate operations, an ordered
// request recorder, key-scoped DB faults and the module-memory reset. Not a test file.
import database from '@/lib/database';
import { restoreFaults } from '../../support/faults';
import { addFact } from '@/lib/database/services/fact-service';
import { getStageRowsByIds, loadSuggestions } from '@/lib/database/services/article-suggestion-service';
import { upsertLocation } from '@/lib/database/services/location-service';
import { setSetting } from '@/lib/database/services/setting-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { __resetPendingForTests } from '@/lib/database/services/topic-decline-service';
import { PERSONA_V3_MIGRATION_KEY } from '@/lib/services/persona-migration-service';
import {
  stepDiff,
  stepFetchTopicIds,
  stepHydratePersistEnqueue,
  type DiffResult,
  type FetchTopicIdsResult,
  type HydratePersistEnqueueOptions,
  type HydratePersistEnqueueResult,
} from '@/lib/scheduler/feed-sync/feed-sync-steps';
import type { TaskContext } from '@/lib/scheduler/scheduler-types';
import * as scoringPipeline from '@/lib/services/scoring-pipeline';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { ProcessingMode, type ArticleWithClusters } from '@/lib/generated/graphql-types';
import { invalidateJwtCache } from '@/lib/auth-client';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import { __resetSuggestionsRefreshThrottleForTests } from '@/lib/services/SuggestionSyncService';
import { useUserStore } from '@/lib/stores/user-store';
import {
  advanceUntilDone,
  delay,
  gatewayCalls,
  graphql,
  HttpResponse,
  server,
  setAppState,
  signInFixtureAccount,
  useFakeClock as freezeClockAt, // aliased: a use* name inside a plain function trips react-hooks/rules-of-hooks
} from '@/test/helpers';

// ---------------------------------------------------------------------------
// Module memory
// ---------------------------------------------------------------------------

const resetStore = (store: unknown): void =>
  (store as { setState(s: unknown, replace: true): void; getInitialState(): unknown }).setState(
    (store as { getInitialState(): unknown }).getInitialState(),
    true,
  );

const ownSpies: jest.SpyInstance[] = [];

/** jest.spyOn on a real module export (R23: fault injection on one call), restored by `cleanupFeedSync`. */
export function spyOnExport<T extends object, K extends keyof T & string>(target: T, method: K): jest.SpyInstance {
  const spy = jest.spyOn(target, method as never);
  ownSpies.push(spy);
  return spy;
}

/** Everything the steps and their dependencies keep in memory. Call from `beforeEach`. */
export function resetFeedSyncMemory(): void {
  __resetPendingForTests();
  scoringPipeline._resetForTests();
  resetStore(useForYouStore);
  resetStore(useFeedOrderStore);
  resetStore(useMeraProtocolStore);
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
}

/** Call from `afterEach`: recorders, faults and anything a test left running. */
export function cleanupFeedSync(): void {
  stopRecording();
  restoreFaults();
  for (const spy of ownSpies.splice(0)) spy.mockRestore();
  __resetPendingForTests();
  scoringPipeline._resetForTests();
}

// ---------------------------------------------------------------------------
// TaskContext
// ---------------------------------------------------------------------------

export interface TestCtx {
  ctx: TaskContext;
  abort(): void;
  log: jest.Mock;
  markNoOp: jest.Mock;
}

export function makeCtx(): TestCtx {
  const controller = new AbortController();
  const log = jest.fn();
  const markNoOp = jest.fn();
  return {
    ctx: {
      jobId: 'job-1',
      attempt: 1,
      signal: controller.signal,
      reportProgress: jest.fn(),
      log,
      markNoOp,
    },
    abort: () => controller.abort(),
    log,
    markNoOp,
  };
}

// ---------------------------------------------------------------------------
// Seeding, through the app's services
// ---------------------------------------------------------------------------

/** The persona migration already ran: a fact with `metadata.topics` and no topic rows stays on the legacy path. */
export async function markPersonaMigrated(): Promise<void> {
  await setSetting(PERSONA_V3_MIGRATION_KEY, 'done');
}

export interface InterestSeed {
  text: string;
  weight?: number;
  highPriority?: boolean;
}

/** A fact with interest topics. `createTopics` also appends each text to `fact.metadata.topics`. */
export async function seedInterest(statement: string, topics: (string | InterestSeed)[]) {
  const fact = await addFact(statement);
  const rows = await createTopics(
    topics.map((t) => {
      const seed = typeof t === 'string' ? { text: t } : t;
      return {
        factId: fact.id,
        text: seed.text,
        weight: seed.weight ?? 1,
        highPriority: seed.highPriority ?? false,
        provenance: 'llm' as const,
      };
    }),
  );
  return { fact, topics: rows };
}

/** A followed-story topic: no fact, `provenance: 'tracked'`. */
export async function seedTracked(text: string, weight = 0.85) {
  const [topic] = await createTopics([
    { text, weight, status: 'active', provenance: 'tracked', highPriority: true },
  ]);
  return topic;
}

export async function seedLocation(countryCode: string, weight: number, role: 'home' | 'work' | 'travel' = 'home') {
  return upsertLocation({ city: `city-${countryCode}-${role}`, countryCode, role, weight });
}

// ---------------------------------------------------------------------------
// Server handlers
// ---------------------------------------------------------------------------

/** A hydrated article. Distinct vocabulary per id, so the story gate never groups two of them. */
export function art(id: string, over: Partial<ArticleWithClusters> = {}): ArticleWithClusters {
  return {
    __typename: 'ArticleWithClusters',
    _id: id,
    clusters: [{ __typename: 'ClusterMembership', clusterId: `c-${id}`, confidence: 0.9, stableClusterId: `member-${id}` }],
    title: `Story ${id} saga${id}`,
    title_en: `Story ${id} saga${id}`,
    description_en: `Details of story ${id}`,
    article_url: `https://example.com/${id}`,
    image_url: null,
    country_code: null,
    publication_name: `Pub ${id}`,
    language_code: 'en',
    pubDate: new Date(Date.now() - 3_600_000).toISOString(),
    geo_tags: [],
    entities: [],
    event_type: null,
    category: null,
    maxClusterSize: 1,
    ...over,
  } as ArticleWithClusters;
}

export const ids = (n: number, prefix = 'a'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);

export interface PersonaServe {
  /** topic text -> article ids it matched, in the order the server lists them */
  topics?: Record<string, string[]>;
  /** headline scope results, in the order the server lists them */
  headlines?: { scope: 'COUNTRY' | 'GLOBAL'; countryCode?: string; ids: string[] }[];
  /** article id -> the stable cluster id the server reports for it (default `stable-<id>`) */
  stable?: Record<string, string>;
}

/**
 * `GetArticleIdsForPersona`, answering only what was asked: a topic result per listed text that
 * the request carried (under the text the request used, matched on normalized text, as the
 * server does) and a headline result per listed scope the request carried. Result order is the
 * order listed here, which is what the order guard depends on.
 */
export function servePersona(serve: PersonaServe) {
  const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
  return graphql.query('GetArticleIdsForPersona', ({ variables }) => {
    const query = (variables.query ?? {}) as {
      topics?: { text: string }[];
      topHeadlines?: { scopes?: { scope: string; countryCode?: string | null }[] };
    };
    const asked = query.topics ?? [];
    const scopes = query.topHeadlines?.scopes ?? [];
    return HttpResponse.json({
      data: {
        articleIdsForPersona: {
          __typename: 'PersonaQueryResult',
          topicResults: Object.entries(serve.topics ?? {}).flatMap(([text, articleIds]) => {
            const sent = asked.find((t) => norm(t.text) === norm(text));
            if (!sent) return [];
            return [
              {
                __typename: 'PersonaTopicResult',
                topicText: sent.text,
                articleIds,
                matchMeta: articleIds.map((id) => ({
                  __typename: 'PersonaMatchMeta',
                  articleId: id,
                  vectorScore: 0.8,
                  textScore: null,
                  stableClusterId: serve.stable?.[id] ?? `stable-${id}`,
                })),
                nextCursor: null,
                hasNextPage: false,
              },
            ];
          }),
          headlineResults: (serve.headlines ?? [])
            .filter((h) =>
              scopes.some(
                (s) =>
                  s.scope === h.scope &&
                  (h.scope === 'GLOBAL' || (s.countryCode ?? '').toUpperCase() === (h.countryCode ?? '').toUpperCase()),
              ),
            )
            .map((h) => ({
              __typename: 'HeadlineScopeResult',
              scope: h.scope,
              countryCode: h.scope === 'COUNTRY' ? (h.countryCode ?? null) : null,
              articleIds: h.ids,
              clusterSizes: h.ids.map(() => 1),
              stableClusterIds: h.ids.map((id) => serve.stable?.[id] ?? `stable-${id}`),
            })),
        },
      },
    });
  });
}

export interface HydrateServe {
  /** Build the article for a requested id. Default: `art(id)`. */
  article?: (id: string) => ArticleWithClusters;
  /** Ids the response lists twice (an article matched by two topics arrives once per match). */
  twice?: string[];
  /** Shared, ordered record of what reached the server: `<op>:<n ids>`. */
  timeline?: string[];
  /** Hold a response until this promise settles (decide per request by its ids). */
  gate?: (req: { ids: string[]; n: number }) => Promise<void> | undefined;
  /** Hold each response this long (ms), or decide per request by its arrival number (1-based). */
  holdMs?: number | ((n: number) => number);
  /** Decide a response for one request. Return `'resolver-error'` for an `errors[]` inside a 200. */
  respond?: (req: {
    op: 'GetArticlesForTopicsByIds' | 'GetArticlesForStories';
    ids: string[];
    n: number;
  }) => { articles: ArticleWithClusters[]; dailyLimitReached?: boolean; resetAt?: string } | 'resolver-error' | undefined;
}

/** Live counters for `serveHydrate`. */
export interface HydrateStats {
  inFlight: number;
  maxInFlight: number;
  requests: { op: string; ids: string[] }[];
}

/** Both hydrate operations, with the same body shape. `stats` tracks concurrency. */
export function serveHydrate(serve: HydrateServe = {}) {
  const stats: HydrateStats = { inFlight: 0, maxInFlight: 0, requests: [] };
  const build = serve.article ?? ((id: string) => art(id));
  const handler = (op: 'GetArticlesForTopicsByIds' | 'GetArticlesForStories') =>
    graphql.query(op, async ({ variables }) => {
      const requested = (variables.articleIds ?? []) as string[];
      stats.requests.push({ op, ids: requested });
      serve.timeline?.push(`${op}:${requested.length}`);
      const n = stats.requests.length;
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        await serve.gate?.({ ids: requested, n });
        const hold = typeof serve.holdMs === 'function' ? serve.holdMs(n) : serve.holdMs;
        if (hold) await delay(hold);
        const decided = serve.respond?.({ op, ids: requested, n });
        if (decided === 'resolver-error') {
          return HttpResponse.json({
            data: null,
            errors: [{ message: 'resolver timed out', extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
          });
        }
        const articles =
          decided?.articles ??
          requested.flatMap((id) => (serve.twice?.includes(id) ? [build(id), build(id)] : [build(id)]));
        const body: Record<string, unknown> = { __typename: 'ArticlesForTopicsByIdsResponse', articles };
        if (op === 'GetArticlesForTopicsByIds') {
          body.dailyLimitReached = decided?.dailyLimitReached ?? false;
          body.resetAt = decided?.resetAt ?? null;
        } else if (decided?.dailyLimitReached) {
          // the quota-free query selects no cap fields, but a body that carries them must change nothing
          body.dailyLimitReached = true;
          body.resetAt = decided.resetAt ?? null;
        }
        return HttpResponse.json({
          data: op === 'GetArticlesForTopicsByIds' ? { articlesForTopicsByIds: body } : { articlesForStories: body },
        });
      } finally {
        stats.inFlight -= 1;
      }
    });
  return { handlers: [handler('GetArticlesForTopicsByIds'), handler('GetArticlesForStories')], stats };
}

// ---------------------------------------------------------------------------
// Request recorder
// ---------------------------------------------------------------------------

export interface Sent {
  op: string;
  variables: Record<string, any>;
}

const stops: (() => void)[] = [];

/** Every GraphQL operation sent from now on, in the order the requests started. */
export function recordOps() {
  const entries: Sent[] = [];
  const parsing: Promise<void>[] = [];
  const listener = ({ request }: { request: Request }) => {
    if (!request.url.endsWith('/graphql')) return;
    const slot: Sent = { op: '', variables: {} };
    entries.push(slot); // the slot is taken synchronously, so arrival order is exact
    parsing.push(
      request
        .clone()
        .json()
        .then((b: { operationName?: string; variables?: Record<string, any> }) => {
          slot.op = b.operationName ?? '';
          slot.variables = b.variables ?? {};
        }),
    );
  };
  server.events.on('request:start', listener);
  stops.push(() => server.events.removeListener('request:start', listener));
  const all = async (): Promise<Sent[]> => {
    await Promise.all(parsing);
    return entries;
  };
  return {
    all,
    named: async (op: string) => (await all()).filter((s) => s.op === op),
    count: async (op: string) => (await all()).filter((s) => s.op === op).length,
  };
}

export function stopRecording(): void {
  for (const stop of stops.splice(0)) stop();
}

// ---------------------------------------------------------------------------
// Running the steps
// ---------------------------------------------------------------------------

export interface HydrateRun {
  result: HydratePersistEnqueueResult;
  onProgress: jest.Mock;
  refreshStore: jest.Mock;
  awaitResumeIfPaused: jest.Mock;
}

/**
 * stepHydratePersistEnqueue with no-op hooks. `suppressEnqueue` and `background` default ON:
 * a foreground run that suppresses the enqueue still hands an idle pipeline its rows in the
 * tail flush, which reaches the gateway. Only the enqueue describe turns them off.
 */
export async function hydrate(
  diff: DiffResult,
  t: TestCtx,
  over: Partial<HydratePersistEnqueueOptions> = {},
): Promise<HydrateRun> {
  const onProgress = jest.fn();
  const refreshStore = jest.fn(async () => undefined);
  const awaitResumeIfPaused = jest.fn(async () => undefined);
  const result = await stepHydratePersistEnqueue(diff, t.ctx, {
    onProgress,
    refreshStore,
    awaitResumeIfPaused,
    suppressEnqueue: true,
    background: true,
    ...over,
  });
  return { result, onProgress, refreshStore, awaitResumeIfPaused };
}

/** fetch -> diff, the first two steps of a sync. */
export async function fetchAndDiff(t: TestCtx): Promise<{ fetched: FetchTopicIdsResult; diff: DiffResult }> {
  const fetched = await stepFetchTopicIds('', t.ctx);
  const diff = await stepDiff(fetched, t.ctx);
  return { fetched, diff };
}

/** A DiffResult built by hand, for a hydrate that needs ids the server never listed. */
export function diffOf(
  missingIds: string[],
  extra: Partial<DiffResult> = {},
): DiffResult {
  return {
    serverArticleIds: missingIds,
    articleToTopicTexts: new Map(),
    missingIds,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const suggestionRows = loadSuggestions;

/** The scorer-input columns of rows (stable cluster id, headline country, matched topics JSON). */
export async function stageRowsById(articleIds: string[]) {
  return new Map((await getStageRowsByIds(articleIds)).map((r) => [r.id, r]));
}

export async function rowsById() {
  return new Map((await loadSuggestions()).map((s) => [s._id, s]));
}

/** `saved_article_suggestions` rows (read only): no service lists retention rows, by design. */
export async function retentionRows(): Promise<{ id: string; origin: string | null }[]> {
  const rows = await database.get('saved_article_suggestions').query().fetch();
  return rows.map((r: any) => ({ id: r.id as string, origin: (r.origin ?? null) as string | null }));
}

// Fault injection (R26) and the real-timer waits live in the shared data helpers.
export { failSettingRead, failTableQuery, until, flush } from '../../support/faults';

// ---------------------------------------------------------------------------
// The scoring pipeline world (foreground enqueue reaches the gateway mock)
// ---------------------------------------------------------------------------

export const PIPELINE_NOW = new Date('2026-10-09T10:00:00.000Z').getTime();
const SCORE_TITLE = /News Title: Story (\S+)/g;

/** Limiter, fallback, attestation and JWT caches, sign-in, a fake clock and no foreground poller. */
export async function resetScoringWorld(): Promise<void> {
  resetLimiter();
  resetModelFallback();
  clearAttestationCache();
  invalidateJwtCache();
  __resetSuggestionsRefreshThrottleForTests();
  setAppState('inactive'); // no foreground poller: the test is the only driver of the run
  useUserStore.setState({ userPersona: { expoPushToken: 'ExponentPushToken[test]' } as never });
  await signInFixtureAccount();
  freezeClockAt(PIPELINE_NOW);
}

/** Article ids the gateway was asked to score, from the decrypted relevance prompts. */
export function scoredIds(): string[] {
  return gatewayCalls('job')
    .filter((c) => c.callId?.startsWith('score:'))
    .flatMap((c) => [...(c.messages.find((m) => m.role === 'user')?.content ?? '').matchAll(SCORE_TITLE)].map((m) => m[1]));
}

/** One limiter spacing later, one poll and one drain: what the foreground poller does. */
export async function tick(): Promise<void> {
  jest.setSystemTime(Date.now() + 1_100);
  await advanceUntilDone(scoringPipeline.pollTick('foreground'));
  await advanceUntilDone(scoringPipeline.recover());
}

// The fake clock patches process.hrtime, so take the real one at module load.
const realHrtime = process.hrtime.bigint.bind(process.hrtime);

// The gateway mock answers in real time and tickUntilScored may wait up to 15 s for it.
jest.setTimeout(20_000);

/** Tick until `count` ids are scored, bounded by 15 s of REAL time. */
export async function tickUntilScored(count: number): Promise<void> {
  const deadline = realHrtime() + 15_000_000_000n;
  while (new Set(scoredIds()).size < count && realHrtime() < deadline) await tick();
}

/** `hydrate` with the foreground enqueue ON, driven on the fake clock. */
export const foreground = (t: TestCtx, diff: DiffResult, over: Partial<HydratePersistEnqueueOptions> = {}) =>
  advanceUntilDone(hydrate(diff, t, { suppressEnqueue: false, background: false, ...over }));
