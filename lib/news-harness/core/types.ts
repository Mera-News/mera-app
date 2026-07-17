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

/** A single deterministic change the proposal executor can apply to the persona. */
export type ProposalAction =
  | { type: 'add_fact'; statement: string }
  | { type: 'update_fact'; fact_id: string; new_statement: string }
  | { type: 'delete_fact'; fact_id: string }
  | { type: 'add_topics'; fact_id: string; topics: string[] }
  | { type: 'remove_topics'; fact_id: string; topics: string[] }
  | { type: 'submit_feature_request'; title: string; summary: string };

/** A proposal staged by the LLM and awaiting user confirmation. */
export interface StagedProposal {
  id: string;              // tool-call id / nonce
  explanation: string;     // why (≤2 sentences, enforced by prompt)
  expectedEffects: string; // "you'll see fewer X…"
  actions: ProposalAction[];
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
}
