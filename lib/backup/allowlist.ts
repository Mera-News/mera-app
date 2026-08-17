// What goes into a backup, as data.
//
// The rule everything here follows: **back up what the user created or curated;
// leave behind what the machine can regenerate.** A backup exists so a reinstall
// or a new phone does not destroy a persona built over months. It is not a disk
// image, and restoring machine state is not free — a stale scheduler job or a
// stale entitlement is actively harmful on the receiving device.
//
// Every table in `lib/database/schema.ts` must appear in exactly one of the two
// sets below. `allowlist.test.ts` asserts that against the live schema, so a new
// table fails the suite until someone decides which side it belongs on. That is
// the point: silence would mean new user data quietly stops being backed up.

/**
 * Tables written to the blob. Order matters on restore — parents before
 * children, because the importer seeds `_raw.id` and a child row referencing a
 * missing parent is a dangling read, not an error WatermelonDB will raise.
 */
export const BACKUP_TABLES: readonly string[] = [
  // Persona core. The reason this feature exists.
  'facts',
  'user_personas',
  'topics',
  'locations',
  'persona_suppressions',
  'persona_summary_strings',
  'persona_change_log',

  // Explicit curation the user performed by hand.
  'publication_preferences',
  'saved_article_suggestions',
  'tracked_stories',

  // Conversation history. `conversations` before `messages`.
  'conversations',
  'messages',

  // Long-lived user history that no resync reproduces.
  'publication_visits',
  'article_feedback',
  'fact_checks',

  // Key-value settings, filtered per-key by BACKUP_SETTING_KEYS below.
  'settings',
];

/**
 * Tables deliberately NOT backed up, each with the reason. A reason of
 * "regenerable" means the receiving device rebuilds it on its own; a reason of
 * "device-scoped" means restoring it would be wrong even though the data is
 * real.
 */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  article_suggestions:
    'Ephemeral feed rows on a 48h TTL, re-synced from the server. Also the largest table by far.',
  article_suggestion_facts:
    'Join rows for article_suggestions; meaningless without them.',
  translation_cache:
    'Explicitly documented in schema.ts as the one wipeable table — every row regenerates on demand.',
  story_impressions:
    'Seen-state for presentation only, 30d TTL. Restoring tens of thousands of rows to avoid a feed that looks unread is a poor size trade.',
  notifications:
    'Device-local notification centre, 90d TTL. A restored notification refers to an event on the old device.',
  scheduler_jobs:
    'Device-scoped scheduler bookkeeping. Restoring it replays stale run timestamps against a device that never ran them.',
  inference_jobs:
    'In-flight on-device job queue. Its rows reference work the new device is not doing, and some carry per-run key material.',
};

/**
 * The `settings` table is a wide key-value store whose keys are declared as
 * constants across ~20 services, some of them built at runtime. So it is
 * filtered by an ALLOWLIST, never a denylist: a new key added by a future wave
 * must be opted in deliberately, because the default has to be "do not carry
 * this to another device".
 *
 * These are user-visible preferences and curation — the things a user would be
 * annoyed to set up again.
 */
export const BACKUP_SETTING_KEYS: readonly string[] = [
  'app_language',
  'theme',
  'text_scale',
  'blur_images',
  'static_gradient',
  'startup_tab',
  'related_articles_sort',
  'feed_importance_filter',
  'dashboard_importance_filter',
  'for_you_recent_24h_only',
  'explore_browse_countries',
  'explore_suppressed_scopes',
  'mera_selected_model_id',
];

/**
 * Dynamic key families carried by prefix. `headline_depth:<scopeKey>` is one
 * row per country the user has tuned, so it cannot be enumerated statically.
 */
export const BACKUP_SETTING_KEY_PREFIXES: readonly string[] = [
  'headline_depth:',
];

/**
 * Keys that must NEVER enter a backup, with the reason. This list is redundant
 * with the allowlist by construction and that is deliberate: it is a tripwire.
 * `allowlist.test.ts` asserts the two never intersect, so adding one of these
 * to BACKUP_SETTING_KEYS fails the suite instead of shipping.
 *
 * `cached_user_id` is the one that would do real damage. It is the sentinel
 * `lib/security/identity-gate.ts` reads to answer "is this another user's
 * data?" — restoring one user's value onto a device signed in as anyone else
 * triggers `wipeAndProceed`, so a backup carrying it would destroy the very
 * data the restore just wrote.
 */
export const FORBIDDEN_SETTING_KEYS: Readonly<Record<string, string>> = {
  cached_user_id:
    'identity-gate sentinel — a mismatch triggers wipeAndProceed, so restoring it destroys the restore.',
  cached_user_email: 'Identity. Belongs to the session, not the persona.',
  last_authenticated_user_id: 'Identity, same reason.',
  identity_fault: 'Records a fault against the OLD device.',
  needs_reauth: 'Session state for a session that no longer exists.',
  'mera.cycle.capabilityToken': 'Short-lived capability token.',
  async_inference_pending_job_privkey: 'Private key material.',
  async_pipeline_privkey: 'Private key material.',
  last_known_subscription_tier:
    'Entitlement must resolve against the NEW device billing, never be asserted by a restored file.',
  free_tier_first_open_dismissed: 'Entitlement UI latch, same reason.',
  dev_free_tier_lapse_acked: 'Entitlement UI latch, same reason.',
  onboarding_state: 'Device flow state; onboarding gates on local facts anyway.',
  push_token_fail_streak: 'Counts failures of a push token this device does not have.',
};

/**
 * Per-table row caps. A cap makes a backup intentionally partial rather than
 * unbounded; the header records `rowsAvailable` alongside `rows` so the restore
 * UI can say so instead of implying completeness.
 *
 * Only tables that grow without bound are capped. Newest-first.
 */
export const TABLE_ROW_CAPS: Readonly<Record<string, number>> = {
  messages: 20_000,
  publication_visits: 20_000,
  persona_change_log: 10_000,
  article_feedback: 10_000,
  fact_checks: 2_000,
};

/** True when a settings key is carried, by exact match or by prefix family. */
export function isBackedUpSettingKey(key: string): boolean {
  if (Object.prototype.hasOwnProperty.call(FORBIDDEN_SETTING_KEYS, key)) return false;
  if (BACKUP_SETTING_KEYS.includes(key)) return true;
  return BACKUP_SETTING_KEY_PREFIXES.some((p) => key.startsWith(p));
}
