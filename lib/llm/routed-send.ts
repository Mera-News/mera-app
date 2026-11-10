// routed-send: one cloud call, profile by profile down its lane's order (lib/llm/router).
//
// A model-class failure (lib/llm/router failureClassOf: a 5xx, the gateway's model_unavailable,
// an attestation failure, an empty reply, a missed first-token deadline) marks the profile and the
// next one is sent AT ONCE: no backoff, no jitter wait. Everything else surfaces untouched: 401
// keeps its one re-mint and 429 its pause inside authFetch, a stop and the app leaving are never
// evidence. When every profile failed, the lane is out: one error event, then the last profile's
// FIRST failure surfaces (the head's, as the old fallback did: a later profile must never mask
// the real error), so callers see the same errors they always did.

import { departureMark } from '../app-restart';
import { authFetch, takeStreamHandle, type ChatTurn, type CloudCallOptions } from './gateway-fetch';
import { OnDeviceModeError } from './on-device-gate';
import { firstTokenDeadlineMs, type Profile } from './profiles';
import { providerHeader } from './provider-e2ee';
import {
  applyRoutingTable,
  failureClassOf,
  failureClassOfStatus,
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

/** The profiles `lane` would try, in order. Throws when the mode keeps the lane off the cloud. */
export function chainFor(lane: Lane, opts: RouteOptions = {}): Profile[] {
  const chain = routeLane(lane, opts);
  if (chain.length === 0) throw new OnDeviceModeError();
  return chain;
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

/**
 * Sends on `lane` and reads the answer with `read`, moving down the chain on every model-class
 * failure, whether it showed in the status or in the body `read` opened (an empty reply). `build`
 * MUST construct its payload from scratch each time: E2EE encrypts in place and every profile has
 * its own attestation key.
 */
export async function sendOnLane<C, T>(
  url: string,
  lane: Lane,
  build: Build<C>,
  read: (leg: Leg<C>) => Promise<T>,
  options: CloudCallOptions,
  route: RouteOptions = {},
): Promise<T> {
  let first: { leg?: Leg<C>; error?: unknown } | null = null;
  let last: { profile: Profile; failure: FailureClass } | null = null;
  for (const profile of chainFor(lane, route)) {
    // Nothing that happens while the app is away is a verdict on the model.
    const left = departureMark();
    try {
      const { leg, failure } = await sendToProfile(url, lane, profile, build, options);
      if (failure && !left()) {
        reportProfileFailure(profile, lane, failure);
        first ??= { leg };
        last = { profile, failure };
        continue;
      }
      const out = await read(leg);
      reportProfileSuccess(profile, lane);
      return out;
    } catch (err) {
      const failure = left() ? null : failureClassOf(err);
      if (!failure) throw err;
      reportProfileFailure(profile, lane, failure);
      first ??= { error: err };
      last = { profile, failure };
    }
  }
  reportLaneExhausted(lane, last!.profile, last!.failure);
  // `read` turns a 5xx into the error callers have always seen.
  if (first!.leg) return read(first!.leg);
  throw first!.error;
}
