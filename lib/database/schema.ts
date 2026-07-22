import { appSchema, tableSchema } from '@nozbe/watermelondb';

export default appSchema({
  version: 44,
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
        // Persona v3 (schema v37): fact-level relevance multiplier. null ⇒
        // treated as 1.0 by the scoring engine. Additive; the silent persona
        // migration sets this to 1.0 for existing facts.
        { name: 'weight', type: 'number', isOptional: true },
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
        { name: 'tool_calls_json', type: 'string', isOptional: true },
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
      // `cluster_memberships_json` is the latest list of clusters this article
      // belongs to, each with its HDBSCAN membership confidence — a
      // JSON-encoded `{ clusterId: string; confidence: number }[]`, refreshed
      // every sync (overwritten unconditionally, including when empty). An
      // article can be in multiple clusters via the server's
      // `cluster-article-link` model. The For-You feed collapses suggestions
      // whose dense (high-confidence) cluster cores overlap into a single
      // representative card. May briefly be stale between aggregation passes —
      // accepted because grouping is presentational.
      columns: [
        { name: 'article_id', type: 'string', isIndexed: true },
        { name: 'cluster_memberships_json', type: 'string', isOptional: true },
        { name: 'relevance', type: 'number' },
        { name: 'reason', type: 'string' },
        // Pipeline state machine — see lib/database/article-suggestion-status.ts.
        // One of: unscored | reason_pending | complete.
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
        // ── Persona v3 (schema v37) scorer inputs + audit ──────────────
        // Populated by the persona-v3 hydration/scoring path (later waves);
        // nothing reads these yet. article_suggestions is ephemeral, so these
        // ride the drop/recreate. See lib/database/migrations.ts v37.
        { name: 'geo_tags_json', type: 'string', isOptional: true },
        { name: 'entities_json', type: 'string', isOptional: true },
        { name: 'event_type', type: 'string', isOptional: true },
        { name: 'category', type: 'string', isOptional: true },
        { name: 'max_cluster_size', type: 'number', isOptional: true },
        { name: 'stable_cluster_id', type: 'string', isOptional: true, isIndexed: true },
        { name: 'headline_scope', type: 'string', isOptional: true },
        { name: 'matched_topics_json', type: 'string', isOptional: true },
        // Deterministic engine raw score (pre-judge) — audit.
        { name: 'computed_score', type: 'number', isOptional: true },
        // Final post-judge raw score used for within-section ordering.
        { name: 'raw_score', type: 'number', isOptional: true },
        { name: 'score_components_json', type: 'string', isOptional: true },
        // Round-3 (schema v41): epoch ms the row was scored. Feeds the fact-rows
        // selector's newest-first ordering (scored_at ?? created_at).
        { name: 'scored_at', type: 'number', isOptional: true },
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

    // Device-local "save for later". User-owned, long-lived state (30-day TTL,
    // pruned by data-cleanup-task) — NOT wiped on the article_suggestions
    // resync. Every card-renderable field is snapshotted off the source
    // ForYouSuggestion at save time so the row renders fully even after the
    // ephemeral feed row is gone. WMDB row `id` == the source ArticleSuggestion
    // server `_id`. `saved_at` is indexed for the TTL range scan.
    tableSchema({
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
        // Origin discriminator (schema v38): 'suggestion' (default semantics —
        // a saved ForYouSuggestion) or 'article' (a standalone NewsArticle saved
        // from a non-personalized surface). Null on rows saved before v38 ⇒
        // treated as 'suggestion'. Every card-renderable column above already
        // tolerates a standalone article snapshot, so no extra columns are
        // needed for the 'article' origin.
        { name: 'origin', type: 'string', isOptional: true },
        { name: 'created_at', type: 'number' },
        { name: 'first_pub_date', type: 'number' },
        { name: 'saved_at', type: 'number', isIndexed: true },
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

    // Long-lived on-device log of article feedback (like/improve/dislike taps)
    // from the `ArticleFeedbackPrompt` widget. Idempotent per (article_id,
    // sentiment) — used to restore the "liked" button state on remount via
    // `hasLiked`. User-owned history — never wiped on article_suggestions
    // resync. See `article-feedback-service.ts`.
    tableSchema({
      name: 'article_feedback',
      columns: [
        { name: 'article_id', type: 'string', isIndexed: true },
        { name: 'suggestion_id', type: 'string', isOptional: true },
        { name: 'sentiment', type: 'string' },
        { name: 'title', type: 'string' },
        // ── Origin-aware feedback (schema v38) ──────────────────────────
        // Where the feedback came from so a later wave can weight it: `origin`
        // = 'suggestion' | 'article', `surface` = the on-screen surface
        // (for_you | explore | triage | detail | saved | …), `context_json` =
        // a JSON snapshot of the FeedbackSubject extras (scopeKey,
        // stableClusterId, eventType, relevance, matchedTopics). All optional —
        // rows written by the legacy ArticleFeedbackPrompt leave them null.
        { name: 'origin', type: 'string', isOptional: true },
        { name: 'surface', type: 'string', isOptional: true },
        { name: 'context_json', type: 'string', isOptional: true },
        // ── Feed-verdict processing (schema v42) ────────────────────────
        // Epoch ms when this like/dislike was folded into the persona (by the
        // Mera-chat handoff applying its proposals). Null ⇒ unprocessed — the
        // later daily-plan wave claims null rows. Feed taps never mutate the
        // persona directly; this is the deferred-processing marker.
        { name: 'processed_at', type: 'number', isOptional: true },
        { name: 'created_at', type: 'number' },
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

    // ── Persona v3 (schema v37) — structured on-device persona ─────
    // Long-lived, user-owned tables. Populated by the silent persona
    // migration; the feed still runs on `fact.metadata.topics` until a
    // later wave cuts over. Never wipe-and-recreate.

    // The weighted granular topic — replaces `fact.metadata.topics` strings.
    tableSchema({
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

    // Role-tagged place entities. Never sent in retrieval (privacy-lean).
    tableSchema({
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

    // Preferred / blocked publications. Weights written explicitly only.
    tableSchema({
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
    tableSchema({
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

    // Audit / revert log for EVERY persona mutation.
    tableSchema({
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

    // Seen-state tracking (presentation/dedup only — never mutates persona
    // weights). One row per article_id; TTL 30d, pruned by data-cleanup-task.
    tableSchema({
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

    // Notification center — one surface for all app-side notifications.
    // TTL 90d, pruned by data-cleanup-task.
    tableSchema({
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

    // ── Persona v3 — natural-language persona summary strings (schema v38) ──
    // Human-readable one-liners derived from the structured persona (facts +
    // topics), each linked back to the facts/topics that produced it. Long-lived,
    // user-owned — created via createTable, never wipe-and-recreate. A later wave
    // builds the generation pipeline; this wave only creates the table + model.
    tableSchema({
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

    // ── Tracked Stories (schema v39) ──────────────────────────────────
    // User-owned "follow this story" state. One row per followed story, keyed
    // (once resolved) to a server stable_cluster_id so the reconcile poll can
    // find new member articles for it. Long-lived — migrate, NEVER wipe.
    // `member_article_ids_json` is a JSON string[] of the article ids in the
    // story, newest-first, capped at 30. `llm_headline` is the generated
    // English one-liner (rendered via TranslatableDynamic); `fallback_title`
    // is the title captured at track time and always renders until a headline
    // exists. `unseen_count`/`last_update_at` drive the "new updates" badge and
    // ordering; `miss_count`/`last_checked_at` drive auto-end after a run of
    // reconcile polls find nothing new. `status` is 'active' | 'ended'.
    tableSchema({
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
        // ── Topic-linked tracking (schema v40) ─────────────────────────
        // A tracked story is a user-owned TOPIC continuously linked server-side
        // every pipeline cycle. `topic_id`/`topic_text` point at the minted
        // `topics` row; the reconcile matches suggestions whose matchedTopics
        // carry `topic_id`. `member_snapshots_json` is a capped (50), newest-
        // first-by-pubDate JSON array of lean card snapshots
        // [{articleId, title, pubDateMs, imageUrl?, publicationName?}] so the
        // timeline renders locally-discovered members without a server round
        // trip. All optional — legacy (cluster-id) rows leave them null.
        { name: 'topic_id', type: 'string', isOptional: true },
        { name: 'topic_text', type: 'string', isOptional: true },
        { name: 'member_snapshots_json', type: 'string', isOptional: true },
        // ── Watermark-gated "new" badge (schema v44) ───────────────────
        // Epoch ms of the newest member pubDate the user has SEEN (stamped
        // when the timeline screen finishes a successful load). The reconcile
        // then counts only members published strictly after this toward
        // `unseen_count`, so backfilled OLD articles no longer inflate the
        // "N new" badge. Null ⇒ never opened ⇒ fall back to legacy count.
        { name: 'seen_pub_watermark_ms', type: 'number', isOptional: true },
        { name: 'created_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
  ],
});
