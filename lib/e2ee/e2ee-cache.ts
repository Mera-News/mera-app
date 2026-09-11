import type { ModelAttestation } from './e2ee-service';

const TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  attestation: ModelAttestation;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Return cached model attestation for `model` if still valid. */
export function getCachedAttestation(model: string): ModelAttestation | null {
  const entry = cache.get(model);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(model);
    return null;
  }
  return entry.attestation;
}

export function setCachedAttestation(
  model: string,
  attestation: ModelAttestation,
): void {
  cache.set(model, { attestation, fetchedAt: Date.now() });
}

/**
 * Drop ONE model's cached attestation so the next `fetchModelPublicKey` re-attests.
 *
 * Exists for the case where a key is still inside its TTL but the serving node
 * will not decrypt under it: NEAR answers a chat POST with
 * `400 "Provider failed for model '<id>': Decryption failed"`, which is its own
 * verdict passed through by the gateway (a pure proxy). Re-attesting is the only
 * client-side lever — it re-rolls both the node we are keyed against and, since
 * NEAR's fleet load-balances curves, possibly the algo family itself.
 *
 * Deliberately per-model rather than reusing `clearAttestationCache`: the other
 * models' keys are not implicated, and wiping them would make every concurrent
 * caller re-attest against the same endpoint (the stampede `pendingAttestations`
 * exists to prevent).
 */
export function invalidateCachedAttestation(model: string): void {
  cache.delete(model);
}

/**
 * Wipe the in-memory attestation cache. Called from `clearAllStores()` on
 * logout / account switch so a different user's session cannot reuse a
 * previous user's attestation.
 */
export function clearAttestationCache(): void {
  cache.clear();
}
