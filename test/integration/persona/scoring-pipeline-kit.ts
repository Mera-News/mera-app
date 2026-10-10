// Shared kit for the scoring-pipeline seam tests (not a test file: the integration project only
// matches *.test.ts). The pipeline runs for real: in-memory DB, real stores, real gateway client,
// the gateway mock (async jobs, real E2EE both ways). Articles and facts go in through the app's
// own services; the run is read back through scoring-pipeline-store.
import { gunzipSync } from 'node:zlib';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@/lib/e2ee/e2ee-crypto';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { fetchModelPublicKey } from '@/lib/e2ee/e2ee-service';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { invalidateJwtCache } from '@/lib/auth-client';
import { addFact } from '@/lib/database/services/fact-service';
import { loadSuggestions } from '@/lib/database/services/article-suggestion-reads';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-persist';
import {
  getPipeline,
  mutatePipeline,
  type PipelineBatch,
  type PipelineRun,
} from '@/lib/database/services/scoring-pipeline-store';
import { createTopics } from '@/lib/database/services/topic-service';
import type { ArticleWithClusters } from '@/lib/generated/graphql-types';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import * as scoringPipeline from '@/lib/services/scoring-pipeline';
import { __resetSuggestionsRefreshThrottleForTests } from '@/lib/services/SuggestionSyncService';
import { useForYouStore, type ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import {
  advanceUntilDone,
  gatewayCalls,
  http,
  HttpResponse,
  mockGateway,
  server,
  setAppState,
  signInFixtureAccount,
  useFakeClock as installFakeClock,
  type GatewayCall,
  type GatewayResponder,
} from '@/test/helpers';

export const NOW = new Date('2026-10-09T10:00:00.000Z').getTime();
export const PUSH_TOKEN = 'ExponentPushToken[test]';

/** Ids `prefix0..prefix{n-1}`. */
export function ids(n: number, prefix = 'id'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

let seededTopic: { topicId: string; text: string } | null = null;

/**
 * The state every test starts from. Call from `beforeEach`.
 * `poller: false` (default) leaves AppState inactive, so the foreground poller never starts and
 * the test is the only thing driving the run (pollTick / handlePush / recover). `poller: true`
 * is the real foreground: the poller ticks as fake time passes.
 */
export async function resetPipelineWorld(opts: { poller?: boolean } = {}): Promise<void> {
  scoringPipeline._resetForTests();
  resetLimiter();
  resetModelFallback();
  clearAttestationCache();
  invalidateJwtCache();
  __resetSuggestionsRefreshThrottleForTests();
  seededTopic = null;
  heldBy = null;
  holdInstalled = false;
  setAppState(opts.poller ? 'active' : 'inactive');
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
  useUserStore.setState({ userPersona: { expoPushToken: PUSH_TOKEN } as never });
  useForYouStore.setState({
    suggestions: [],
    asyncJobPhase: 'idle',
    batchProgress: null,
    chunkStates: null,
    reasonsInFlightIds: new Set<string>(),
    lastProcessingRunFinishedAt: null,
  });
  await signInFixtureAccount();
  installFakeClock(NOW);
}

/**
 * When a run finalizes with rows still unscored, the post-finalize kick re-enqueues them on the
 * next timer turn (a new attestation fetch, maybe a new run). A test that ends right after its run
 * finalized lets the kick play out first: a fetch left pending on the fake clock when the test ends
 * is joined by every later test in the file and hangs it.
 */
export async function letKickPlayOut(): Promise<void> {
  await passTime(3_000);
}

/** Remove request listeners a test added; call from `afterEach`. */
export function cleanupWorld(): void {
  server.events.removeAllListeners();
}

export interface SeedOptions {
  /** Extra fields on the hydrated article (tags: entities, event_type, geo_tags ...). */
  extra?: Record<string, unknown>;
  /** Top-headline rows: factless by design, scope recorded on the row. */
  headline?: 'CITY' | 'COUNTRY' | 'GLOBAL';
  /** No linked fact and no headline scope: a row the pipeline must not score. */
  factless?: boolean;
  /** Title override (default `Story <id> saga<id>`: distinct vocabulary per row, so the story gate never groups them; the scripted responder keys on `Story <id>`). */
  title?: (id: string) => string;
  description?: string | null;
  clusterId?: string;
}

/**
 * Insert unscored article rows the way feed-sync hydration does. Fact-backed rows link through
 * one fact + topic created on first use (a row with no fact and no headline scope is unscorable).
 */
export async function seedArticles(articleIds: string[], opts: SeedOptions = {}): Promise<void> {
  if (!seededTopic && !opts.headline && !opts.factless) {
    const fact = await addFact('I follow Formula 1 racing');
    const [topic] = await createTopics([{ factId: fact.id, text: 'formula 1', weight: 1 }]);
    seededTopic = { topicId: topic.id, text: 'formula 1' };
  }
  const topic = seededTopic;
  const fetched = articleIds.map(
    (id) =>
      ({
        _id: id,
        title: opts.title?.(id) ?? `Story ${id} saga${id}`,
        title_en: opts.title?.(id) ?? `Story ${id} saga${id}`,
        description_en: opts.description === undefined ? `Details of story ${id}` : opts.description,
        language_code: 'en',
        country_code: null,
        pubDate: '2026-10-09T08:00:00.000Z',
        clusters: opts.clusterId ? [{ clusterId: opts.clusterId, confidence: 0.9 }] : [],
        ...opts.extra,
      }) as unknown as ArticleWithClusters,
  );
  await persistAndLinkV2Suggestions(fetched, new Map(), {
    matchedTopics: new Map(
      articleIds.map((id) => [
        id,
        opts.headline || opts.factless || !topic ? [] : [{ topicId: topic.topicId, text: topic.text }],
      ]),
    ),
    headlineScope: new Map(
      opts.headline ? articleIds.map((id) => [id, opts.headline as string] as [string, string]) : [],
    ),
  });
}

/** Every stored row as the Feed sees it, keyed by article id (`status`, `relevance`, `reason`, ...). */
export async function rows(): Promise<Record<string, ForYouSuggestion>> {
  return Object.fromEntries((await loadSuggestions()).map((s) => [s._id, s]));
}

/** Persisted run, or null when none exists. */
export async function currentRun() {
  return (await getPipeline())?.run ?? null;
}

/** The persisted batches of the run (throws when there is no run: a test that expects none asserts `currentRun()`). */
export async function batches() {
  const run = await currentRun();
  if (!run) throw new Error('no pipeline run');
  return run.batches;
}

/**
 * Rewrite persisted state through the store's own CAS. Only for a scenario the pipeline cannot
 * produce in one process: a run left behind by a crash, an OS task hours ago, or an older build.
 */
export async function patchRun(fn: (run: PipelineRun) => void): Promise<void> {
  await mutatePipeline((run) => {
    fn(run);
    return true;
  });
}

export const patchBatch = (batchId: number, fn: (b: PipelineBatch & Record<string, unknown>) => void) =>
  patchRun((run) => fn(run.batches.find((b) => b.batchId === batchId) as never));

export const phases = async () => (await batches()).map((b) => b.phase);

/** Let `ms` of fake time pass while real I/O (MSW) resolves; fires timers (limiter, poller). */
export async function passTime(ms: number): Promise<void> {
  const step = 50;
  for (let t = 0; t < ms; t += step) await jest.advanceTimersByTimeAsync(step);
}

/** Drive a pipeline call that waits on the limiter or the network to completion. */
export const drive = <T>(p: Promise<T>): Promise<T> => advanceUntilDone(p);

/** One limiter spacing later (MIN_GATEWAY_INTERVAL_MS), so the next gateway action gets a slot. */
export function later(ms = 1_100): void {
  jest.setSystemTime(Date.now() + ms);
}

/** Fetch the model attestation now, then wait out the slot it took: the next submit goes at once. */
export async function warmAttestation(): Promise<void> {
  await drive(fetchModelPublicKey(SMALL_MODEL));
  later();
}

/** Install the scripted gateway. `pendingPolls` keeps every job unfinished for that many polls. */
export function gateway(script: Script = {}, opts: { pendingPolls?: number; curve?: 'ecdsa' | 'ed25519' } = {}): void {
  server.use(
    ...mockGateway(scripted(script), {
      pendingPolls: opts.pendingPolls ?? 0,
      curve: opts.curve ? { [SMALL_MODEL]: opts.curve } : undefined,
    }),
  );
}

let heldBy: ((requestId: string) => boolean) | null = null;
let holdInstalled = false;

/**
 * Answer `pending` for the jobs `isHeld(requestId)` names; every other job falls through to the
 * mock. `holdJobs(null)` releases them all. (A job's CONTENT is fixed when it is submitted; this
 * only decides whether a poll finds it finished.)
 */
export function holdJobs(isHeld: ((requestId: string) => boolean) | null): void {
  heldBy = isHeld;
  if (holdInstalled) return;
  holdInstalled = true;
  server.use(
    http.get('*/v1/inference/jobs/:id/results', ({ params }) =>
      heldBy?.(String(params.id)) ? HttpResponse.json({ pending: true }) : undefined,
    ),
  );
}

/** Every results GET costs `ms` of wall clock before it is answered (a slow download + decrypt). */
export function slowResults(ms: number): void {
  server.use(
    http.get('*/v1/inference/jobs/:id/results', () => {
      jest.setSystemTime(Date.now() + ms);
      return undefined;
    }),
  );
}

/** Authorization header of every results GET, in order. */
export function watchResultsAuth(): string[] {
  const auth: string[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'GET' && /\/v1\/inference\/jobs\/[^/]+\/results$/.test(new URL(request.url).pathname)) {
      auth.push(request.headers.get('authorization') ?? '');
    }
  });
  return auth;
}

/** Job POSTs the mock accepted, one entry per job: its Authorization and Idempotency-Key. */
export function jobSubmits(): { auth: string; key: string; calls: string[] }[] {
  const byKey = new Map<string, { auth: string; key: string; calls: string[] }>();
  for (const c of gatewayCalls('job')) {
    const key = c.headers['idempotency-key'] ?? '';
    const job = byKey.get(key) ?? { auth: c.headers['authorization'] ?? '', key, calls: [] };
    job.calls.push(c.callId ?? '');
    byKey.set(key, job);
  }
  return [...byKey.values()];
}

/**
 * One foreground poller tick, one limiter spacing after the last gateway action: what runPollerTick
 * does (pollTick, then a drain that admits queued batches and finalizes a finished run). The drain
 * is reached through recover(), the exported entry that runs it.
 */
export async function tick(): Promise<void> {
  later();
  await drive(scoringPipeline.pollTick('foreground'));
  await drive(scoringPipeline.recover());
}

/** Tick until `cond()` holds (a foreground that is not running its own poller). */
export async function tickUntil(cond: () => Promise<boolean> | boolean, max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await cond()) return;
    await tick();
  }
  if (!(await cond())) throw new Error(`tickUntil: not met after ${max} ticks, phases=${JSON.stringify(await phases().catch(() => null))}`);
}

/**
 * Poll ticks with a gateway slot free at EVERY action and no time passing between them: what the
 * real 1 req/s limiter gives a run only after waiting. Three pending jobs polled with exponential
 * backoff saturate that limiter, so a queued batch behind them never reaches a slot; a test about
 * which batch is ADMITTED (not about timing) uses this instead of waiting it out.
 */
export async function burstUntil(cond: () => Promise<boolean> | boolean, max = 12): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await cond()) return;
    resetLimiter();
    await drive(scoringPipeline.pollTick('foreground'));
  }
  if (!(await cond())) throw new Error(`burstUntil: not met after ${max} ticks, phases=${JSON.stringify(await phases().catch(() => null))}`);
}

/** A 64-byte value that is not a point on secp256k1 (an ed25519 key doubled). Fresh per call:
 *  e2ee-service reports each distinct bad key once. */
export function offCurveKeyHex(): string {
  const pub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  return bytesToHex(Uint8Array.from([...pub, ...pub]));
}

/** Make the attestation route serve `key` (and forget any cached attestation). */
export function serveAttestationKey(key: string): void {
  clearAttestationCache();
  server.use(
    http.get('*/api/attestation/report', () =>
      HttpResponse.json({ model_attestations: [{ signing_public_key: key }] }),
    ),
  );
}

/** Gateway traffic in order: 'poll' (GET /results) and 'submit' (POST /jobs). */
export function watchTraffic(): string[] {
  const log: string[] = [];
  server.events.on('request:start', ({ request }) => {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && /\/v1\/inference\/jobs\/[^/]+\/results$/.test(pathname)) log.push('poll');
    if (request.method === 'POST' && pathname.endsWith('/v1/inference/jobs')) log.push('submit');
  });
  return log;
}

/**
 * The post-finalize kick re-enqueues leftover unscored rows. A test whose run ends in a gateway-free
 * way (abort, abandon) and has leftovers switches to on-device mode first, where enqueue is a no-op.
 * Never use this before a step that talks to the gateway: on-device mode refuses cloud calls.
 */
export function holdKick(): void {
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
}

/** Every GET /results the app made so far (request ids, in order). */
export function watchResultsPolls(): string[] {
  const polls: string[] = [];
  server.events.on('request:start', ({ request }) => {
    const m = /\/v1\/inference\/jobs\/([^/]+)\/results$/.exec(new URL(request.url).pathname);
    if (m) polls.push(m[1]);
  });
  return polls;
}

/** Make every article older than the dispatch-wait escape (MAX_UNSCORED_WAIT_MS). */
export function ageRows(): void {
  jest.setSystemTime(Date.now() + scoringPipeline.MAX_UNSCORED_WAIT_MS + 1_000);
}

/**
 * Seed fact-backed articles and enqueue them. Rows are fresh (the clock is frozen), so a lot under
 * MIN_DISPATCH is deferred unless `flush` is set or `stale` ages them past MAX_UNSCORED_WAIT_MS.
 * Ageing jumps the clock 30 minutes, which also expires the cached attestation: the run's creation
 * then takes the limiter slot and the first batch stays `queued`.
 */
export async function seedAndEnqueue(
  articleIds: string[],
  opts: SeedOptions & { flush?: boolean; stale?: boolean } = {},
) {
  await seedArticles(articleIds, opts);
  if (opts.stale) ageRows();
  return drive(scoringPipeline.enqueueCandidates(articleIds, opts.flush ?? false));
}

// --- scripted gateway ----------------------------------------------------

export interface Script {
  /** Relevance score per article id (default `defaultScore`). */
  scores?: Record<string, number>;
  defaultScore?: number;
  /** Reason text per article id. `null` makes the call fail (row owed a note). */
  notes?: Record<string, string | null>;
  /** Pass-2 rescore per article id: reply is `{"k","s","reason"}`. */
  rescores?: Record<string, { k: string; s: number }>;
  /** Every relevance call fails upstream (the job row comes back `ok: false`). */
  failScores?: boolean;
  /** Reply `{"keep":..., "why":...}` verdicts (legacyNoteDemote) instead of prose. */
  verdicts?: Record<string, { keep: boolean; why?: string } | 'junk'>;
}

/** Relevance and reasons prompts both carry the article title (`Story <id>`); a reasons call id is only a position. */
export function scripted(script: Script = {}): GatewayResponder {
  return (call: GatewayCall) => {
    const user = call.messages.find((m) => m.role === 'user')?.content ?? '';
    if (call.callId?.startsWith('score:')) {
      if (script.failScores) return { status: 500 };
      // One score per article block, in order; a block whose title is not `Story <id>` gets the default.
      const blocks = user.split(/===== Article \d+ =====/).slice(1);
      return JSON.stringify(
        blocks.map((b) => {
          const id = /News Title: Story (\S+)/.exec(b)?.[1];
          return (id !== undefined ? script.scores?.[id] : undefined) ?? script.defaultScore ?? 0.9;
        }),
      );
    }
    if (call.callId?.startsWith('reason:')) {
      const id = /News Title: Story (\S+)/.exec(user)?.[1] ?? '';
      const verdict = script.verdicts?.[id];
      if (verdict === 'junk') return 'I am not JSON';
      if (verdict) return JSON.stringify(verdict);
      if (script.verdicts) return JSON.stringify({ keep: true, why: `Why story ${id} matters here.` });
      if (script.notes && id in script.notes) {
        const note = script.notes[id];
        if (note === null) return { status: 500 };
        return note;
      }
      const note = `Why story ${id} matters here.`;
      const rescore = script.rescores?.[id];
      return rescore ? JSON.stringify({ ...rescore, reason: note }) : note;
    }
    return '[]';
  };
}

/** Job submits seen so far, decoded: `{ headers, body }` (the push token rides in the body). */
export function captureSubmits(): { token: string | null; key: string; calls: string[] }[] {
  const seen: { token: string | null; key: string; calls: string[] }[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method !== 'POST' || !request.url.endsWith('/v1/inference/jobs')) return;
    const key = request.headers.get('idempotency-key') ?? '';
    void request
      .clone()
      .arrayBuffer()
      .then((buf) => {
        const raw = Buffer.from(buf);
        const text = (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString('utf8');
        const body = JSON.parse(text) as { expoPushToken?: string; requests: { id: string }[] };
        seen.push({ token: body.expoPushToken ?? null, key, calls: body.requests.map((r) => r.id) });
      });
  });
  return seen;
}
