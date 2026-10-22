// prewarm.ts — warm the cloud-chat critical path so the first real turn isn't
// gated on cold attestation + JWT fetches, AND so the NEAR model itself is warm.
//
// The first cloud chat turn must (1) fetch the model's TEE attestation from the
// gateway — an UNCACHED NEAR pass-through, the slow hop — (2) mint a JWT, and
// (3) hit a possibly-COLD model (the dominant, multi-second cost the attestation
// + JWT warming alone can't touch). (1) and (2) are cached client-side
// (attestation ~30 min, JWT ~30 s); (3) has no client cache, so on EVERY chat
// open (owner, 2026-10-22) we ping BIG_MODEL for the word "ready", and the chat
// header shows how that went. Only an open passes `ping`; app launch warms (1) and (2) only.
//
// Fire-and-forget and idempotent: repeated calls hit the underlying caches / the
// in-flight ping, so mounting several chat surfaces in one session costs at most
// one real fetch of each until the caches expire. No-op while chat runs on the
// phone (no gateway hop). Errors are swallowed with a debug log — a failed
// prewarm simply means the first real turn pays the original cost.

import { create } from 'zustand';
import { getJwtToken } from '../auth-client';
import { fetchModelPublicKey } from '../e2ee/e2ee-service';
import logger from '../logger';
import { useCloudChatStore } from '../stores/cloud-chat-store';
import { useUserStore } from '../stores/user-store';
import { chatRunsInCloud } from './chat-cloud';
import { cloudComplete } from './cloudComplete';
import { BIG_MODEL, SMALL_MODEL } from './constants';

export type ChatReadiness = 'idle' | 'warming' | 'ready' | 'error';

/** The chat header badge: how the last readiness ping went. Memory only; 'idle' shows nothing. */
export const useChatReadiness = create<{ status: ChatReadiness }>(() => ({ status: 'idle' }));
const setReadiness = (status: ChatReadiness) => useChatReadiness.setState({ status });

/** A cloud chat turn came back: the model answers, whatever the ping said. */
export function markChatReady(): void {
  setReadiness('ready');
}

// One ping in flight at a time, so two open paths firing together send one.
let pinging = false;

/**
 * Kick off the attestation + JWT fetches and, on a chat open (`ping`), the
 * readiness ping. Returns immediately (void); all warming runs in the background.
 */
export function prewarmCloudChat(opts: { ping?: boolean } = {}): void {
  // Chat on the phone never touches the gateway: nothing to warm, no badge.
  if (!chatRunsInCloud()) {
    logger.debug('[chat-timing] prewarm skipped (on-device)');
    setReadiness('idle');
    return;
  }

  const startMs = Date.now();
  // THE TWO PRIMARIES ONLY. Fallback attestations are fetched lazily, inside
  // the build for whichever leg actually needs one.
  //
  // Every gateway call now takes a limiter grant, and these are serialised
  // behind it — so each extra prewarm fetch pushes pingModel(), the dominant
  // cold-start cost this file exists for, a further interval out. The old
  // three-fetch shape spent that on BIG, fallback(BIG) and fallback(SMALL)
  // while never warming SMALL_MODEL itself, which is what cloudChatStream
  // defaults to and what every scoring call uses.
  //
  // Cost of going lazy, on the fallback path: a hedge leg that must attest
  // cold pays one interactive grant plus one uncached attestation round trip
  // before it can send. It only runs after 10s of total silence from the
  // primary (HEDGE_DELAY_MS) and exists to rescue a stall, not to shave
  // latency, so a second or two at the front of the rescue is the right trade
  // for two fewer requests on every launch.
  void Promise.allSettled([
    fetchModelPublicKey(BIG_MODEL, 'interactive'),
    fetchModelPublicKey(SMALL_MODEL, 'interactive'),
    getJwtToken(),
  ]).then(
    (results) => {
      const failed = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      logger.debug('[chat-timing] prewarm settled', {
        ms: Date.now() - startMs,
        failed: failed.length,
      });
      for (const r of failed) {
        logger.debug('[chat-timing] prewarm task failed (swallowed)', {
          error: String(r.reason),
        });
      }
    },
  );

  // Warm the MODEL itself (fire-and-forget, silent): only when a chat opens.
  if (opts.ping) void pingModel();
}

/**
 * One fixed E2EE call to BIG_MODEL so the NEAR model is loaded before the
 * user's first real turn; its outcome drives the header badge. The request is
 * two constants: no user data, no language, no clock. Fully silent: no Sentry,
 * no toast. A timeout is cloudComplete's own bounded one, which throws.
 */
async function pingModel(): Promise<void> {
  if (pinging) return;
  // A restricted account cannot chat, so it is never told Mera is ready.
  if (useCloudChatStore.getState().isBlocked || useUserStore.getState().userPersona?.blockedByLlm) {
    setReadiness('idle');
    return;
  }
  pinging = true;
  setReadiness('warming');
  try {
    const token = await getJwtToken();
    // Signed out: nothing to ping with, and no badge.
    if (!token) {
      setReadiness('idle');
      return;
    }
    // A plain reply, not a tool call: the app sends tools as text inside the
    // sealed envelope, so a tool leg would only make the ping bigger.
    const reply = await cloudComplete({
      systemPrompt: 'Reply with the single word "ready" and nothing else.',
      prompt: 'ping',
      model: BIG_MODEL,
      maxTokens: 8,
      temperature: 0,
      purpose: 'chat',
    }, { lane: 'interactive' });
    // Any non-empty 2xx reply proves the model answers; the exact word is not required.
    setReadiness(reply ? 'ready' : 'error');
    logger.debug('[chat-timing] readiness ping done', { empty: !reply });
  } catch (err) {
    setReadiness('error');
    // Best-effort only — swallow everything (no Sentry, no toast).
    logger.debug('[chat-timing] readiness ping failed (swallowed)', {
      error: String(err),
    });
  } finally {
    pinging = false;
  }
}
