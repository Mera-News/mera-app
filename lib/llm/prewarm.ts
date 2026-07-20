// prewarm.ts — warm the cloud-chat critical path so the first real turn isn't
// gated on cold attestation + JWT fetches.
//
// The first cloud chat turn must (1) fetch the model's TEE attestation from the
// gateway — an UNCACHED NEAR pass-through, the slow hop — and (2) mint a JWT.
// Both are cached client-side (attestation ~30 min, JWT ~30 s), so firing them
// ahead of the first send moves that latency off the user's first message.
//
// Fire-and-forget and idempotent: repeated calls hit the underlying caches, so
// mounting several chat surfaces in one session costs at most one real fetch of
// each until the caches expire. No-op under on-device processing (no gateway
// hop). Errors are swallowed (Promise.allSettled) with a debug log — a failed
// prewarm simply means the first real turn pays the original cost.

import { getJwtToken } from '../auth-client';
import { fetchModelPublicKey } from '../e2ee/e2ee-service';
import { ProcessingMode } from '../generated/graphql-types';
import logger from '../logger';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import { BIG_MODEL } from './constants';

/**
 * Kick off the attestation + JWT fetches for the cloud persona-chat model.
 * Returns immediately (void); the warming runs in the background.
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
}
