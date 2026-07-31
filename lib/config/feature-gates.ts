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
