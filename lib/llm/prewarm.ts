// prewarm.ts — warm the cloud-chat critical path so the first real turn isn't
// gated on cold attestation + JWT fetches, AND so the NEAR model itself is warm.
//
// The first cloud chat turn must (1) fetch the model's TEE attestation from the
// gateway — an UNCACHED NEAR pass-through, the slow hop — (2) mint a JWT, and
// (3) hit a possibly-COLD model (the dominant, multi-second cost the attestation
// + JWT warming alone can't touch). (1) and (2) are cached client-side
// (attestation ~30 min, JWT ~30 s); (3) has no client cache, so we fire a tiny
// throwaway completion and dedupe it to the attestation-cache window.
//
// Fire-and-forget and idempotent: repeated calls hit the underlying caches / the
// warmup dedupe, so mounting several chat surfaces in one session costs at most
// one real fetch of each until the caches expire. No-op under on-device
// processing (no gateway hop). Errors are swallowed with a debug log — a failed
// prewarm simply means the first real turn pays the original cost.

import { getJwtToken } from '../auth-client';
import { fetchModelPublicKey } from '../e2ee/e2ee-service';
import { ProcessingMode } from '../generated/graphql-types';
import logger from '../logger';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import { cloudComplete } from './cloudComplete';
import { BIG_MODEL } from './constants';

// Model-warmup dedupe: unlike attestation/JWT (client-cached), a throwaway
// completion actually hits the model on every call, so gate it to the
// attestation-cache window (~30 min). Re-warming more often is wasted inference;
// re-warming after the window keeps the model hot across a long session.
const MODEL_WARM_TTL_MS = 30 * 60_000;
let lastModelWarmAt = 0;

/**
 * Kick off the attestation + JWT fetches AND a throwaway model completion for
 * the cloud persona-chat model. Returns immediately (void); all warming runs in
 * the background.
 */
export function prewarmCloudChat(): void {
  // On-device processing never touches the gateway — nothing to warm.
  if (
    useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice
  ) {
    logger.debug('[chat-timing] prewarm skipped (on-device)');
    return;
  }

  const startMs = Date.now();
  void Promise.allSettled([fetchModelPublicKey(BIG_MODEL), getJwtToken()]).then(
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

  // Warm the MODEL itself (fire-and-forget, silent). Deduped to the
  // attestation-cache window so repeated surface mounts don't each pay for an
  // inference.
  void warmModel();
}

/**
 * Fire a single tiny throwaway completion against BIG_MODEL so the NEAR model is
 * loaded before the user's first real turn. Fully silent — no Sentry, no toast;
 * a failure just means the first real turn pays the cold cost. Only runs when a
 * JWT is obtainable (an unauthenticated completion would just 401-storm).
 */
async function warmModel(): Promise<void> {
  const now = Date.now();
  if (now - lastModelWarmAt < MODEL_WARM_TTL_MS) return;
  // Claim the window up front so concurrent callers don't double-fire.
  lastModelWarmAt = now;
  try {
    const token = await getJwtToken();
    if (!token) {
      // No auth yet — release the claim so a later call (post-login) can warm.
      lastModelWarmAt = 0;
      return;
    }
    await cloudComplete({
      systemPrompt: '',
      prompt: 'hi',
      model: BIG_MODEL,
      maxTokens: 1,
      temperature: 0,
    });
    logger.debug('[chat-timing] model warmup completion done');
  } catch (err) {
    // Best-effort only — swallow everything (no Sentry, no toast).
    logger.debug('[chat-timing] model warmup failed (swallowed)', {
      error: String(err),
    });
  }
}
