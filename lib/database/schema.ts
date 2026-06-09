import { appSchema, tableSchema } from '@nozbe/watermelondb';

export default appSchema({
  version: 31,
  tables: [
    // ── On-Device Domain ──────────────────────────────────────────

    tableSchema({
      name: 'facts',
      columns: [
        { name: 'statement', type: 'string' },
        { name: 'metadata_json', type: 'string', isOptional: true },
        { name: 'questionnaire_level', type: 'number', isOptional: true },
        { name: 'questionnaire_level_category', type: 'string', isOptional: true },
        { name: 'questionnaire_attribute', type: 'string', isOptional: true },
        { name: 'created_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),

    tableSchema({
      name: 'conversations',
      columns: [
        { name: 'surface', type: 'string' },
        { name: 'created_at', type: 'number' },
      ],
    }),

    tableSchema({
      name: 'messages',
      columns: [
        { name: 'conversation_id', type: 'string', isIndexed: true },
        { name: 'role', type: 'string' },
        { name: 'content', type: 'string' },
        { name: 'suggested_options_json', type: 'string', isOptional: true },
        { name: 'created_at', type: 'number' },
      ],
    }),

    // ── Suggestion Feed ───────────────────────────────────────────

    tableSchema({
      name: 'article_suggestions',
      // The WatermelonDB row `id` IS the MongoDB server `_id` of the server-side
      // ArticleSuggestion — seeded at prepareCreate time via `_raw.id = a._id`.
      // No separate server_id column.
      //
      // `cluster_ids_json` is the latest list of clusters this article
      // belongs to (a JSON-encoded `string[]`), refreshed every sync
      // (overwritten unconditionally, including when empty). An article can
      // be in multiple clusters via the server's `cluster-article-link`
      // model. The For-You feed groups suggestions whose cluster sets
      // overlap into a stacked-cards component. May briefly be stale
      // between aggregation passes — accepted because grouping is
      // presentational.
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

    tableSchema({
      name: 'article_suggestion_facts',
      columns: [
        { name: 'article_suggestion_id', type: 'string', isIndexed: true },
        { name: 'fact_id', type: 'string', isIndexed: true },
        { name: 'created_at', type: 'number' },
      ],
    }),

    // The set of article_suggestion server `_id`s the server has handed us in
    // the user's 24h window. Decoupled from `article_suggestions` so we can
    // remember "the server still owes us data for this id" even if its
    // hydrated row gets discarded post-scoring (relevance ≤ 0.3) or never
    // ── User / Persona ────────────────────────────────────────────

    tableSchema({
      name: 'user_personas',
      columns: [
        { name: 'server_id', type: 'string', isIndexed: true },
        { name: 'user_id', type: 'string', isIndexed: true },
        { name: 'processing_mode', type: 'string' },
        { name: 'onboarding_stage', type: 'string' },
        { name: 'blocked_by_llm', type: 'boolean' },
        { name: 'blocked_by_llm_reason', type: 'string', isOptional: true },
        { name: 'llm_warning_count', type: 'number' },
        { name: 'notifications_enabled', type: 'boolean' },
        { name: 'preferred_notification_window_json', type: 'string' },
        { name: 'country_codes_json', type: 'string', isOptional: true },
        { name: 'language_codes_json', type: 'string', isOptional: true },
        { name: 'created_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),

    // ── App State ─────────────────────────────────────────────────

    tableSchema({
      name: 'settings',
      columns: [
        { name: 'key', type: 'string', isIndexed: true },
        { name: 'value', type: 'string' },
      ],
    }),

    // Long-lived on-device log of every "Read Article" tap. Aggregated to
    // surface the user's most-visited publications (Sources tab card +
    // drill-down) and per-publication visit counts (detail-screen badge).
    // Composite key (publication_name, country_code) — see
    // `publication-visit-service.ts`. One row per click; never wiped on
    // article_suggestions resync.
    tableSchema({
      name: 'publication_visits',
      columns: [
        { name: 'publication_name', type: 'string', isIndexed: true },
        { name: 'country_code', type: 'string', isOptional: true, isIndexed: true },
        { name: 'article_id', type: 'string', isOptional: true },
        { name: 'article_suggestion_id', type: 'string', isOptional: true },
        { name: 'article_url', type: 'string', isOptional: true },
        // Snapshotted at visit time so the per-publication history screen
        // can render a CompactPublisherNewsCard even after the source
        // article_suggestion row has been pruned by the 24h TTL.
        { name: 'title_en', type: 'string', isOptional: true },
        { name: 'title_original', type: 'string', isOptional: true },
        { name: 'language_code', type: 'string', isOptional: true },
        { name: 'image_url', type: 'string', isOptional: true },
        { name: 'pub_date', type: 'number', isOptional: true },
        { name: 'visited_at', type: 'number', isIndexed: true },
      ],
    }),

    tableSchema({
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

    tableSchema({
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
});
