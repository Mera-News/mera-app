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
  ],
});
