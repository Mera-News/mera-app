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
 * Wipe the in-memory attestation cache. Called from `clearAllStores()` on
 * logout / account switch so a different user's session cannot reuse a
 * previous user's attestation.
 */
export function clearAttestationCache(): void {
  cache.clear();
}
