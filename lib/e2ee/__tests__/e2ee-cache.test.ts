// Tests for lib/e2ee/e2ee-cache.ts — in-memory attestation cache with TTL.
// The module uses Date.now() for TTL checks; we control time via jest.spyOn.

import {
  getCachedAttestation,
  setCachedAttestation,
  clearAttestationCache,
} from '../e2ee-cache';
import type { ModelAttestation } from '../e2ee-service';

const TTL_MS = 30 * 60 * 1000; // must match source (30 minutes)

function makeAttestation(publicKey = 'aa'.repeat(32)): ModelAttestation {
  return { publicKey, algo: 'ed25519', signingId: 'near:test.near' };
}

// Control Date.now() to test TTL expiry without real waits.
let nowMs = 1_700_000_000_000;
let dateSpy: jest.SpyInstance;

beforeEach(() => {
  nowMs = 1_700_000_000_000;
  dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  // Wipe the module-level cache between tests by calling clearAttestationCache()
  clearAttestationCache();
});

afterEach(() => {
  dateSpy.mockRestore();
});

describe('getCachedAttestation', () => {
  it('returns null for unknown model', () => {
    expect(getCachedAttestation('unknown-model')).toBeNull();
  });

  it('returns null when cache is empty', () => {
    expect(getCachedAttestation('any-model')).toBeNull();
  });

  it('returns attestation immediately after setting it', () => {
    const att = makeAttestation();
    setCachedAttestation('my-model', att);
    expect(getCachedAttestation('my-model')).toBe(att);
  });

  it('returns null after TTL has elapsed', () => {
    const att = makeAttestation();
    setCachedAttestation('expiring-model', att);

    // Advance time past TTL
    nowMs += TTL_MS + 1;

    expect(getCachedAttestation('expiring-model')).toBeNull();
  });

  it('removes the expired entry from the cache (no zombie entries)', () => {
    const att = makeAttestation();
    setCachedAttestation('zombie-model', att);

    nowMs += TTL_MS + 1;
    // First call — triggers delete
    getCachedAttestation('zombie-model');
    // Advance time back (simulate re-fresh), set fresh entry
    nowMs -= TTL_MS + 1; // back to original time
    setCachedAttestation('zombie-model', att);
    // Now at fresh time → should be valid
    expect(getCachedAttestation('zombie-model')).toBe(att);
  });

  it('returns the attestation at exactly TTL boundary (not yet expired)', () => {
    const att = makeAttestation();
    setCachedAttestation('edge-model', att);

    // At exactly TTL — NOT > TTL, so still valid per `> TTL_MS` check
    nowMs += TTL_MS;

    expect(getCachedAttestation('edge-model')).toBe(att);
  });

  it('returns null one millisecond after TTL boundary', () => {
    const att = makeAttestation();
    setCachedAttestation('edge2-model', att);

    nowMs += TTL_MS + 1;

    expect(getCachedAttestation('edge2-model')).toBeNull();
  });

  it('is keyed per model — different models do not interfere', () => {
    const att1 = makeAttestation('bb'.repeat(32));
    const att2 = makeAttestation('cc'.repeat(32));
    setCachedAttestation('model-1', att1);
    setCachedAttestation('model-2', att2);

    expect(getCachedAttestation('model-1')).toBe(att1);
    expect(getCachedAttestation('model-2')).toBe(att2);
  });

  it('only expires the model whose TTL elapsed', () => {
    const att1 = makeAttestation('aa'.repeat(32));
    const att2 = makeAttestation('bb'.repeat(32));

    setCachedAttestation('short-lived', att1);
    nowMs += TTL_MS / 2; // half TTL
    setCachedAttestation('long-lived', att2); // set later

    nowMs += TTL_MS / 2 + 1; // now short-lived is expired, long-lived is not

    expect(getCachedAttestation('short-lived')).toBeNull();
    expect(getCachedAttestation('long-lived')).toBe(att2);
  });
});

describe('setCachedAttestation', () => {
  it('overwrites an existing entry for the same model', () => {
    const att1 = makeAttestation('11'.repeat(32));
    const att2 = makeAttestation('22'.repeat(32));

    setCachedAttestation('my-model', att1);
    setCachedAttestation('my-model', att2);

    expect(getCachedAttestation('my-model')).toBe(att2);
  });

  it('resets the TTL when overwriting', () => {
    const att1 = makeAttestation('11'.repeat(32));
    const att2 = makeAttestation('22'.repeat(32));

    setCachedAttestation('my-model', att1);
    nowMs += TTL_MS - 100; // almost expired

    // Overwrite — should reset TTL
    setCachedAttestation('my-model', att2);
    nowMs += 200; // original would have expired, new entry is fresh

    expect(getCachedAttestation('my-model')).toBe(att2);
  });

  it('stores attestation object exactly as passed (by reference)', () => {
    const att = makeAttestation();
    setCachedAttestation('ref-model', att);
    expect(getCachedAttestation('ref-model')).toBe(att); // same reference
  });
});

describe('clearAttestationCache', () => {
  it('removes all cached entries', () => {
    setCachedAttestation('m1', makeAttestation('11'.repeat(32)));
    setCachedAttestation('m2', makeAttestation('22'.repeat(32)));
    setCachedAttestation('m3', makeAttestation('33'.repeat(32)));

    clearAttestationCache();

    expect(getCachedAttestation('m1')).toBeNull();
    expect(getCachedAttestation('m2')).toBeNull();
    expect(getCachedAttestation('m3')).toBeNull();
  });

  it('is idempotent — calling twice does not throw', () => {
    setCachedAttestation('x', makeAttestation());
    expect(() => {
      clearAttestationCache();
      clearAttestationCache();
    }).not.toThrow();
  });

  it('allows new entries to be set after clearing', () => {
    setCachedAttestation('pre', makeAttestation('11'.repeat(32)));
    clearAttestationCache();

    const fresh = makeAttestation('ff'.repeat(32));
    setCachedAttestation('post', fresh);
    expect(getCachedAttestation('post')).toBe(fresh);
  });

  it('does not throw on an already-empty cache', () => {
    expect(() => clearAttestationCache()).not.toThrow();
  });
});
