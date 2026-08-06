// The device-local memory of the last subscription tier this device ACTUALLY
// resolved.
//
// ## The bug this exists to fix (2026-08-06)
//
// `FREE_TIER_MODE_ENABLED` flipped true and armed a gate that had been inert.
// `decideOnboardingEntry` treated `aiAccess === 'unknown'` — "billing has not
// answered yet" — the same as `'entitled'`, so a cold start that had not yet
// resolved entitlement was sent into the onboarding wizard, which then resumed
// at step 2 off the server's `onboardingStage`. Users landed in the persona chat
// instead of the "Switch Mera on" paywall.
//
// The decision (owner, 2026-08-06) is HOLD, THEN TRUST A LAST-KNOWN TIER:
// an unresolvable verdict now falls back to whatever this device last learned,
// and only a device that has NEVER resolved a tier falls through to the paywall.
// Net effect: an offline subscriber keeps working; a never-resolved device gets
// the paywall rather than a wizard it cannot complete.
//
// ## Why a `settings` row rather than a store
//
// Same mechanism as `cached_user_id` and `free_tier_first_open_dismissed` — one
// KV row in WatermelonDB, no new table and no migration. It must survive process
// death (that is the entire point: the fallback is consulted on a COLD start),
// which rules out any in-memory store, and it is device state rather than user
// state so it needs no server round trip.
//
// ## Why the raw tier string and not an `AiAccess`
//
// `AiAccess` is a derived verdict whose derivation (`deriveAiAccess`) sits behind
// a ship gate and a dev override. Persisting the derived value would freeze
// today's derivation onto disk — a device that resolved while the ship gate was
// off would have `'entitled'` written for a reason that has nothing to do with
// its tier. The tier is the fact; the verdict is re-derived at read time by
// `aiAccessFromLastKnownTier`.
//
// ## Cross-user safety
//
// CLEARED on logout and on a user switch — see `clearLastKnownTier`'s callers in
// `lib/stores/index.ts`. Without that, user B on user A's device would inherit
// A's tier, which is exactly the class of cross-user leak this codebase has been
// bitten by before.

import type { AiAccess } from '@/lib/subscription/ai-access';

export const LAST_KNOWN_TIER_SETTING_KEY = 'last_known_subscription_tier';

/**
 * The settings service, required LAZILY and inside each function's try/catch.
 *
 * Not a style choice — the same lazy-require pattern `lib/stores/index.ts` and
 * `lib/security/local-wipe.ts` use, and for the same reason. A static import
 * here would pull `lib/database` (and its SQLiteAdapter construction) into the
 * import graph of `entitlement-sync.ts`, which is itself imported by
 * `ai-lock.ts` → `article-service.ts` → half the app. That widening broke five
 * unrelated Jest suites the moment it was tried: they construct no native
 * SQLite and had no reason to.
 *
 * Inside the try, deliberately: the require itself is the part that can throw in
 * a DB-less environment, and this module's whole contract is that it never
 * throws at its callers.
 */
type SettingService = typeof import('@/lib/database/services/setting-service');
function settingService(): SettingService {
    return require('@/lib/database/services/setting-service');
}

/**
 * Record a tier this device genuinely resolved.
 *
 * A no-op for `null` / `undefined` / `''`: "we did not learn a tier" must never
 * be recorded as history, or a device that has never resolved anything would
 * stop taking the never-resolved branch. `'none'` IS a resolution (the server
 * said this user has no plan) and is recorded like any other value.
 *
 * Never throws — every caller fires this alongside work that matters more.
 */
export async function rememberLastKnownTier(
    tier: string | null | undefined,
): Promise<void> {
    if (!tier) return;
    try {
        await settingService().setSetting(LAST_KNOWN_TIER_SETTING_KEY, tier);
    } catch {
        // Best effort. Losing the write costs one paywall on a future
        // unresolvable cold start; throwing would break the caller's real work.
    }
}

/** The last tier this device resolved, or `null` when it never has. */
export async function readLastKnownTier(): Promise<string | null> {
    try {
        return await settingService().getSetting(LAST_KNOWN_TIER_SETTING_KEY);
    } catch {
        // FAILS CLOSED, deliberately, and the opposite way round from
        // `readFirstOpenDismissed`. An unreadable row cannot be read as "this
        // user is a subscriber" — the safe direction here is "no history",
        // which routes to the paywall rather than into a wizard whose step 2
        // cannot work without an entitlement.
        return null;
    }
}

/** Wipe the memory. Called on logout and on a user switch. */
export async function clearLastKnownTier(): Promise<void> {
    try {
        await settingService().deleteSetting(LAST_KNOWN_TIER_SETTING_KEY);
    } catch {
        // Absence is the goal; a failed delete is not actionable here, and
        // `clearAllStores` resets the whole database moments later anyway.
    }
}

/**
 * Re-derive an `AiAccess` from a persisted tier.
 *
 * `null` (never resolved) stays `'unknown'` — the gate must be able to tell
 * "no history" apart from "history says locked", because only the first one
 * falls through to the paywall on its own.
 */
export function aiAccessFromLastKnownTier(tier: string | null): AiAccess {
    if (!tier) return 'unknown';
    return tier === 'none' ? 'locked' : 'entitled';
}
