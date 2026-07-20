import {
  schemaMigrations,
  addColumns,
  createTable,
  unsafeExecuteSql,
} from '@nozbe/watermelondb/Schema/migrations';

export default schemaMigrations({
  migrations: [
    {
      toVersion: 2,
      steps: [
        createTable({
          name: 'inference_jobs',
          columns: [
            { name: 'job_type', type: 'string', isIndexed: true },
            { name: 'status', type: 'string', isIndexed: true },
            { name: 'priority', type: 'number', isIndexed: true },
            { name: 'payload_json', type: 'string' },
            { name: 'result_json', type: 'string', isOptional: true },
            { name: 'error_message', type: 'string', isOptional: true },
            { name: 'attempts', type: 'number' },
            { name: 'max_attempts', type: 'number' },
            { name: 'created_at', type: 'number' },
            { name: 'updated_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 3,
      steps: [
        addColumns({
          table: 'facts',
          columns: [
            { name: 'questionnaire_level', type: 'number', isOptional: true },
            { name: 'questionnaire_level_category', type: 'string', isOptional: true },
            { name: 'questionnaire_attribute', type: 'string', isOptional: true },
          ],
        }),
      ],
    },
    {
      toVersion: 4,
      steps: [
        addColumns({
          table: 'cluster_suggestions',
          columns: [
            { name: 'user_topics_json', type: 'string', isOptional: true },
          ],
        }),
      ],
    },
    {
      toVersion: 5,
      steps: [
        addColumns({
          table: 'cluster_suggestions',
          columns: [
            { name: 'llm_article_title', type: 'string', isOptional: true },
            { name: 'llm_article_description', type: 'string', isOptional: true },
          ],
        }),
      ],
    },
    {
      toVersion: 6,
      steps: [
        addColumns({
          table: 'cluster_suggestions',
          columns: [
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
          ],
        }),
      ],
    },
    {
      toVersion: 7,
      steps: [
        // Drop tables we no longer use. Each unsafeExecuteSql carries exactly
        // one statement terminated with a semicolon (WatermelonDB requirement).
        unsafeExecuteSql('DROP TABLE IF EXISTS local_scores;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestions;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS news_articles;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS news_clusters;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS server_user_facts;'),

        // Wipe stale cluster_suggestions rows — the old persist path set
        // relevance=0 / reason='' as defaults. After this migration, unscored
        // is signalled by `is_scored = 0`.
        unsafeExecuteSql('DELETE FROM cluster_suggestions;'),

        // New columns on cluster_suggestions.
        //   image_url:  the cluster's hero image (was on news_clusters).
        //   is_scored:  0 = not yet scored, 1 = scored (default 0 for existing rows).
        addColumns({
          table: 'cluster_suggestions',
          columns: [
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'is_scored', type: 'boolean' },
          ],
        }),

        // New join table: cluster_suggestion ↔ fact (many-to-many).
        createTable({
          name: 'cluster_suggestion_facts',
          columns: [
            { name: 'cluster_suggestion_id', type: 'string', isIndexed: true },
            { name: 'fact_id', type: 'string', isIndexed: true },
            { name: 'created_at', type: 'number' },
          ],
        }),

        // Note: the `server_user_fact_id` column on `user_topics` is no longer
        // referenced in the schema or model. SQLite keeps the physical column;
        // WatermelonDB reads/writes only schema-declared columns so the stale
        // column is harmless (avoids a fragile DROP COLUMN migration).
      ],
    },
    {
      toVersion: 8,
      steps: [
        // Collapse cluster_suggestion's server_id column: from now on the
        // WatermelonDB row `id` IS the MongoDB server `_id`. That means every
        // existing row's WMDB id no longer matches — wipe and rebuild from
        // the server on next sync. cluster_suggestion_facts has to go too
        // (rows reference the now-invalid old WMDB ids).
        unsafeExecuteSql('DROP TABLE IF EXISTS cluster_suggestion_facts;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS cluster_suggestions;'),

        createTable({
          name: 'cluster_suggestions',
          columns: [
            { name: 'cluster_id', type: 'string', isIndexed: true },
            { name: 'relevance', type: 'number' },
            { name: 'reason', type: 'string' },
            { name: 'is_scored', type: 'boolean' },
            { name: 'title_for_user', type: 'string', isOptional: true },
            { name: 'cluster_size', type: 'number' },
            { name: 'country_code', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'publication_name', type: 'string', isOptional: true },
            { name: 'llm_article_title', type: 'string', isOptional: true },
            { name: 'llm_article_description', type: 'string', isOptional: true },
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'user_topics_json', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'updated_at', type: 'number' },
          ],
        }),

        createTable({
          name: 'cluster_suggestion_facts',
          columns: [
            { name: 'cluster_suggestion_id', type: 'string', isIndexed: true },
            { name: 'fact_id', type: 'string', isIndexed: true },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 9,
      steps: [
        // Replace is_scored with two explicit completion flags so we can
        // distinguish "relevance failed" from "reason failed" and retry
        // each independently. cluster_suggestions is an ephemeral cache
        // rebuilt by syncFeed from the server's 24h window — it's always
        // safe to wipe and re-sync.
        unsafeExecuteSql('DROP TABLE IF EXISTS cluster_suggestion_facts;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS cluster_suggestions;'),

        createTable({
          name: 'cluster_suggestions',
          columns: [
            { name: 'cluster_id', type: 'string', isIndexed: true },
            { name: 'relevance', type: 'number' },
            { name: 'reason', type: 'string' },
            { name: 'relevance_generation_completed', type: 'boolean' },
            { name: 'reason_generation_completed', type: 'boolean' },
            { name: 'title_for_user', type: 'string', isOptional: true },
            { name: 'cluster_size', type: 'number' },
            { name: 'country_code', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'publication_name', type: 'string', isOptional: true },
            { name: 'llm_article_title', type: 'string', isOptional: true },
            { name: 'llm_article_description', type: 'string', isOptional: true },
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'user_topics_json', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'updated_at', type: 'number' },
          ],
        }),

        createTable({
          name: 'cluster_suggestion_facts',
          columns: [
            { name: 'cluster_suggestion_id', type: 'string', isIndexed: true },
            { name: 'fact_id', type: 'string', isIndexed: true },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 10,
      steps: [
        // Split Expo push token from visible-notification opt-in. The token
        // is transport plumbing for silent "result-ready" pushes and should
        // be registered regardless of user preference; this flag gates only
        // OS-visible interrupts.
        addColumns({
          table: 'user_personas',
          columns: [
            { name: 'notifications_enabled', type: 'boolean' },
          ],
        }),
      ],
    },
    {
      toVersion: 11,
      steps: [
        // Replace the binary `mera_protocol_enabled` flag with a `processing_mode`
        // enum string ('on-device' | 'cloud'). Mera Protocol is now always on —
        // users pick which backend runs inference. The persona row will be
        // refreshed from the server on the next sync, so we don't backfill.
        addColumns({
          table: 'user_personas',
          columns: [
            { name: 'processing_mode', type: 'string' },
          ],
        }),
        unsafeExecuteSql(
          "UPDATE user_personas SET processing_mode = CASE WHEN mera_protocol_enabled = 1 THEN 'on-device' ELSE 'cloud' END;",
        ),
      ],
    },
    {
      toVersion: 12,
      steps: [
        // The server's "what's in the user's 24h window" id-set — decoupled
        // from `cluster_suggestions` so a row's hydrated data can be
        // discarded after scoring (relevance ≤ 0.3) without forgetting
        // the id is server-owed. processed_at = null means "still owes
        // us a scoring cycle"; non-null means "handled, don't re-fetch".
        createTable({
          name: 'synced_suggestion_ids',
          columns: [
            { name: 'fetched_at', type: 'number' },
            { name: 'processed_at', type: 'number', isOptional: true, isIndexed: true },
          ],
        }),
      ],
    },
    {
      toVersion: 13,
      steps: [
        // Drop the server-side personalized title — titles are now picked
        // on-device (original / English / user-language) from the article
        // list, never stored on the suggestion row. cluster_suggestions is
        // ephemeral; wipe-and-recreate per the established pattern. Also
        // clear synced_suggestion_ids so the next sync re-fetches the full
        // 24h window without title_for_user.
        unsafeExecuteSql('DROP TABLE IF EXISTS cluster_suggestion_facts;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS cluster_suggestions;'),
        unsafeExecuteSql('DELETE FROM synced_suggestion_ids;'),

        createTable({
          name: 'cluster_suggestions',
          columns: [
            { name: 'cluster_id', type: 'string', isIndexed: true },
            { name: 'relevance', type: 'number' },
            { name: 'reason', type: 'string' },
            { name: 'relevance_generation_completed', type: 'boolean' },
            { name: 'reason_generation_completed', type: 'boolean' },
            { name: 'cluster_size', type: 'number' },
            { name: 'country_code', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'publication_name', type: 'string', isOptional: true },
            { name: 'llm_article_title', type: 'string', isOptional: true },
            { name: 'llm_article_description', type: 'string', isOptional: true },
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'user_topics_json', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'updated_at', type: 'number' },
          ],
        }),

        createTable({
          name: 'cluster_suggestion_facts',
          columns: [
            { name: 'cluster_suggestion_id', type: 'string', isIndexed: true },
            { name: 'fact_id', type: 'string', isIndexed: true },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 14,
      steps: [
        // Add first_pub_date / last_pub_date — the oldest and newest article
        // publication times in the cluster. first_pub_date is frozen at
        // suggestion creation; last_pub_date is refreshed by the server on
        // every personalization pass so the "X ago" card label tracks the
        // freshest reporting. cluster_suggestions is ephemeral (rebuilt by
        // syncFeed from the 24h window) so wipe-and-recreate per the
        // established pattern. Also clear synced_suggestion_ids so the next
        // sync re-fetches the full window with the new fields populated.
        unsafeExecuteSql('DROP TABLE IF EXISTS cluster_suggestion_facts;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS cluster_suggestions;'),
        unsafeExecuteSql('DELETE FROM synced_suggestion_ids;'),

        createTable({
          name: 'cluster_suggestions',
          columns: [
            { name: 'cluster_id', type: 'string', isIndexed: true },
            { name: 'relevance', type: 'number' },
            { name: 'reason', type: 'string' },
            { name: 'relevance_generation_completed', type: 'boolean' },
            { name: 'reason_generation_completed', type: 'boolean' },
            { name: 'cluster_size', type: 'number' },
            { name: 'country_code', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'publication_name', type: 'string', isOptional: true },
            { name: 'llm_article_title', type: 'string', isOptional: true },
            { name: 'llm_article_description', type: 'string', isOptional: true },
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'user_topics_json', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'updated_at', type: 'number' },
            { name: 'first_pub_date', type: 'number' },
            { name: 'last_pub_date', type: 'number' },
          ],
        }),

        createTable({
          name: 'cluster_suggestion_facts',
          columns: [
            { name: 'cluster_suggestion_id', type: 'string', isIndexed: true },
            { name: 'fact_id', type: 'string', isIndexed: true },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 15,
      steps: [
        // Final Mera-Protocol layer: noise injection. Decoy topics submitted to
        // the server alongside real topics; the local id set is consulted at
        // sync time to discard any cluster_suggestion that matched only noise.
        // Long-lived table — created via a real migration (not drop/recreate).
        createTable({
          name: 'noisy_user_topics',
          columns: [
            { name: 'server_id', type: 'string', isIndexed: true },
            { name: 'user_persona_id', type: 'string', isIndexed: true },
            { name: 'news_topic_text', type: 'string' },
            { name: 'parent_topic_text', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 16,
      steps: [
        // Link noisy topics back to their source fact so destroyCascade()
        // sweeps decoys when the fact is deleted, and so the Persona-tab
        // debug switch can group noisy topics under their owning fact.
        // Optional column — pre-v16 rows remain unlinked but still drive the
        // suggestion-sync discard filter via `getNoisyTopicIds()`.
        addColumns({
          table: 'noisy_user_topics',
          columns: [
            { name: 'fact_id', type: 'string', isIndexed: true, isOptional: true },
          ],
        }),
      ],
    },
    {
      toVersion: 17,
      steps: [
        // Drop the user-tunable notification_sensitivity column. WatermelonDB
        // only reads/writes schema-declared columns, so the physical SQLite
        // column on existing installs is harmless and intentionally left in
        // place (avoids a fragile DROP COLUMN migration). Empty steps because
        // WatermelonDB requires a migration entry for every schema version.
      ],
    },
    {
      toVersion: 18,
      steps: [
        // Replace the local cache's `onboarded` boolean with `onboarding_stage`
        // (server is now monotonic — see UserPersona model). The row is
        // re-synced from the server on next launch, so we don't backfill.
        // The old `onboarded` column stays in SQLite (WatermelonDB reads only
        // schema-declared columns).
        addColumns({
          table: 'user_personas',
          columns: [
            { name: 'onboarding_stage', type: 'string' },
          ],
        }),
      ],
    },
    {
      toVersion: 19,
      steps: [
        // Drop the `cluster_size` column from cluster_suggestions — the server
        // no longer publishes the field. WatermelonDB only reads/writes
        // schema-declared columns, so the physical SQLite column on existing
        // installs is harmless and left in place (avoids a fragile
        // DROP COLUMN migration). Empty steps because WatermelonDB requires
        // a migration entry for every schema version.
      ],
    },
    {
      toVersion: 20,
      steps: [
        // Article-keyed personalization: the server stopped persisting
        // ClusterSuggestion. The local feed now mirrors ArticleSuggestion
        // rows (unique on `articleId`). No cluster id is stored — HDBSCAN
        // re-partitions every server pass, so the live cluster is fetched
        // on-demand via `relatedArticles(articleId)` only when the detail
        // screen needs it. Drop the old cluster_suggestions tables and
        // recreate them as article_suggestions — data is ephemeral and
        // re-syncs from the server.
        //
        // Also clear synced_suggestion_ids: those ids point at the old
        // ClusterSuggestion collection, which the new server no longer serves.
        unsafeExecuteSql('DROP TABLE IF EXISTS cluster_suggestion_facts;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS cluster_suggestions;'),
        unsafeExecuteSql('DELETE FROM synced_suggestion_ids;'),

        createTable({
          name: 'article_suggestions',
          columns: [
            { name: 'article_id', type: 'string', isIndexed: true },
            { name: 'relevance', type: 'number' },
            { name: 'reason', type: 'string' },
            { name: 'relevance_generation_completed', type: 'boolean' },
            { name: 'reason_generation_completed', type: 'boolean' },
            { name: 'country_code', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'publication_name', type: 'string', isOptional: true },
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
            { name: 'article_url', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'user_topic_ids_json', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'first_pub_date', type: 'number' },
          ],
        }),

        createTable({
          name: 'article_suggestion_facts',
          columns: [
            { name: 'article_suggestion_id', type: 'string', isIndexed: true },
            { name: 'fact_id', type: 'string', isIndexed: true },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 21,
      steps: [
        // Add `cluster_ids_json` to article_suggestions so the For-You feed
        // can group sibling cards into a stacked-card. An article can be in
        // multiple clusters (cluster-article-link is many-to-many), so the
        // column stores a JSON-encoded `string[]`. Refreshed every sync by
        // the syncFeed writer. article_suggestions is ephemeral and
        // re-syncs from the server, so we wipe-and-recreate per the
        // established pattern.
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestion_facts;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestions;'),
        unsafeExecuteSql('DELETE FROM synced_suggestion_ids;'),

        createTable({
          name: 'article_suggestions',
          columns: [
            { name: 'article_id', type: 'string', isIndexed: true },
            { name: 'cluster_ids_json', type: 'string', isOptional: true },
            { name: 'relevance', type: 'number' },
            { name: 'reason', type: 'string' },
            { name: 'relevance_generation_completed', type: 'boolean' },
            { name: 'reason_generation_completed', type: 'boolean' },
            { name: 'country_code', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'publication_name', type: 'string', isOptional: true },
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
            { name: 'article_url', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'user_topic_ids_json', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'first_pub_date', type: 'number' },
          ],
        }),

        createTable({
          name: 'article_suggestion_facts',
          columns: [
            { name: 'article_suggestion_id', type: 'string', isIndexed: true },
            { name: 'fact_id', type: 'string', isIndexed: true },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 22,
      steps: [
        // Long-lived log of "Read Article" taps. Drives the Sources-tab
        // most-visited card, the drill-down list, and the per-publication
        // visit-count badge on detail screens. User-owned state — created
        // via createTable, never wipe-and-recreate.
        createTable({
          name: 'publication_visits',
          columns: [
            { name: 'publication_name', type: 'string', isIndexed: true },
            { name: 'country_code', type: 'string', isOptional: true, isIndexed: true },
            { name: 'article_id', type: 'string', isOptional: true },
            { name: 'article_suggestion_id', type: 'string', isOptional: true },
            { name: 'article_url', type: 'string', isOptional: true },
            { name: 'visited_at', type: 'number', isIndexed: true },
          ],
        }),
      ],
    },
    {
      toVersion: 23,
      steps: [
        // Snapshot card-renderable fields onto each visit row so the
        // per-publication article-history screen can render even after
        // the source article_suggestion has been swept by its 24h TTL.
        // article_id becomes indexed for the dedupe-by-article query.
        addColumns({
          table: 'publication_visits',
          columns: [
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'title_original', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'pub_date', type: 'number', isOptional: true },
          ],
        }),
      ],
    },
    {
      toVersion: 24,
      steps: [
        // Drop synced_suggestion_ids — v1 article suggestion flow removed.
        // Article suggestions are now on-device only (ArticleSuggestion model
        // stays; synced_suggestion_ids was the v1 server-id tracking table).
        unsafeExecuteSql('DROP TABLE IF EXISTS synced_suggestion_ids;'),
      ],
    },
    {
      toVersion: 25,
      steps: [
        createTable({
          name: 'scheduler_jobs',
          columns: [
            { name: 'task_name', type: 'string', isIndexed: true },
            { name: 'status', type: 'string', isIndexed: true },
            { name: 'input_json', type: 'string', isOptional: true },
            { name: 'error_code', type: 'string', isOptional: true },
            { name: 'error_message', type: 'string', isOptional: true },
            { name: 'attempt', type: 'number' },
            { name: 'max_attempts', type: 'number' },
            { name: 'scheduled_at', type: 'number' },
            { name: 'started_at', type: 'number', isOptional: true },
            { name: 'completed_at', type: 'number', isOptional: true },
            { name: 'retry_at', type: 'number', isOptional: true },
          ],
        }),
      ],
    },
    {
      toVersion: 26,
      steps: [
        // Drop noisy_user_topics — noise injection removed entirely.
        unsafeExecuteSql('DROP TABLE IF EXISTS noisy_user_topics;'),
        // Rename user_topic_ids_json → matched_topic_texts_json in article_suggestions.
        // article_suggestions is ephemeral; drop-and-recreate per established pattern.
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestion_facts;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestions;'),
        createTable({
          name: 'article_suggestions',
          columns: [
            { name: 'article_id', type: 'string', isIndexed: true },
            { name: 'cluster_ids_json', type: 'string', isOptional: true },
            { name: 'relevance', type: 'number' },
            { name: 'reason', type: 'string' },
            { name: 'relevance_generation_completed', type: 'boolean' },
            { name: 'reason_generation_completed', type: 'boolean' },
            { name: 'country_code', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'publication_name', type: 'string', isOptional: true },
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
            { name: 'article_url', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'matched_topic_texts_json', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'first_pub_date', type: 'number' },
          ],
        }),
        createTable({
          name: 'article_suggestion_facts',
          columns: [
            { name: 'article_suggestion_id', type: 'string', isIndexed: true },
            { name: 'fact_id', type: 'string', isIndexed: true },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 27,
      steps: [
        // Clear ephemeral caches and stale state from the old article
        // suggestion flow (pre-flow-v2). Preserves user-owned data:
        // facts, user_personas, user_topics, fact_topic_links, publication_visits.
        unsafeExecuteSql('DELETE FROM article_suggestions;'),
        unsafeExecuteSql('DELETE FROM article_suggestion_facts;'),
        unsafeExecuteSql('DELETE FROM inference_jobs;'),
        unsafeExecuteSql('DELETE FROM scheduler_jobs;'),
        // Stale settings from the v1 sync flow and old user-id tracking
        unsafeExecuteSql(
          "DELETE FROM settings WHERE key IN ('synced_ids_last_fetched_at', 'feed_sync_machine_state', 'feed_metadata', 'last_authenticated_user_id');",
        ),
      ],
    },
    {
      toVersion: 28,
      steps: [
        // Purge orphaned personas and topics from accounts other than the
        // currently logged-in user. Only one user's data should live on-device
        // at a time; persistUserPersona now enforces this going forward.
        unsafeExecuteSql(
          "DELETE FROM user_topics WHERE user_persona_id IN (SELECT id FROM user_personas WHERE user_id != (SELECT value FROM settings WHERE key = 'cached_user_id'));",
        ),
        unsafeExecuteSql(
          "DELETE FROM user_personas WHERE user_id != (SELECT value FROM settings WHERE key = 'cached_user_id');",
        ),
        // Remove fact_topic_links that reference topics that no longer exist.
        // backfillFactTopicLinks rebuilds the correct links on next launch.
        unsafeExecuteSql(
          'DELETE FROM fact_topic_links WHERE server_topic_id NOT IN (SELECT server_id FROM user_topics);',
        ),
        // Clear the stale failed-sync snapshot so the machine starts fresh.
        unsafeExecuteSql(
          "DELETE FROM settings WHERE key = 'feed_sync_machine_state';",
        ),
      ],
    },
    {
      toVersion: 29,
      steps: [
        // Clear stuck inference cycle state. The reconciler returns early when
        // there is no pending job without resetting cycleState, so any non-idle
        // value left here after a DB reset / migration blocks new scoring runs
        // until recoverCycle detects the orphaned state and self-corrects.
        // Deleting these settings here ensures existing installs that applied
        // v28 but never launched after the recoverCycle fix get unblocked.
        unsafeExecuteSql(
          "DELETE FROM settings WHERE key IN ('inference_cycle_state', 'inference_cycle_notif_dispatched_for');",
        ),
        // Prune retrying scheduler jobs whose setTimeout timers were lost on
        // app kill. pruneOldJobs skips 'retrying' status, so these accumulate
        // indefinitely. Deleting them here is safe: the tasks will be
        // re-triggered on the next scheduler run.
        unsafeExecuteSql("DELETE FROM scheduler_jobs WHERE status = 'retrying';"),
      ],
    },
    {
      toVersion: 30,
      steps: [
        // Drop server-topic-sync tables. Topics are now sent as raw text strings
        // directly to the server at feed-sync time; there is no longer a
        // server-assigned topicId or a local mirror of server topics.
        unsafeExecuteSql('DROP TABLE IF EXISTS fact_topic_links;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS user_topics;'),
      ],
    },
    {
      toVersion: 31,
      steps: [
        // Add title_original to article_suggestions to support showing the
        // original-language title when the app language matches the article language.
        // article_suggestions is ephemeral; drop-and-recreate per established pattern.
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestion_facts;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestions;'),
        createTable({
          name: 'article_suggestions',
          columns: [
            { name: 'article_id', type: 'string', isIndexed: true },
            { name: 'cluster_ids_json', type: 'string', isOptional: true },
            { name: 'relevance', type: 'number' },
            { name: 'reason', type: 'string' },
            { name: 'relevance_generation_completed', type: 'boolean' },
            { name: 'reason_generation_completed', type: 'boolean' },
            { name: 'country_code', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'publication_name', type: 'string', isOptional: true },
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'title_original', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
            { name: 'article_url', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'matched_topic_texts_json', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'first_pub_date', type: 'number' },
          ],
        }),
        createTable({
          name: 'article_suggestion_facts',
          columns: [
            { name: 'article_suggestion_id', type: 'string', isIndexed: true },
            { name: 'fact_id', type: 'string', isIndexed: true },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 32,
      steps: [
        // Replace cluster_ids_json (JSON `string[]`) with cluster_memberships_json
        // (JSON `{ clusterId, confidence }[]`) so the For-You feed can collapse
        // only the dense, high-confidence core of a cluster into one card.
        // article_suggestions is ephemeral; drop-and-recreate per established pattern.
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestion_facts;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestions;'),
        createTable({
          name: 'article_suggestions',
          columns: [
            { name: 'article_id', type: 'string', isIndexed: true },
            { name: 'cluster_memberships_json', type: 'string', isOptional: true },
            { name: 'relevance', type: 'number' },
            { name: 'reason', type: 'string' },
            { name: 'relevance_generation_completed', type: 'boolean' },
            { name: 'reason_generation_completed', type: 'boolean' },
            { name: 'country_code', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'publication_name', type: 'string', isOptional: true },
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'title_original', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
            { name: 'article_url', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'matched_topic_texts_json', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'first_pub_date', type: 'number' },
          ],
        }),
        createTable({
          name: 'article_suggestion_facts',
          columns: [
            { name: 'article_suggestion_id', type: 'string', isIndexed: true },
            { name: 'fact_id', type: 'string', isIndexed: true },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 33,
      steps: [
        // Device-local "save for later" table. Long-lived, user-owned state
        // (30-day TTL) — created via createTable, never wipe-and-recreate.
        // Mirrors article_suggestions' columns plus an indexed saved_at.
        createTable({
          name: 'saved_article_suggestions',
          columns: [
            { name: 'article_id', type: 'string', isIndexed: true },
            { name: 'cluster_memberships_json', type: 'string', isOptional: true },
            { name: 'relevance', type: 'number' },
            { name: 'reason', type: 'string' },
            { name: 'relevance_generation_completed', type: 'boolean' },
            { name: 'reason_generation_completed', type: 'boolean' },
            { name: 'country_code', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'publication_name', type: 'string', isOptional: true },
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'title_original', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
            { name: 'article_url', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'matched_topic_texts_json', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'first_pub_date', type: 'number' },
            { name: 'saved_at', type: 'number', isIndexed: true },
          ],
        }),
      ],
    },
    {
      toVersion: 34,
      steps: [
        // Replace the relevance_generation_completed / reason_generation_completed
        // boolean pair with a single `status` state-machine column
        // (unscored | reason_pending | complete) — one finite-state machine in one
        // column instead of two booleans. See lib/database/article-suggestion-status.ts.
        // article_suggestions is ephemeral; drop-and-recreate per established pattern.
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestion_facts;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestions;'),
        createTable({
          name: 'article_suggestions',
          columns: [
            { name: 'article_id', type: 'string', isIndexed: true },
            { name: 'cluster_memberships_json', type: 'string', isOptional: true },
            { name: 'relevance', type: 'number' },
            { name: 'reason', type: 'string' },
            { name: 'status', type: 'string', isIndexed: true },
            { name: 'country_code', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'publication_name', type: 'string', isOptional: true },
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'title_original', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
            { name: 'article_url', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'matched_topic_texts_json', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'first_pub_date', type: 'number' },
          ],
        }),
        createTable({
          name: 'article_suggestion_facts',
          columns: [
            { name: 'article_suggestion_id', type: 'string', isIndexed: true },
            { name: 'fact_id', type: 'string', isIndexed: true },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 35,
      steps: [
        // Persist assistant tool calls alongside chat messages so fact cards can
        // later render the statements a tool created/deleted. Additive column on
        // the long-lived `messages` table — never wipe-and-recreate.
        addColumns({
          table: 'messages',
          columns: [
            { name: 'tool_calls_json', type: 'string', isOptional: true },
          ],
        }),
      ],
    },
    {
      toVersion: 36,
      steps: [
        // Local log of article feedback (like/improve/dislike) from the
        // ArticleFeedbackPrompt widget. User-owned, long-lived history —
        // created via createTable, never wipe-and-recreate.
        createTable({
          name: 'article_feedback',
          columns: [
            { name: 'article_id', type: 'string', isIndexed: true },
            { name: 'suggestion_id', type: 'string', isOptional: true },
            { name: 'sentiment', type: 'string' },
            { name: 'title', type: 'string' },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 37,
      steps: [
        // ── Persona v3 data model ──────────────────────────────────────
        // Six long-lived, user-owned tables + `notifications` (7 total),
        // an additive `facts.weight` column, and a drop/recreate of the
        // ephemeral `article_suggestions` (+ join) with the scorer/audit
        // columns. Nothing reads the new tables yet — the feed still runs
        // on `fact.metadata.topics`; the silent persona migration only
        // POPULATES these tables. FORWARD-FIX-ONLY from this schema on
        // (WatermelonDB cannot roll back).

        // The weighted granular topic — replaces `fact.metadata.topics`.
        createTable({
          name: 'topics',
          columns: [
            { name: 'fact_id', type: 'string', isOptional: true, isIndexed: true },
            { name: 'text', type: 'string' },
            { name: 'normalized_text', type: 'string', isIndexed: true },
            { name: 'weight', type: 'number' },
            { name: 'status', type: 'string', isIndexed: true },
            { name: 'provenance', type: 'string' },
            { name: 'high_priority', type: 'boolean' },
            { name: 'location_id', type: 'string', isOptional: true, isIndexed: true },
            { name: 'last_signal_at', type: 'number', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'updated_at', type: 'number' },
          ],
        }),

        // Role-tagged place entities.
        createTable({
          name: 'locations',
          columns: [
            { name: 'city', type: 'string', isOptional: true },
            { name: 'region', type: 'string', isOptional: true },
            { name: 'country_code', type: 'string', isIndexed: true },
            { name: 'role', type: 'string' },
            { name: 'weight', type: 'number' },
            { name: 'valid_until', type: 'number', isOptional: true },
            { name: 'pinned_for_weather', type: 'boolean' },
            { name: 'provenance', type: 'string' },
            { name: 'source_fact_id', type: 'string', isOptional: true, isIndexed: true },
            { name: 'created_at', type: 'number' },
            { name: 'updated_at', type: 'number' },
          ],
        }),

        // Preferred / blocked publications.
        createTable({
          name: 'publication_preferences',
          columns: [
            { name: 'publication_name', type: 'string', isIndexed: true },
            { name: 'source_country_code', type: 'string', isOptional: true },
            { name: 'weight', type: 'number' },
            { name: 'status', type: 'string' },
            { name: 'provenance', type: 'string' },
            { name: 'created_at', type: 'number' },
            { name: 'updated_at', type: 'number' },
          ],
        }),

        // Negative preferences / show-less escalations.
        createTable({
          name: 'persona_suppressions',
          columns: [
            { name: 'pattern', type: 'string' },
            { name: 'keywords_json', type: 'string' },
            { name: 'strength', type: 'number' },
            { name: 'source', type: 'string' },
            { name: 'status', type: 'string' },
            { name: 'expires_at', type: 'number', isOptional: true },
            { name: 'created_at', type: 'number' },
          ],
        }),

        // Audit / revert log for every persona mutation.
        createTable({
          name: 'persona_change_log',
          columns: [
            { name: 'action_type', type: 'string' },
            { name: 'action_json', type: 'string' },
            { name: 'source', type: 'string' },
            { name: 'summary', type: 'string' },
            { name: 'reverted', type: 'boolean' },
            { name: 'created_at', type: 'number', isIndexed: true },
          ],
        }),

        // Seen-state (presentation/dedup only). TTL 30d.
        createTable({
          name: 'story_impressions',
          columns: [
            { name: 'article_id', type: 'string', isIndexed: true },
            { name: 'stable_cluster_id', type: 'string', isOptional: true, isIndexed: true },
            { name: 'suggestion_id', type: 'string', isOptional: true },
            { name: 'title_norm', type: 'string', isOptional: true },
            { name: 'surface', type: 'string' },
            { name: 'opened', type: 'boolean' },
            { name: 'first_seen_at', type: 'number', isIndexed: true },
            { name: 'last_seen_at', type: 'number' },
            { name: 'seen_count', type: 'number' },
          ],
        }),

        // Notification center. TTL 90d.
        createTable({
          name: 'notifications',
          columns: [
            { name: 'type', type: 'string' },
            { name: 'title', type: 'string' },
            { name: 'body', type: 'string' },
            { name: 'icon', type: 'string', isOptional: true },
            { name: 'context_json', type: 'string', isOptional: true },
            { name: 'actions_json', type: 'string', isOptional: true },
            { name: 'status', type: 'string', isIndexed: true },
            { name: 'source', type: 'string' },
            { name: 'created_at', type: 'number', isIndexed: true },
          ],
        }),

        // Additive fact-level weight multiplier (null ⇒ 1.0).
        addColumns({
          table: 'facts',
          columns: [{ name: 'weight', type: 'number', isOptional: true }],
        }),

        // Recreate the ephemeral article_suggestions (+ join) with the
        // persona-v3 scorer/audit columns. Data re-syncs from the server.
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestion_facts;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestions;'),
        createTable({
          name: 'article_suggestions',
          columns: [
            { name: 'article_id', type: 'string', isIndexed: true },
            { name: 'cluster_memberships_json', type: 'string', isOptional: true },
            { name: 'relevance', type: 'number' },
            { name: 'reason', type: 'string' },
            { name: 'status', type: 'string', isIndexed: true },
            { name: 'country_code', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'publication_name', type: 'string', isOptional: true },
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'title_original', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
            { name: 'article_url', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'matched_topic_texts_json', type: 'string', isOptional: true },
            { name: 'geo_tags_json', type: 'string', isOptional: true },
            { name: 'entities_json', type: 'string', isOptional: true },
            { name: 'event_type', type: 'string', isOptional: true },
            { name: 'category', type: 'string', isOptional: true },
            { name: 'max_cluster_size', type: 'number', isOptional: true },
            { name: 'stable_cluster_id', type: 'string', isOptional: true, isIndexed: true },
            { name: 'headline_scope', type: 'string', isOptional: true },
            { name: 'matched_topics_json', type: 'string', isOptional: true },
            { name: 'computed_score', type: 'number', isOptional: true },
            { name: 'raw_score', type: 'number', isOptional: true },
            { name: 'score_components_json', type: 'string', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'first_pub_date', type: 'number' },
          ],
        }),
        createTable({
          name: 'article_suggestion_facts',
          columns: [
            { name: 'article_suggestion_id', type: 'string', isIndexed: true },
            { name: 'fact_id', type: 'string', isIndexed: true },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      toVersion: 38,
      steps: [
        // ── Card-hierarchy / origin-aware feedback (app-rethink wave) ──────
        // Three additive, non-destructive parts. All tables touched here are
        // long-lived, user-owned state — NEVER wipe-and-recreate.

        // 1. Origin-aware feedback columns on article_feedback so a like/dislike
        //    knows where it came from (origin/surface) + carries a JSON context
        //    snapshot. Additive + optional — existing rows keep null.
        addColumns({
          table: 'article_feedback',
          columns: [
            { name: 'origin', type: 'string', isOptional: true },
            { name: 'surface', type: 'string', isOptional: true },
            { name: 'context_json', type: 'string', isOptional: true },
          ],
        }),

        // 2. Origin discriminator on saved_article_suggestions so a standalone
        //    NewsArticle (origin='article') can be saved alongside saved
        //    ForYouSuggestions (origin='suggestion'). Null ⇒ 'suggestion'. Every
        //    other card-renderable column already tolerates an article snapshot,
        //    so no further columns are needed.
        addColumns({
          table: 'saved_article_suggestions',
          columns: [{ name: 'origin', type: 'string', isOptional: true }],
        }),

        // 3. Natural-language persona summary strings. Long-lived, user-owned —
        //    created (never wiped). The generation pipeline lands in a later
        //    wave; this migration only stands up the table.
        createTable({
          name: 'persona_summary_strings',
          columns: [
            { name: 'text', type: 'string' },
            { name: 'linked_fact_ids_json', type: 'string' },
            { name: 'linked_topic_ids_json', type: 'string' },
            { name: 'generated_at', type: 'number' },
            { name: 'persona_version', type: 'string', isOptional: true },
            { name: 'stale', type: 'boolean', isOptional: true },
          ],
        }),
      ],
    },
    {
      // ── Stories wave (schema v39) ──────────────────────────────────
      // NOTE: this is the ONE shared v39 migration block for the stories wave.
      // Concurrent commits in this wave add their steps here rather than
      // minting a second v39. This commit contributes the tracked_stories
      // table only.
      toVersion: 39,
      steps: [
        // Tracked "followed stories". Long-lived, user-owned — created (never
        // wiped). The follow UI + reconcile poll land in later waves; this
        // migration only stands up the table + backing model/service.
        createTable({
          name: 'tracked_stories',
          columns: [
            { name: 'stable_cluster_id', type: 'string', isOptional: true, isIndexed: true },
            { name: 'member_article_ids_json', type: 'string' },
            { name: 'llm_headline', type: 'string', isOptional: true },
            { name: 'fallback_title', type: 'string' },
            { name: 'latest_article_id', type: 'string', isOptional: true },
            { name: 'latest_title', type: 'string', isOptional: true },
            { name: 'origin_surface', type: 'string', isOptional: true },
            { name: 'last_update_at', type: 'number', isOptional: true },
            { name: 'unseen_count', type: 'number' },
            { name: 'last_checked_at', type: 'number', isOptional: true },
            { name: 'miss_count', type: 'number' },
            { name: 'status', type: 'string' },
            { name: 'created_at', type: 'number' },
            { name: 'updated_at', type: 'number' },
          ],
        }),
      ],
    },
    {
      // ── Topic-linked tracked stories (schema v40) ──────────────────
      // A tracked story becomes a user-owned TOPIC (continuously linked
      // server-side each cycle). Additive columns on the long-lived,
      // user-owned `tracked_stories` table — migrate with addColumns, NEVER
      // wipe. `topic_id`/`topic_text` reference the minted `topics` row;
      // `member_snapshots_json` is a capped, newest-first array of lean card
      // snapshots so the timeline can render locally-discovered members.
      toVersion: 40,
      steps: [
        addColumns({
          table: 'tracked_stories',
          columns: [
            { name: 'topic_id', type: 'string', isOptional: true },
            { name: 'topic_text', type: 'string', isOptional: true },
            { name: 'member_snapshots_json', type: 'string', isOptional: true },
          ],
        }),
      ],
    },
    {
      // ── Per-fact pipeline: scored_at (schema v41) ──────────────────
      // Drop/recreate the EPHEMERAL article_suggestions (+ its join) with the
      // new `scored_at` column — the sanctioned pattern for this cache (see v37;
      // data re-syncs from the server's 24h window on the next feed sync). NEVER
      // apply this to any long-lived, user-owned table.
      toVersion: 41,
      steps: [
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestion_facts;'),
        unsafeExecuteSql('DROP TABLE IF EXISTS article_suggestions;'),
        createTable({
          name: 'article_suggestions',
          columns: [
            { name: 'article_id', type: 'string', isIndexed: true },
            { name: 'cluster_memberships_json', type: 'string', isOptional: true },
            { name: 'relevance', type: 'number' },
            { name: 'reason', type: 'string' },
            { name: 'status', type: 'string', isIndexed: true },
            { name: 'country_code', type: 'string', isOptional: true },
            { name: 'language_code', type: 'string', isOptional: true },
            { name: 'publication_name', type: 'string', isOptional: true },
            { name: 'title_en', type: 'string', isOptional: true },
            { name: 'title_original', type: 'string', isOptional: true },
            { name: 'description_en', type: 'string', isOptional: true },
            { name: 'article_url', type: 'string', isOptional: true },
            { name: 'image_url', type: 'string', isOptional: true },
            { name: 'matched_topic_texts_json', type: 'string', isOptional: true },
            { name: 'geo_tags_json', type: 'string', isOptional: true },
            { name: 'entities_json', type: 'string', isOptional: true },
            { name: 'event_type', type: 'string', isOptional: true },
            { name: 'category', type: 'string', isOptional: true },
            { name: 'max_cluster_size', type: 'number', isOptional: true },
            { name: 'stable_cluster_id', type: 'string', isOptional: true, isIndexed: true },
            { name: 'headline_scope', type: 'string', isOptional: true },
            { name: 'matched_topics_json', type: 'string', isOptional: true },
            { name: 'computed_score', type: 'number', isOptional: true },
            { name: 'raw_score', type: 'number', isOptional: true },
            { name: 'score_components_json', type: 'string', isOptional: true },
            { name: 'scored_at', type: 'number', isOptional: true },
            { name: 'created_at', type: 'number' },
            { name: 'first_pub_date', type: 'number' },
          ],
        }),
        createTable({
          name: 'article_suggestion_facts',
          columns: [
            { name: 'article_suggestion_id', type: 'string', isIndexed: true },
            { name: 'fact_id', type: 'string', isIndexed: true },
            { name: 'created_at', type: 'number' },
          ],
        }),
      ],
    },
  ],
});
