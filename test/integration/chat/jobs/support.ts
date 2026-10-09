// Shared kit for the async-job seam tests (not a test file: the integration project matches
// *.test.ts only). Everything runs against the real gateway mock: real E2EE both ways, real auth,
// the real limiter, real pako. Articles go in through the app's own services.
import { gunzipSync } from 'node:zlib';
import { invalidateJwtCache } from '@/lib/auth-client';
import { _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import { addFact } from '@/lib/database/services/fact-service';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { prepareE2EEContext, type E2EEContext } from '@/lib/e2ee/e2ee-service';
import { SMALL_MODEL } from '@/lib/llm/constants';
import type { ArticleWithClusters } from '@/lib/generated/graphql-types';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import * as scoringPipeline from '@/lib/services/scoring-pipeline';
import { __resetSuggestionsRefreshThrottleForTests } from '@/lib/services/SuggestionSyncService';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { runBackgroundCycle } from '@/lib/background/run-inference-handler';
import { getPipeline } from '@/lib/database/services/scoring-pipeline-store';
import { defaultResponder, gatewayCalls, mockGateway, server, setAppState, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules, useStrictClock as strictClock } from '@/test/integration/chat/_helpers';

export const PUSH_TOKEN = 'ExponentPushToken[test]';
export const JOBS_URL = '/v1/inference/jobs';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Steps the (strict) fake clock until `promise` settles; one REAL event-loop turn per step so MSW can answer. */
export async function drive<T>(promise: Promise<T>, maxMs = 120_000, stepMs = 50): Promise<T> {
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  for (let elapsed = 0; elapsed < maxMs && !done; elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    await turn();
  }
  return promise;
}

/** Steps the fake clock until `cond()` holds. */
export async function advanceUntil(cond: () => boolean, maxMs = 120_000, stepMs = 50): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs && !cond(); elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    await turn();
  }
  if (!cond()) throw new Error('advanceUntil: condition not met');
}

/** Module memory the integration setup does not reset. Does not sign in. */
export function resetJobModules(): void {
  resetChatModules();
  resetBreaker();
  invalidateJwtCache();
  // Not reset by resetChatModules(); a previous test file may have left on-device mode.
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
  useUserStore.setState({ userPersona: { expoPushToken: PUSH_TOKEN } as never });
}

/** A relevance fence the default responder counts (one 0.9 per fence). */
export const article = (n: number): string => {
  const id = String(n).padStart(12, 'a');
  return `<<ARTICLE ${id}>>\nbody ${n}\n<</ARTICLE ${id}>>`;
};

export interface TestCall {
  id: string;
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

/** A bundle of `n` score calls sharing one system prompt (the hoisted-sharedSystem shape). */
export function bundleOf(n = 1, system = 'shared relevance system'): { calls: TestCall[] } {
  return { calls: Array.from({ length: n }, (_, i) => ({ id: `score:${i}`, system, prompt: `${article(i * 2 + 1)}\n${article(i * 2 + 2)}` })) };
}

export const context = (model = SMALL_MODEL): Promise<E2EEContext> => prepareE2EEContext(model);

export interface JobPost {
  headers: Record<string, string>;
  /** The bytes that crossed the wire. */
  raw: Buffer;
  /** Inflated JSON, or null when the body was not gzip. */
  body: {
    expoPushToken?: string;
    e2eeSession: Record<string, string>;
    requests: { id: string; body: { messages: { role: string; content: string }[]; model: string; max_tokens?: number; temperature: number; chat_template_kwargs: { enable_thinking: boolean } } }[];
    sharedSystem?: string;
  } | null;
}

/** Records every POST to the job route as the wire carried it. Pending bodies resolve after a tick: await `settled()`. */
export function captureJobPosts(): { posts: JobPost[]; settled: () => Promise<void> } {
  const posts: JobPost[] = [];
  const pending: Promise<void>[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method !== 'POST' || !request.url.endsWith(JOBS_URL)) return;
    const headers = Object.fromEntries(request.headers.entries());
    const index = posts.length;
    posts.push({ headers, raw: Buffer.alloc(0), body: null });
    pending.push(
      request
        .clone()
        .arrayBuffer()
        .then((buf) => {
          const raw = Buffer.from(buf);
          posts[index].raw = raw;
          if (raw[0] === 0x1f && raw[1] === 0x8b) posts[index].body = JSON.parse(gunzipSync(raw).toString('utf8'));
        }),
    );
  });
  return { posts, settled: async () => void (await Promise.all(pending)) };
}

/** Every request path the app sent to the auth server, in order. */
export function watchAuthRequests(): string[] {
  const paths: string[] = [];
  server.events.on('request:start', ({ request }) => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/auth/')) paths.push(pathname);
  });
  return paths;
}

// --- seeding for the cycle tests ------------------------------------------------------------------

export interface SeedArticle {
  id: string;
  title?: string;
  publication?: string | null;
  clusterId?: string;
  /** No linked fact: a row the pipeline must not score. */
  factless?: boolean;
}

let topic: { topicId: string; text: string } | null = null;

export function resetSeeds(): void {
  topic = null;
}

/** Unscored article rows the way feed-sync hydration writes them. Fact-backed rows link through one fact + topic. */
export async function seedArticles(articles: SeedArticle[]): Promise<void> {
  if (!topic && articles.some((a) => !a.factless)) {
    const fact = await addFact('I follow Formula 1 racing');
    const [t] = await createTopics([{ factId: fact.id, text: 'formula 1', weight: 1 }]);
    topic = { topicId: t.id, text: 'formula 1' };
  }
  const fetched = articles.map(
    (a) =>
      ({
        _id: a.id,
        title: a.title ?? `Story ${a.id} saga${a.id}`,
        title_en: a.title ?? `Story ${a.id} saga${a.id}`,
        description_en: `Details of story ${a.id}`,
        publication_name: a.publication ?? null,
        language_code: 'en',
        country_code: null,
        pubDate: new Date(Date.now() - 2 * 3600_000).toISOString(),
        clusters: a.clusterId ? [{ clusterId: a.clusterId, confidence: 0.9 }] : [],
      }) as unknown as ArticleWithClusters,
  );
  await persistAndLinkV2Suggestions(fetched, new Map(), {
    matchedTopics: new Map(articles.map((a) => [a.id, a.factless || !topic ? [] : [{ topicId: topic.topicId, text: topic.text }]])),
    headlineScope: new Map(),
  });
}

export const ids = (n: number, prefix = 'id'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// --- the scoring cycle world ------------------------------------------------------------------

export const NOW = new Date('2026-10-09T10:00:00.000Z').getTime();

/** Auth-server requests that carried a session cookie (what a locked or quarantined read would not send). */
export function watchCookieAuthRequests(): string[] {
  const paths: string[] = [];
  server.events.on('request:start', ({ request }) => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/auth/') && request.headers.get('cookie')) paths.push(pathname);
  });
  return paths;
}

/** Every GET /results the app made: job id and Authorization, in order. */
export function watchResultsGets(): { id: string; auth: string }[] {
  const gets: { id: string; auth: string }[] = [];
  server.events.on('request:start', ({ request }) => {
    const m = /\/v1\/inference\/jobs\/([^/]+)\/results$/.exec(new URL(request.url).pathname);
    if (m && request.method === 'GET') gets.push({ id: m[1], auth: request.headers.get('authorization') ?? '' });
  });
  return gets;
}

/** The state every cycle test starts from. AppState inactive: the foreground poller never starts, the test drives. */
export async function resetCycleWorld(): Promise<void> {
  resetJobModules();
  scoringPipeline._resetForTests();
  __resetSuggestionsRefreshThrottleForTests();
  resetSeeds();
  setAppState('inactive');
  useForYouStore.setState({
    suggestions: [],
    asyncJobPhase: 'idle',
    batchProgress: null,
    chunkStates: null,
    reasonsInFlightIds: new Set<string>(),
    lastProcessingRunFinishedAt: null,
  });
  await signInFixtureAccount();
  strictClock(NOW);
}

/** The gateway mock with `pendingPolls` unfinished polls per job (a job's CONTENT is fixed at submit). */
export function gatewayPolls(pendingPolls: number): void {
  server.use(...mockGateway(defaultResponder, { pendingPolls }));
}

/**
 * Submit one relevance job per group of fresh articles through the real scoring-pass cycle, leaving
 * every job unfinished on the gateway. Returns the request ids in batch order.
 */
export async function submitJobs(...groups: string[][]): Promise<string[]> {
  gatewayPolls(999);
  for (const group of groups) {
    await seedArticles(group.map((id) => ({ id })));
    await drive(runBackgroundCycle('scoring-pass'));
  }
  // The limiter spaces submits 1s apart: a later batch may still be queued after its pass.
  for (let i = 0; i < 10; i++) {
    const batches = (await getPipeline())?.run.batches ?? [];
    if (batches.length === groups.length && batches.every((b) => b.requestId)) break;
    await jest.advanceTimersByTimeAsync(1_100);
    await drive(scoringPipeline.pollTick('foreground'));
  }
  const batches = (await getPipeline())?.run.batches ?? [];
  if (batches.length !== groups.length || batches.some((b) => !b.requestId)) {
    throw new Error(`submitJobs: wanted ${groups.length} submitted batches, have ${JSON.stringify(batches.map((b) => b.phase))}`);
  }
  return batches.map((b) => b.requestId as string);
}

/**
 * Tick the way the foreground poller does (a limiter slot between ticks) until `cond()` holds or six
 * ticks have passed. The first submit of a run waits behind the run's attestation fetch for a slot,
 * so a cycle can return before its job reaches the gateway; the test asserts on the outcome itself.
 */
export async function settleUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 6 && !cond(); i++) {
    await jest.advanceTimersByTimeAsync(1_100);
    await drive(scoringPipeline.pollTick('foreground'));
    await drive(scoringPipeline.recover());
  }
}

/** Until the first job has reached the gateway. */
export const settleSubmits = (): Promise<void> => settleUntil(() => gatewayCalls('job').length > 0);

export const reasonJobCalls = () => gatewayCalls('job').filter((c) => c.callId?.startsWith('reason:'));
