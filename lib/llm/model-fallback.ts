// model-fallback — session-scoped de-amplification of a stalling NEAR primary
// model (NEAR-stall plan, section E).
//
// Friction this removes: when a primary model stops answering at all, EVERY
// cloud call in the session keeps paying the full client timeout budget against
// the same dead model. One shared switch lets the first timeout-class failure
// move the rest of the session onto a healthy, similar-cost model.
//
// Deliberately minimal (no React, no storage, no timers):
//   - state is one in-memory Map, so it lives exactly as long as the JS context;
//   - nothing ever clears an engagement — the next app launch retries the
//     primary by construction, which is the cheapest possible probe and needs
//     no half-open timer or health-check to be correct.
//
// It reads ONE piece of outside state, `useNetworkStore().isConnected`, via a
// plain getState() (no hook, no subscription). That is not decoration: an
// offline device produces timeouts that are indistinguishable from a stalled
// model, so without it the module cannot tell its own trigger condition from
// "the phone is in a tunnel" — see reportModelFailure.
//
// ONLY timeout-class terminal failures may call reportModelFailure(): a client
// that exhausted its timeout attempts, or the gateway's 502 upstream-timeout
// verdict. 4xx, auth, E2EE/decrypt and plain network errors say nothing about
// the model and must never engage this.

import logger from '../logger';
import { useNetworkStore } from '../stores/network-store';
import { MODEL_FALLBACKS } from './constants';

/** primary model id → epoch ms at which its fallback was engaged. */
const engagedAt = new Map<string, number>();

/**
 * The model to actually send for `model`. Returns the configured fallback once
 * the primary is engaged for this session, otherwise `model` unchanged.
 */
export function resolveModel(model: string): string {
  if (!engagedAt.has(model)) return model;
  return MODEL_FALLBACKS[model] ?? model;
}

/** The configured fallback for `model`, or null when none exists. */
export function fallbackFor(model: string): string | null {
  return MODEL_FALLBACKS[model] ?? null;
}

/**
 * Engage `model`'s session fallback. Both causes share one guard set, so a model
 * that first loses a hedge race and later times out (or vice versa) still
 * produces exactly ONE Sentry event for the session — it is one incident.
 */
function engage(model: string, cause: 'timeout' | 'hedge'): void {
  const fallback = MODEL_FALLBACKS[model];
  if (!fallback) return; // nothing to fall back to — leave the caller as-is
  if (engagedAt.has(model)) return; // already engaged; report once per session
  engagedAt.set(model, Date.now());
  if (cause === 'timeout') {
    logger.captureMessage('NEAR primary model failing — session fallback engaged', {
      level: 'error',
      tags: { model, fallback },
    });
    return;
  }
  // A hedge win is a slow primary, not a dead one — warning, not error.
  logger.captureMessage('NEAR primary model slow — hedged fallback won, session fallback engaged', {
    level: 'warning',
    tags: { model, fallback },
  });
}

/**
 * Record a TIMEOUT-CLASS terminal failure for `model`. Engages the session
 * fallback iff one is configured; the first engagement per model per session
 * also reports to Sentry (this is a real upstream incident, not noise —
 * everything after it is the same incident).
 */
export function reportModelFailure(model: string): void {
  // A device with no link cannot have learned anything about a remote model.
  //
  // cloudComplete's caller already tries to exclude this — "Only a client
  // timeout/cancellation is model-evidence. Everything else (network down,
  // JSON, auth) is surfaced as-is" — but an OFFLINE device on a stalled socket
  // produces a TIMEOUT, not a network error, so it passes that filter intact.
  // The result was a backgrounded, offline phone concluding the NEAR primary
  // was down and engaging the session fallback for everything after it
  // (MERA-APP-6Y, whose event carries `device.online: false`). Engagement is
  // once-per-session and sticky, so one offline moment demoted the whole
  // session to the fallback model.
  //
  // Gated on `isConnected` ONLY, not on `serverReachable`. serverReachable is
  // fed exclusively by the Apollo link (lib/apollo-client.ts); the inference
  // path never touches the network store, so it tracks GraphQL health — and
  // suppressing on it would let an unrelated GraphQL blip hide a real NEAR
  // incident. `isConnected` is seeded optimistically true, so an unknown
  // connectivity state still reports, which is the right direction to err.
  if (!useNetworkStore.getState().isConnected) {
    logger.addBreadcrumb(
      'Model failure ignored — device offline',
      'model-fallback',
      { model },
      'info',
    );
    return;
  }
  engage(model, 'timeout');
}

/**
 * Record that `model` lost a hedge race — the same request answered faster on
 * its fallback (lib/llm/cloudComplete, HEDGE_DELAY_MS). Same session-scoped
 * engagement as a timeout, reported at a lower severity because the primary is
 * merely slow.
 */
export function reportModelSlow(model: string): void {
  engage(model, 'hedge');
}

/**
 * Record a success for `model`. Intentionally a no-op: a single success does
 * NOT un-engage the fallback. Flapping between a half-dead primary and the
 * fallback would re-introduce exactly the stall this exists to avoid, and the
 * fallback is a similar-cost model, so staying on it for the session costs
 * nothing. The engagement is released by the process ending, nothing else.
 */
export function reportModelSuccess(model: string): void {
  if (!engagedAt.has(model)) return;
  // Engaged and now succeeding (on the fallback) — deliberately no state change.
}

/** True once `model`'s session fallback is engaged. Diagnostics/tests only. */
export function isFallbackEngaged(model: string): boolean {
  return engagedAt.has(model);
}

/** Test hook — clears all session state so specs don't leak into each other. */
export function __resetForTests(): void {
  engagedAt.clear();
}
