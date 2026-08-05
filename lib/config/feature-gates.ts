// Ship-gates for features whose app code is finished but whose SERVER side has
// not reached production yet. Plain module-level booleans, deliberately: no
// env var, no remote config, no server capability probe. A gate here is read at
// build time, flipped in a commit, and shipped like any other change.

/**
 * Per-scope headline depth ("how many top headlines Mera reads for me in each
 * section"): the settings UI, the `settings` rows behind it, and the `limit`
 * this puts on each `topHeadlines.scopes[]` entry.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MUST STAY `false` UNTIL mera-server commit `40d7824` IS DEPLOYED TO PROD.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Production's GraphQL schema is still
 *   `input HeadlineScopeInput { countryCode: String, scope: HeadlineScope! }`
 * — it has NO `limit` field. `40d7824` adds it and currently sits on `dev`;
 * prod deploys are user-gated. An unknown field on an input object is a
 * VALIDATION error, and GraphQL validation rejects the WHOLE operation — so a
 * single scope carrying `limit` does not degrade headlines, it makes
 * `articleIdsForPersona` return nothing and the user's feed goes EMPTY.
 *
 * That is why the gate is enforced in `getHeadlineDepths()` (the single read
 * funnel into `buildRetrievalProfile`) and not only on the settings row. Gating
 * the row alone would be safe on the way out but not on the way BACK: flip this
 * to `true`, ship, users store overrides, then roll back to `false` — the rows
 * survive the rollback and would still put `limit` on the wire. Gating the read
 * makes stored rows inert whenever this is `false`, in both directions.
 *
 * Flipping this constant to `true` is the entire activation step. Nothing else
 * needs to change: the UI, the storage, the clamping and the wire mapping are
 * all already built and wired.
 */
export const HEADLINE_DEPTH_UI_ENABLED = false;

// ───────────────────────────────────────────────────────────────────────────
// Free-tier dev overrides
// ───────────────────────────────────────────────────────────────────────────
//
// `FORCE_SUBSCRIPTIONS` is off server-side, so none of the three entitlement
// states (entitled / locked / lapsed) are reachable from a real account — the
// server hands every user a working AI layer. These two constants let the
// simulator harness drive each state without flipping a server flag, logging
// the resident account out, or standing up a second account.
//
// BOTH ARE READ ONLY INSIDE `if (__DEV__)` (see lib/subscription/ai-access.ts)
// and BOTH MUST BE COMMITTED INERT (`null` / `false`). A committed
// `DEV_FORCE_AI_ACCESS = 'locked'` would ship Mera News Free to every user on
// the next OTA, and dead-code elimination of `__DEV__` in release bundles will
// NOT save you — the constant is still what production logic reads in dev
// builds handed to testers.

/**
 * Mera News Free itself — the whole of this wave's user-visible behaviour.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MUST STAY `false` UNTIL `FORCE_SUBSCRIPTIONS` IS FLIPPED TO `"true"` IN
 * PROD TERRAFORM (mera-infra/cloud-run.tf, news_graphql then news_auth).
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Without this gate, shipping the OTA WOULD ITSELF BE THE CUTOVER. `aiAccess`
 * is derived from `subscriptionTier`, and today essentially every user is
 * `'none'` (prod has no active subscriptions, and most users have no
 * `UserBilling` doc at all) — so `deriveAiAccess` would return `'locked'` for
 * everyone the moment they took the update, putting the entire user base onto
 * Mera News Free before trials even exist in the App Store and Play Console.
 *
 * The rollout plan is explicit that it must go the other way: the app OTA ships
 * FIRST and must be a no-op ("prod code deploys with FORCE_SUBSCRIPTIONS still
 * false — zero behavior change"), then the server flag flips once the UI is
 * live and adopted, so nobody meets a bare 402 with no free-tier UI to catch
 * it. This constant is what makes the OTA inert in the meantime.
 *
 * While `false`, `deriveAiAccess` short-circuits to `'entitled'` — exactly the
 * app's behaviour before this wave. `DEV_FORCE_AI_ACCESS` still overrides it,
 * so all of the free-tier UI stays drivable from the simulator harness.
 *
 * Flipping this to `true` is the entire app-side activation step; it needs its
 * own OTA, timed with the server flag.
 */
// TEMP(staging-paywall-test): revert to `false` before committing.
// Local, uncommitted change only — exercises the real server-driven paywall
// against STAGING (FORCE_SUBSCRIPTIONS="true" there).
// This must NOT reach a commit or an OTA: prod still has the flag off, so a
// committed `true` would put the entire prod user base onto Mera News Free.
export const FREE_TIER_MODE_ENABLED = false;

/**
 * Force the derived `aiAccess` verdict, bypassing the ship gate above, the
 * server tier, the RevenueCat mirror, and any recorded 402. `null` = no
 * override (ship state).
 */
export const DEV_FORCE_AI_ACCESS: 'entitled' | 'locked' | null = null;

/**
 * Force `showLapseInterstitial` on, as if the server had reported a lapse the
 * user has not acknowledged yet.
 *
 * Deliberately a SEED, not a clamp: the interstitial gate's acknowledge path
 * writes a local dev-only ack flag, and this override stops applying once that
 * flag is set. A clamp would make the interstitial reappear on every relaunch
 * forever, which is precisely the "shown exactly once" behaviour under test.
 * Clear the flag (see `DEV_LAPSE_ACK_SETTING_KEY`) to re-arm it.
 */
export const DEV_FORCE_LAPSED = false;
