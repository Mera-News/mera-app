// news-harness — canonical shared types for the AI-flow system.
//
// This is the single home for the types that used to live scattered across
// lib/llm/types.ts, lib/llm/cloudComplete.ts, the article-suggestion service,
// and the scoring service. Old sites now re-export from here so no importer
// changes.

import type { Fact } from '@/lib/mera-protocol-toolkit/types';
export type { Fact };

// ---------------------------------------------------------------------------
// Batch completion primitives (moved from lib/llm/types.ts + cloudComplete.ts)
// ---------------------------------------------------------------------------

/** One entry in a batched LLM completion request. */
export interface BatchCall {
  id: string;
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  enableThinking?: boolean;
}

/** OpenAI JSON-Schema tool definition (sent to the cloud backend). */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** One decoded result of a batched completion. */
export interface BatchCompletionResult {
  id: string;
  output: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Scoring pipeline types (moved from article-suggestion-service + scoring-service)
// ---------------------------------------------------------------------------

/** The persona-v3 scorer-input metadata columns of an article_suggestion row,
 *  as raw (still-JSON) strings. Plain/self-contained — buildStageCandidateInput
 *  (in the RN service) parses these into a ScoredCandidateInput. Populated by
 *  the persona-v3 hydration path; absent/null on old rows → backstop routing. */
export interface StageCandidateRow {
  id: string;
  titleEn: string | null;
  descriptionEn: string | null;
  publicationName: string | null;
  countryCode: string | null;
  firstPubDateMs: number | null;
  maxClusterSize: number | null;
  eventType: string | null;
  category: string | null;
  geoTagsJson: string | null;
  entitiesJson: string | null;
  /** [{ topicId, text, vectorScore? }] — inverted per-topic matchMeta. */
  matchedTopicsJson: string | null;
  /** null | 'CITY' | 'COUNTRY' | 'GLOBAL'. */
  headlineScope: string | null;
  stableClusterId: string | null;
}

/** A single article_suggestion joined with its linked facts — the input to
 *  relevance scoring. WMDB row id == server `_id`. */
export interface ScoringCandidate {
  id: string; // WMDB row id == server `_id` of ArticleSuggestion
  titleEn: string | null;
  descriptionEn: string | null;
  countryCode: string | null;
  userTopicIds: string[];
  relatedFacts: { id: string; statement: string }[];
  /** Already-persisted relevance. Populated only by the reason-retry query
   *  (where the row was scored previously but the reason came back empty);
   *  omitted for the unscored-candidates query. */
  relevance?: number;
  /** Persona-v3 scorer-input metadata (raw JSON columns). Attached by
   *  getUnscoredSuggestionsWithFacts / getScoredSuggestionsWithoutReasons so the
   *  orchestrators can build a StageCandidate.input via buildStageCandidateInput.
   *  Absent on rows that predate the persona-v3 path. */
  meta?: StageCandidateRow;
}

/** Output of a single scoring pass for one candidate. */
export interface ScoringResult {
  relevance: number;
  reason: string | null;
}

/** A bundle of BatchCalls plus the lookups needed to decode their results
 *  back into per-candidate maps. */
export interface CloudCallBundle {
  calls: BatchCall[];
  promptsById: Map<string, string>;
  chunkIdToCandidates: Map<string, ScoringCandidate[]>;
  /** Candidates that passed eligibility — the source of truth for candidateIds
   *  when persisting a pending async job. */
  eligibleCandidates: ScoringCandidate[];
}

/** Per-candidate maps decoded from a BatchCompletionResult[]. */
export interface DecodedResults {
  scoreMap: Map<string, number>;
  reasonMap: Map<string, string>;
  failedIds: Set<string>;
}

// ---------------------------------------------------------------------------
// News API shape — mirrors the `articlesForTopicsByIds` GraphQL selection set
// (ArticleWithClusters in lib/generated/graphql-types.ts).
// ---------------------------------------------------------------------------

export interface HarnessArticle {
  _id: string;
  title_en: string;
  title?: string | null;
  description_en?: string | null;
  article_url?: string | null;
  image_url?: string | null;
  country_code?: string | null;
  publication_name?: string | null;
  language_code?: string | null;
  pubDate: string;
  clusters: { clusterId: string; confidence: number; stableClusterId?: string | null }[];
}

// ---------------------------------------------------------------------------
// Agent proposal types (moved from lib/llm/types.ts — the article-feedback
// agent's portable brain lives in the harness as of Phase 3A). lib/llm/types.ts
// re-exports these so no importer changes.
// ---------------------------------------------------------------------------

/** A single deterministic change the proposal executor can apply to the persona.
 *
 *  The first group is the legacy fact/topic-CRUD set (applied directly against
 *  fact-service). The second group is the Wave-9 rails-backed set — routed
 *  through `applyPersonaAction` so each mints an invertible persona_change_log
 *  row. These reference topics by TEXT and publications by NAME (the feedback
 *  context only exposes those, never ids); the RN executor resolves text→id. */
export type ProposalAction =
  // -- Legacy fact/topic CRUD (applied directly against fact-service) --
  | { type: 'add_fact'; statement: string }
  // -- Follow-a-story (the article-feedback agent's `proposeTrack` tool) --
  /** Follow the tapped article's unfolding story as a durable topic. `trackText`
   *  is the accepted one-sentence topic; `subject` is the self-contained origin
   *  snapshot the executor hands to trackStoryWithProposal (embedded so the
   *  confirm is reconstructable from the persisted tool call, with no store read). */
  | { type: 'track_story'; trackText: string; subject: TrackFeedbackSubject }
  | { type: 'update_fact'; fact_id: string; new_statement: string }
  | { type: 'delete_fact'; fact_id: string }
  | { type: 'add_topics'; fact_id: string; topics: string[] }
  | { type: 'remove_topics'; fact_id: string; topics: string[] }
  | { type: 'submit_feature_request'; title: string; summary: string }
  // -- Wave-9 rails-backed persona mutations (via applyPersonaAction) --
  /** Nudge a matched topic's weight (negative delta = "show me less"). */
  | { type: 'set_topic_weight'; topicText: string; delta: number }
  /** Mint a down-ranking negative topic ("wrong place / wrong angle"). */
  | { type: 'add_negative_topic'; topicText: string; weight?: number }
  /** Boost / deprioritize / mute a named publication. */
  | { type: 'set_publication_pref'; publicationId: string; publicationPref: 'boost' | 'deprioritize' | 'mute' }
  /** Add a soft/hard suppression rule (a phrase to filter out). */
  | { type: 'add_suppression'; suppressionPattern: string; suppressionKeywords?: string[]; suppressionStrength?: number }
  /** Pin / unpin a matched topic as high-priority. */
  | { type: 'set_high_priority'; topicText: string; highPriority: boolean }
  /** Retire a matched topic entirely — stronger than a weight nudge ("I'm done
   *  with this topic"). Resolved text→id in the RN executor, then routed through
   *  ACTION_NAMES.RETIRE_TOPIC. */
  | { type: 'retire_topic'; topicText: string };

/** Serializable origin snapshot for a `track_story` action — the minimal subset
 *  of the RN `FeedbackSubject` that trackStoryWithProposal needs. Kept here (not
 *  imported from components/) so the harness stays RN-free; structurally
 *  assignable from a full FeedbackSubject. */
export interface TrackFeedbackSubject {
  origin: 'suggestion' | 'article';
  surface: string;
  articleId: string;
  title: string;
  /** The article's real publication date (ISO string), when known. Threaded so
   *  the tracked-story seed snapshot stamps the true pubDate instead of `now`
   *  (Part E timeline fix). */
  pubDate?: string | null;
  stableClusterId?: string | null;
  publicationName?: string | null;
}

/** A proposal staged by the LLM and awaiting user confirmation. */
export interface StagedProposal {
  id: string;              // tool-call id / nonce
  explanation: string;     // why (≤2 sentences, enforced by prompt)
  expectedEffects: string; // "you'll see fewer X…"
  actions: ProposalAction[];
  /** When true the `actions` are mutually-exclusive alternatives: the card
   *  renders single-select radio rows and Confirm applies EXACTLY ONE chosen
   *  action (via executeProposalActions([chosen])). Undefined/false = the legacy
   *  behaviour where Confirm applies every action. */
  chooseOne?: boolean;
}

/** Result of an agent tool execution — a plain result map plus optional
 *  side effects the chat hook interprets (block, stage a proposal, resolve one). */
export interface ToolExecutionResult {
  result: Record<string, unknown>;
  sideEffects?: {
    /** If set, the chat should be blocked and no further messages accepted. */
    blocked?: { reason: string };
    /** If set, a proposal was staged and should render as a confirm card. */
    proposal?: StagedProposal;
    /** If set, the pending proposal was applied or cancelled. */
    proposalResolved?: 'applied' | 'cancelled';
  };
}

// ---------------------------------------------------------------------------
// Article-feedback context types — the plain inputs buildFeedbackContext is
// re-signed over (no store/DB/RN dependency).
// ---------------------------------------------------------------------------

/** Plain suggestion snapshot the feedback context is built from. Mirrors the
 *  fields the agent reads off the WatermelonDB `ForYouSuggestion` row. */
export interface FeedbackSuggestion {
  title_en?: string | null;
  title_original?: string | null;
  publication_name?: string | null;
  description_en?: string | null;
  /** true iff the suggestion status is Complete (scored) — the RN layer maps
   *  ArticleSuggestionStatus.Complete to this so the harness stays enum-free. */
  isScored: boolean;
  relevance: number;
  reason?: string | null;
}

/** A suggestion joined with its matched topics and producing facts — the
 *  article-feedback equivalent of getSuggestionFeedbackContext's return. */
export interface SuggestionFeedbackContext {
  suggestion: FeedbackSuggestion;
  matchedTopicTexts: string[];
  linkedFacts: { id: string; statement: string }[];
  /** Named entities the article mentions (≤8) — surfaces an entity-suppression
   *  alternative in the "less of this" choose-one card. */
  entities?: string[];
  /** The article's controlled category, when known — surfaces a broader
   *  category-suppression alternative. */
  category?: string | null;
}

/** Plain inputs to buildFeedbackContext — everything the agent has already
 *  read from the DB / stores. */
export interface FeedbackContextInput {
  /** All persona facts, newest-first. */
  facts: Fact[];
  /** The joined suggestion feedback context, or null when the article was NOT
   *  one of the user's personalized suggestions. */
  context: SuggestionFeedbackContext | null;
  /** Store-provided title used when the row is missing/untitled. */
  fallbackTitle?: string;
  /** The single in-flight staged proposal, or null. */
  proposal: StagedProposal | null;
  /** True when this article's story is already being followed — lets the agent
   *  say so instead of proposing a duplicate track. Undefined = unknown/N-A. */
  isTracked?: boolean;
  /** Up to 5 sibling-cluster article titles (from the tapped article's live
   *  cluster). Renders a `## RELATED COVERAGE` block that grounds the LLM's
   *  multi-option track proposals. Absent/empty when unavailable. */
  relatedCoverage?: string[];
}
