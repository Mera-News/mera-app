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

import { RESTORE_IN_PROGRESS_KEY } from './types';

/**
 * Tables written to the blob. Order matters on restore — parents before
 * children, because the importer seeds `_raw.id` and a child row referencing a
 * missing parent is a dangling read, not an error WatermelonDB will raise.
 */
export const BACKUP_TABLES: readonly string[] = [
  // Persona core. The reason this feature exists.
  'facts',
  'user_personas',
  // `topics.fact_id` points at facts, so facts come first.
  'topics',
  'locations',
  'persona_suppressions',
  'persona_summary_strings',

  // Explicit curation the user performed by hand. Not the feed.
  'publication_preferences',
  // `tracked_stories.topic_id` points at topics.
  'tracked_stories',
  'saved_article_suggestions',
  'publication_visits',

  // Key-value settings, filtered per-key by BACKUP_SETTING_KEYS below.
  'settings',
];

/**
 * The tables a restore REPLACES: everything backed up except `settings`.
 *
 * A restore's semantics are "replace the persona", not "merge these tables".
 * Deriving the clear list from the blob's own `header.tables[]` instead would
 * mean a blob declaring a subset restores its persona ON TOP of the tables it
 * did not declare — which is exactly the mixed persona `lifecycle.ts` exists to
 * prevent. Today's exporter always emits every section, so the two agree and
 * nothing fails; that is what makes it worth pinning rather than leaving to
 * coincidence.
 *
 * `settings` is excluded because clearing it would take `cached_user_id`,
 * `needs_reauth` and the PIN preference with it, and those belong to the device
 * the restore is landing on.
 */
export const RESTORE_REPLACED_TABLES: readonly string[] = BACKUP_TABLES.filter(
  (t) => t !== 'settings',
);

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
  conversations:
    'Chat history. Owner call 2026-08-18: a backup carries the persona, not the transcripts that shaped it. The facts a conversation produced ARE backed up, which is the part that changes what the user sees.',
  messages:
    'Chat history, same call. It was also the largest backed-up table by a wide margin and the only one that still needed a row cap.',
  article_feedback:
    'Per-article reactions. Article data, and its lasting effect is already in facts, suppressions and topic weights.',
  fact_checks:
    'Keyed to specific articles, and every row is re-derivable by asking again. The server also expires them at 90d.',
  persona_change_log:
    'Audit trail of how the persona was edited. The persona itself restores correctly without it, and it is history about a device rather than user data.',
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
  dev_free_tier_lapse_acked: 'Entitlement UI latch, same reason.',
  email_capture_skipped:
    'Device-local prompt preference (informed email skip at checkout). A restored file must not silence the ask on a new device.',
  onboarding_state: 'Device flow state; onboarding gates on local facts anyway.',
  push_token_fail_streak: 'Counts failures of a push token this device does not have.',
  backup_cadence:
    'Device schedule state. Restoring "daily to iCloud" onto a device with no key, or no iCloud, enables a schedule that can only fail.',
  backup_provider: 'Device schedule state, same reason.',
  backup_wifi_only: 'Device schedule state, same reason.',
  backup_last_run_at:
    'Records when THIS device last uploaded. Restored, it would make a new device believe it is already up to date and skip its first backup.',
  backup_recovery_code_confirmed:
    'Records that THIS device showed the user their code. Restoring it onto a new device would assert a confirmation that never happened and let a backup upload under a key nobody has written down.',
  [RESTORE_IN_PROGRESS_KEY]:
    'Torn-restore marker for THIS device. Backing it up would restore a permanent "a restore is in progress" state onto the next device.',
};

/**
 * Per-table row caps. A cap makes a backup intentionally partial rather than
 * unbounded; the header records `rowsAvailable` alongside `rows` so the restore
 * UI can say so instead of implying completeness.
 *
 * Only two tables need one now. Both grow with ordinary use and both carry a
 * full article payload per row, so they dominate the blob; everything else in
 * the allowlist is bounded by deliberate user action.
 */
export const TABLE_ROW_CAPS: Readonly<Record<string, number>> = {
  saved_article_suggestions: 10_000,
  publication_visits: 20_000,
};

/**
 * The timestamp column each capped table is ordered by, newest first.
 *
 * "Newest-first" is not decoration, it is the whole meaning of a cap. A
 * WatermelonDB row id is a random string, so paging a capped table by `id`
 * takes an ARBITRARY N of the user's rows — mostly old ones — and every small
 * round-trip test would still pass. `allowlist.test.ts` asserts the two records
 * have identical keys and that the column exists in `schema.ts`.
 *
 * `id` is the tiebreaker at the call site: without one, two rows sharing a
 * timestamp can swap places between pages and OFFSET paging silently drops or
 * duplicates a row.
 */
export const TABLE_CAP_ORDER_COLUMN: Readonly<Record<string, string>> = {
  saved_article_suggestions: 'saved_at',
  publication_visits: 'visited_at',
};

/** True when a settings key is carried, by exact match or by prefix family. */
export function isBackedUpSettingKey(key: string): boolean {
  if (Object.prototype.hasOwnProperty.call(FORBIDDEN_SETTING_KEYS, key)) return false;
  if (BACKUP_SETTING_KEYS.includes(key)) return true;
  return BACKUP_SETTING_KEY_PREFIXES.some((p) => key.startsWith(p));
}
