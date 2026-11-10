// routed-send: one cloud call, profile by profile down its lane's order (lib/llm/router).
//
// A model-class failure (lib/llm/router failureClassOf: a 5xx, the gateway's model_unavailable,
// an attestation failure, an empty reply, a missed first-token deadline) marks the profile and the
// next one is sent AT ONCE: no backoff, no jitter wait. Everything else surfaces untouched: 401
// keeps its one re-mint and 429 its pause inside authFetch, a stop and the app leaving are never
// evidence. When every profile failed, the lane is out: one error event, then the last profile's
// FIRST failure surfaces (the head's, as the old fallback did: a later profile must never mask
// the real error), so callers see the same errors they always did.

import { AppState } from 'react-native';
import { departureMark } from '../app-restart';
import { authFetch, takeStreamHandle, type ChatTurn, type CloudCallOptions } from './gateway-fetch';
import { OnDeviceModeError } from './on-device-gate';
import { firstTokenDeadlineMs, servesBatch, type Profile } from './profiles';
import { providerHeader } from './provider-e2ee';
import {
  applyRoutingTable,
  failureClassOf,
  failureClassOfStatus,
  isProfileMarked,
  LaneExhaustedError,
  laneRoutes,
  noteRoutingVersion,
  reportLaneExhausted,
  reportProfileFailure,
  reportProfileSuccess,
  routeLane,
  type FailureClass,
  type Lane,
  type RouteOptions,
} from './router';

export type Build<C> = (profile: Profile) => Promise<{ init: RequestInit; ctx: C; turn?: ChatTurn }>;

/** A request that reached the gateway: its answer, the context that opens it, and who served it. */
export interface Leg<C> {
  response: Response;
  ctx: C;
  profile: Profile;
}

/** The profiles `lane` would try, in order (empty for a batch when only RedPill is left). Throws when the mode keeps the lane off the cloud. */
export function chainFor(lane: Lane, opts: RouteOptions = {}): Profile[] {
  if (!laneRoutes(lane)) throw new OnDeviceModeError();
  return routeLane(lane, opts);
}

/**
 * One send to one profile. A 5xx comes back as a fresh, still-readable response plus its
 * failure class (its body is read here, once, for the gateway's fast-fail verdict and table);
 * any other answer comes back with a null class. A throw is the caller's to classify.
 */
export async function sendToProfile<C>(
  url: string,
  lane: Lane,
  profile: Profile,
  build: Build<C>,
  options: CloudCallOptions,
): Promise<{ leg: Leg<C>; failure: FailureClass | null }> {
  const built = await build(profile);
  const init: RequestInit = {
    ...built.init,
    headers: { ...(built.init.headers as Record<string, string>), ...providerHeader(profile) },
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const response = await authFetch(url, init, {
    ...options,
    requestTimeoutMs: firstTokenDeadlineMs(profile, lane),
    failFast: true,
    turn: built.turn,
  });
  noteRoutingVersion(response.headers?.get('X-Mera-Routing'));
  if (response.status < 500) return { leg: { response, ctx: built.ctx, profile }, failure: null };
  takeStreamHandle(response)?.release();
  const body = await response.text().catch(() => '');
  try {
    applyRoutingTable((JSON.parse(body) as { routing?: unknown }).routing);
  } catch {
    // Not JSON: an upstream error page carries no table.
  }
  const replay = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  return { leg: { response: replay, ctx: built.ctx, profile }, failure: failureClassOfStatus(response.status, body) };
}

/** One request to one profile, settled: its answer, or its error and whether that is model evidence. */
export type Attempt<T> = { out: T } | { error: unknown; failure: FailureClass | null };

/** Sends once to `profile` and reads the answer. Nothing that happens while the app is away is a verdict on the model. */
export async function attemptOnProfile<C, T>(
  url: string,
  lane: Lane,
  profile: Profile,
  build: Build<C>,
  read: (leg: Leg<C>) => Promise<T>,
  options: CloudCallOptions,
): Promise<Attempt<T>> {
  const left = departureMark();
  try {
    const { leg, failure } = await sendToProfile(url, lane, profile, build, options);
    if (failure && !left()) {
      // `read` turns a 5xx into the error callers have always seen.
      const error = await read(leg).then(() => new Error(`${failure} on ${profile.id}`), (e: unknown) => e);
      return { error, failure };
    }
    return { out: await read(leg) };
  } catch (err) {
    return { error: err, failure: left() ? null : failureClassOf(err) };
  }
}

/**
 * The lane's sync-only profile (RedPill) when it can serve right now: unmarked, and the app in
 * front, because its v2 envelope expires in 300 s and must not be held across a suspension.
 */
export function perRequestProfile(lane: Lane): Profile | null {
  if (AppState.currentState !== 'active') return null;
  return routeLane(lane).find((p) => !servesBatch(p) && !isProfileMarked(p.id)) ?? null;
}

/**
 * Sends on `lane` and reads the answer with `read`, moving down the chain on every model-class
 * failure, whether it showed in the status or in the body `read` opened (an empty reply). `build`
 * MUST construct its payload from scratch each time: E2EE encrypts in place and every profile has
 * its own attestation key.
 *
 * `perRequest` is for a call the chain's profiles serve as one request (a batch) that a sync-only
 * profile can serve as several: it runs on that profile (perRequestProfile) after the chain failed,
 * or at once when every chain profile is marked.
 */
export async function sendOnLane<C, T>(
  url: string,
  lane: Lane,
  build: Build<C>,
  read: (leg: Leg<C>) => Promise<T>,
  options: CloudCallOptions,
  route: RouteOptions = {},
  perRequest?: (profile: Profile) => Promise<Attempt<T>>,
): Promise<T> {
  const failed: { profile: Profile; failure: FailureClass; error: unknown }[] = [];
  const settle = (profile: Profile, a: Attempt<T>): { out: T } | null => {
    if ('out' in a) {
      reportProfileSuccess(profile, lane);
      return a;
    }
    if (!a.failure) throw a.error;
    reportProfileFailure(profile, lane, a.failure);
    failed.push({ profile, failure: a.failure, error: a.error });
    return null;
  };
  const chain = chainFor(lane, route);
  const skipChain = perRequest !== undefined && chain.every((p) => isProfileMarked(p.id)) && perRequestProfile(lane) !== null;
  for (const profile of skipChain ? [] : chain) {
    const done = settle(profile, await attemptOnProfile(url, lane, profile, build, read, options));
    if (done) return done.out;
  }
  const fallback = perRequest ? perRequestProfile(lane) : null;
  if (perRequest && fallback) {
    const done = settle(fallback, await perRequest(fallback));
    if (done) return done.out;
  }
  const last = failed.at(-1);
  reportLaneExhausted(lane, last?.profile ?? null, last?.failure ?? 'model_unavailable');
  // The head's first error, so a later profile never masks the real one; with nothing to try, the lane's.
  throw failed.length > 0 ? failed[0].error : new LaneExhaustedError(lane);
}
