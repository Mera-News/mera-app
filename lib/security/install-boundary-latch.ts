// Synchronous auth-read quarantine — the enforcement half of the install
// boundary (see install-boundary.ts for the full story).
//
// THE RACE IT KILLS (r2 e2e, BUG A): better-auth fires its first /get-session
// the moment useSession mounts, reading the cookie via the adapter's SYNC
// getItem — milliseconds BEFORE the boundary's async deletes land. The old
// server session was still valid, so that response's onSuccess hook
// re-persisted the previous install's cookie/session cache AFTER the boundary
// cleared them; the marker then blocked re-clearing forever and every cold
// relaunch hydrated the dead identity.
//
// The latch is module state set at IMPORT time, so it is active before any
// request can be built. While latched, SYNC reads of the auth/device keys
// answer null (the racing request goes out cookie-less and gets a null
// session, which persists nothing). The boundary releases it — on every
// outcome, in a finally — and then pokes better-auth's session signal so the
// atom refetches against the now-authoritative keychain state.
//
// ZERO imports on purpose: consumed by both the SecureStore adapter and
// install-boundary, which would otherwise form a cycle.

const QUARANTINED_KEY_SUFFIXES = [
  '_cookie',
  '_session_data',
  '_appattest_key_id',
  '_device_attest_device_id',
];

let authReadsQuarantined = true;

/** SYNC-read gate. Async reads are deliberately not gated: the boundary
 *  itself reads the real values through them, and better-auth's cookie path
 *  is sync-only. */
export function isAuthReadQuarantined(key: string): boolean {
  if (!authReadsQuarantined) return false;
  return QUARANTINED_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

export function releaseAuthReadQuarantine(): void {
  authReadsQuarantined = false;
}

/** Test seam. */
export function __resetAuthReadQuarantineForTests(): void {
  authReadsQuarantined = true;
}
