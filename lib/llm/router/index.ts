// The model router: which profile serves a lane, in what order, and what a failure means.
//
// Order comes from the gateway's routing table (GET /v1/routing, fetched on launch and again
// whenever a reply's X-Mera-Routing version differs from the one held), or DEFAULT_TABLE when
// the gateway has not answered. A model-class failure marks the profile for this process and the
// caller moves to the next one at once: no backoff, no jitter. A marked profile sinks to the end
// of the order rather than leaving it, so a lane always has something to try and a recovered
// model is found by the next call that gets that far.
//
// Mode-aware: in on-device mode the cloud lanes route nothing, except the chat lanes while the
// reader has chat in the cloud on. assertCloudAllowed stays the backstop at every entry point.
//
// Sentry: an absorbed failure is a breadcrumb; a lane whose whole chain failed is ONE error event.
// Stores are required lazily: their modules build collections at import time.

import { useMemo } from 'react';
import { create } from 'zustand';
import { INFERENCE_ENDPOINT } from '@/lib/config/endpoints';
import logger from '../../logger';
import { useNetworkStore } from '../../stores/network-store';
import * as gatewayRateLimiter from '../gateway-rate-limiter';
import {
  AppLeftError,
  CleartextToolCallError,
  EmptyReplyError,
  RateLimitedError,
  StreamIdleError,
  isAbortLike,
  isCallerAbort,
} from '../gateway-fetch';
import {
  DEFAULT_TABLE,
  isProfileId,
  servesBatch,
  MODEL_LABELS,
  PROFILES,
  PROVIDER_INFO,
  type Profile,
  type ProfileId,
  type Provider,
} from '../profiles';
import { CHAT_LANES, LANES, type Lane } from './lanes';
import { loadHarness } from '../../harnesses';

export type { Lane } from './lanes';
export { LANES, CHAT_LANES } from './lanes';

/** What a model failure was. Everything else (401, 429, offline, a stop, the app leaving) is not one. */
export type FailureClass =
  | 'attestation' // attestation 5xx, timeout, empty body, or a key that fails verification
  | 'upstream' // the gateway answered 5xx for the model
  | 'model_unavailable' // the gateway's own fast-fail: the profile is down in its table
  | 'empty' // a 2xx with no reply in it
  | 'deadline' // no first token within the harness deadline, or the stream went idle
  | 'unparseable'; // the reply could not be read as what the caller asked for

export type LaneState = 'ok' | 'degraded' | 'down';

export interface RoutingTable {
  version: number;
  updatedAt?: string;
  lanes: Partial<Record<Lane, { state: LaneState; profiles: string[] }>>;
}

export interface RoutingState {
  version: number;
  lanes: Record<Lane, {
    state: LaneState;
    active: { id: string; provider: Provider; providerName: string; providerUrl: string; modelLabel: string } | null;
  }>;
}

/** A profile marked failed stays at the end of the order this long, unless a newer table or a success clears it.
 *  Longer than a background lane's 120s deadline, or a slow chain would forget its first mark before its last try. */
export const MARK_MS = 300_000;
/** A failed table fetch is not retried sooner than this, however many replies name a new version. */
const REFRESH_FLOOR_MS = 10_000;
const ROUTING_URL = `${INFERENCE_ENDPOINT}/v1/routing`;
const ROUTING_TIMEOUT_MS = 10_000;

const defaultTable = (): RoutingTable => ({ version: 0, lanes: {} });

let table: RoutingTable = defaultTable();
const marks = new Map<ProfileId, number>();
let refreshing: Promise<void> | null = null;
let lastRefreshAt = 0;

/** Bumped on every change a reader can see; useRoutingState re-reads on it. */
const useRouterTick = create<{ tick: number }>(() => ({ tick: 0 }));
const bump = () => useRouterTick.setState((s) => ({ tick: s.tick + 1 }));

function modeState(): { processingMode: string; chatInCloud: boolean } | null {
  try {
    const { useMeraProtocolStore } =
      require('../../stores/mera-protocol-store') as typeof import('../../stores/mera-protocol-store');
    return useMeraProtocolStore.getState();
  } catch {
    return null;
  }
}

/** False for a cloud lane while processing is on the phone, unless it is chat and chat is in the cloud. */
export function laneRoutes(lane: Lane): boolean {
  const s = modeState();
  if (!s || s.processingMode !== 'ON_DEVICE') return true;
  return CHAT_LANES.includes(lane) && s.chatInCloud === true;
}

const isMarked = (id: ProfileId, now: number): boolean => {
  const at = marks.get(id);
  if (at === undefined) return false;
  if (now - at < MARK_MS) return true;
  marks.delete(id);
  return false;
};

export interface RouteOptions {
  /** A batch or an async job: only profiles that can serve one (lib/llm/profiles servesBatch). */
  batch?: boolean;
}

/** True while `id` is marked failed (diagnostics and tests). */
export const isProfileMarked = (id: ProfileId): boolean => isMarked(id, Date.now());

/** The profiles to try for `lane`, healthy first. Empty only when the mode keeps the lane off the cloud. */
export function routeLane(lane: Lane, opts: RouteOptions = {}): Profile[] {
  if (!laneRoutes(lane)) return [];
  const entry = table.lanes[lane];
  const listed = (entry?.profiles ?? []).filter(isProfileId);
  // The table lists only healthy profiles, so a down lane has nothing to try: no attestation and no
  // send, the caller fails as chain-exhausted. refreshRoutingSoon() is how it finds the way back.
  if (entry?.state === 'down' && listed.length === 0) return [];
  const ranked = listed.length > 0 ? listed : DEFAULT_TABLE[lane];
  const now = Date.now();
  const healthy = ranked.filter((id) => !isMarked(id, now));
  const sick = ranked.filter((id) => isMarked(id, now));
  return [...healthy, ...sick]
    .map((id) => PROFILES[id])
    // A harness names the lanes its model qualified for; a table listing it elsewhere is ignored.
    .filter((p) => loadHarness(p.harness).lanes.includes(lane))
    .filter((p) => !opts.batch || servesBatch(p));
}

function setLaneOutage(lane: Lane, info: { since: number } | null): void {
  try {
    const { useForYouStore } =
      require('../../stores/for-you-store') as typeof import('../../stores/for-you-store');
    useForYouStore.getState().setLaneOutage?.(lane, info);
  } catch {
    // The store could not load (a test without a database): the outage line is the only loss.
  }
}

/** A model-class failure on `profile`: it sinks to the end of every lane's order. Breadcrumb only. */
export function reportProfileFailure(profile: Profile, lane: Lane, failureClass: FailureClass): void {
  marks.set(profile.id, Date.now());
  logger.addBreadcrumb('model profile failed, next profile', 'router', {
    lane,
    profile: profile.id,
    failure_class: failureClass,
    routing_version: table.version,
  }, 'warning');
  bump();
}

/** `profile` answered on `lane`: its mark goes and the lane's outage ends. */
export function reportProfileSuccess(profile: Profile, lane: Lane): void {
  setLaneOutage(lane, null);
  if (marks.delete(profile.id)) bump();
}

/** Content-free: carries the lane only. Thrown as is when a lane had no profile it could try; a 503 to every outage check. */
export class LaneExhaustedError extends Error {
  readonly statusCode = 503;
  constructor(lane: Lane) {
    super(`Every model profile failed on lane ${lane}`);
    this.name = 'LaneExhaustedError';
  }
}

/** Every profile on `lane` failed: the lane is out, and Sentry gets its one error event. */
export function reportLaneExhausted(lane: Lane, profile: Profile | null, failureClass: FailureClass): void {
  setLaneOutage(lane, { since: Date.now() });
  logger.captureException(new LaneExhaustedError(lane), {
    level: 'error',
    tags: { lane, profile: profile?.id ?? 'none', failure_class: failureClass, routing_version: String(table.version) },
    fingerprint: ['lane-exhausted', lane],
  });
}

/**
 * Is `err` evidence about the model? Returns its class, or null for everything that is not:
 * a stop, the app leaving, a throttle, a privacy refusal, a dead session, and anything at all
 * while the device is offline (an offline socket times out exactly like a stalled model).
 */
export function failureClassOf(err: unknown): FailureClass | null {
  if (!useNetworkStore.getState().isConnected) return null;
  if (isCallerAbort(err) || err instanceof AppLeftError || err instanceof RateLimitedError) return null;
  if (err instanceof CleartextToolCallError) return null;
  if (err instanceof EmptyReplyError) return 'empty';
  if (err instanceof StreamIdleError) return 'deadline';
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'AttestationVerifyError' || name === 'ModelKeyValidationError') return 'attestation';
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (name === 'NearAttestationError') {
    // 4xx is the session or the request, never the model; an empty 2xx is the provider's.
    const s = typeof status === 'number' ? status : 0;
    return s >= 500 || (s >= 200 && s < 300) ? 'attestation' : null;
  }
  // An HTTP answer was classified by its status before it became an error; its body may say "abort".
  if (typeof status === 'number') return null;
  // A report the provider served in a shape the key cannot be read from (lib/e2ee throws these untyped).
  if (err instanceof Error && /^(NEAR|RedPill) attestation: /.test(err.message)) return 'attestation';
  if (isAbortLike(err)) return 'deadline';
  return null;
}

/** The class of a gateway HTTP answer, or null when the status says nothing about the model. */
export function failureClassOfStatus(status: number, body: string): FailureClass | null {
  if (status < 500) return null;
  if (status === 503 && /model_unavailable/.test(body)) return 'model_unavailable';
  return 'upstream';
}

/** Takes a /v1/routing body (or the `routing` field of a fast-fail 503). Ignores anything malformed. */
export function applyRoutingTable(body: unknown): void {
  const t = body as RoutingTable | null;
  if (!t || typeof t.version !== 'number' || typeof t.lanes !== 'object' || t.lanes === null) return;
  if (t.version === table.version) return;
  table = { version: t.version, updatedAt: t.updatedAt, lanes: t.lanes };
  // The gateway re-probed since our marks: its word is fresher.
  marks.clear();
  for (const lane of LANES) {
    if (t.lanes[lane]?.state === 'down') setLaneOutage(lane, { since: Date.now() });
  }
  bump();
}

/** Fetches the routing table. Never throws; on failure the table held (or the default) stays. */
export function refreshRouting(): Promise<void> {
  if (refreshing) return refreshing;
  lastRefreshAt = Date.now();
  refreshing = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROUTING_TIMEOUT_MS);
    try {
      // Unauthenticated and content-free, but still a gateway request: it waits its turn.
      await gatewayRateLimiter.acquire('background', controller.signal);
      const res = await fetch(ROUTING_URL, { signal: controller.signal });
      if (!res.ok) throw new Error(`routing ${res.status}`);
      applyRoutingTable(await res.json());
    } catch (err) {
      logger.debug('[router] routing table fetch failed, keeping the table held', { error: String(err) });
    } finally {
      clearTimeout(timer);
      refreshing = null;
    }
  })();
  return refreshing;
}

/** A lane the table says is down sends nothing, so no reply can name a newer table: ask for one, at most every REFRESH_FLOOR_MS. */
export function refreshRoutingSoon(): void {
  if (Date.now() - lastRefreshAt >= REFRESH_FLOOR_MS) void refreshRouting();
}

/** Every gateway reply names the table version; a different one means ours is stale. */
export function noteRoutingVersion(header: string | null | undefined): void {
  if (header == null || header === '') return;
  const version = Number(header);
  if (!Number.isFinite(version) || version === table.version) return;
  if (Date.now() - lastRefreshAt < REFRESH_FLOOR_MS) return;
  void refreshRouting();
}

export const routingVersion = (): number => table.version;

/** The top two profiles of every lane that routes, once each: what a launch attests ahead of use. */
export function profilesToPreattest(): Profile[] {
  const seen = new Map<ProfileId, Profile>();
  for (const lane of LANES) for (const p of routeLane(lane).slice(0, 2)) seen.set(p.id, p);
  return [...seen.values()];
}

function outageOf(lane: Lane): boolean {
  try {
    const { useForYouStore } =
      require('../../stores/for-you-store') as typeof import('../../stores/for-you-store');
    return Boolean(useForYouStore.getState().laneOutage?.[lane]);
  } catch {
    return false;
  }
}

const WORSE: Record<LaneState, number> = { ok: 0, degraded: 1, down: 2 };
const worst = (a: LaneState, b: LaneState): LaneState => (WORSE[a] >= WORSE[b] ? a : b);

/** The router as the provider card reads it: per lane, its state and the profile a call would use first. */
export function routingSnapshot(): RoutingState {
  const lanes = {} as RoutingState['lanes'];
  for (const lane of LANES) {
    const head = routeLane(lane)[0] ?? null;
    const local: LaneState = outageOf(lane) ? 'down' : head && head.id !== DEFAULT_TABLE[lane][0] ? 'degraded' : 'ok';
    lanes[lane] = {
      state: worst(table.lanes[lane]?.state ?? 'ok', local),
      active: head && {
        id: head.id,
        provider: head.provider,
        providerName: PROVIDER_INFO[head.provider].name,
        providerUrl: PROVIDER_INFO[head.provider].url,
        modelLabel: MODEL_LABELS[head.harness] ?? head.model,
      },
    };
  }
  return { version: table.version, lanes };
}

/** Reactive routingSnapshot(): re-reads on any router change, a mode change and a lane outage. */
export function useRoutingState(): RoutingState {
  const { useMeraProtocolStore } =
    require('../../stores/mera-protocol-store') as typeof import('../../stores/mera-protocol-store');
  const { useForYouStore } =
    require('../../stores/for-you-store') as typeof import('../../stores/for-you-store');
  const tick = useRouterTick((s) => s.tick);
  const mode = useMeraProtocolStore((s) => `${s.processingMode}:${s.chatInCloud}`);
  const outage = useForYouStore((s) => s.laneOutage);
  return useMemo(() => routingSnapshot(), [tick, mode, outage]);
}

/** Test seam: the default table, no marks, nothing in flight. */
export function __resetRouterForTests(): void {
  table = defaultTable();
  marks.clear();
  refreshing = null;
  lastRefreshAt = 0;
  bump();
}
