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
  /** Uppercase ISO code of the country whose headline scope retrieved this row.
   *  Only set alongside headlineScope === 'COUNTRY'. Optional so the minimal
   *  stage row built for pre-v48 candidates stays valid. */
  headlineCountryCode?: string | null;
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
  /** Relevance bundles only: the chunk size `score:N` was actually built with
   *  (standard vs TOP-HEADLINE variant). The async decoder rebuilds the
   *  `score:N` → candidates join from a flat id list, so it MUST chunk with the
   *  same size the submit used — persisting this value (rather than
   *  re-deriving it) is what makes the two incapable of disagreeing. Absent on
   *  reason/judge bundles, which have no score chunks. */
  scoreChunkSize?: number;
  /**
   * REASON bundles only: ids the article-tag reason gate removed from the
   * subset (`articlePipeline.legacyTagReasonGateEnabled`). Empty when the flag
   * is off, which is the shipped default.
   *
   * THE CALLER MUST PERSIST `feedVerifierDemoteScore` FOR THESE, and mark them
   * reason-skipped. Skipping a row's reason call is only sound BECAUSE the row
   * is simultaneously demoted out of the feed: this path's reason threshold
   * equals its render gate, so a skipped-but-not-demoted row renders with no
   * note forever and never leaves `reason_pending`. Carried on the bundle
   * rather than written in the builder to keep the harness pure, exactly as
   * `decodeV3NoteResults` returns `demoteIds` for `applyV3NoteResults` to write.
   */
  tagGatedDemoteIds?: string[];
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

/**
 * What a "not interested" filter matches against. RUNTIME mirror of
 * `SUPPRESSION_KINDS` in `lib/database/models/PersonaSuppression` (duplicated so
 * the harness stays RN-free / DB-free), and of the type-only mirror
 * `SuppressionKind` in `lib/news-harness/scoring-engine/persona-context.ts`.
 * ORDER IS LOAD-BEARING — the agent tool schemas expose this array verbatim as a
 * JSON-Schema `enum` and their tests assert it with an order-sensitive toEqual.
 *
 * `keyword` matches as a normalized SUBSTRING over title + description +
 * entities. Every other kind is an EXACT normalized equality test against one
 * article field (category / eventType / entities[] / publicationName / geoTags /
 * matched topic text) — so an invented value silently never fires. An absent
 * kind reads as `keyword`.
 */
export const SUPPRESSION_KINDS = [
  'keyword',
  'category',
  'event_type',
  'entity',
  'publication',
  'place',
  'topic',
] as const;

export type SuppressionKindName = (typeof SUPPRESSION_KINDS)[number];

/** One ACTIVE "not interested" filter as the chat agents see it — the minimal
 *  plain projection of a `persona_suppressions` row (no WatermelonDB model).
 *  Rendered into <context> so the agent can offer to REMOVE one, and used to
 *  validate a `retire_suppression` proposal's `suppressionId`. */
export interface ActiveSuppressionView {
  /** The `persona_suppressions` row id — the only handle retire_suppression takes. */
  id: string;
  /** Human-readable original phrase (display only, never matched against). */
  pattern: string;
  /** Absent/null ⇒ 'keyword'. */
  kind?: SuppressionKindName | null;
  /** The token the non-keyword kinds compare against. */
  value?: string | null;
  /** [0,1]. ≥ HARD_SUPPRESSION_STRENGTH (0.8) ⇒ a genuine exclusion. */
  strength?: number;
}

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
  /** Follow the tapped article's unfolding story as a durable topic. A scope
   *  pill: `label` is the short display name shown to the user (e.g. "Russia–
   *  Ukraine war"); `searchText` is the hidden retrieval query minted as the
   *  tracked topic (e.g. "russia ukraine civilian infrastructure attacks").
   *  `subject` is the self-contained origin snapshot the executor hands to
   *  trackStoryWithProposal (embedded so the confirm is reconstructable from the
   *  persisted tool call, with no store read). */
  | { type: 'track_story'; label: string; searchText: string; subject: TrackFeedbackSubject }
  // -- Fact-check a claim (the fact-check agent's `proposeFactCheck` tool) --
  /** Fact-check ONE claim drawn from an article, or (`mode: 'article'`) the
   *  whole article. A claim pill: `label` is the short pill text shown to the
   *  user ("80 vaccines by age 18"); `claim` is the self-contained sentence that
   *  gets searched, and it is the thing the runner keys on — never the label.
   *  `subject` is the article snapshot the executor forwards (embedded so the
   *  confirm is reconstructable from the persisted tool call, with no store read).
   *
   *  TWO SPEEDS BEHIND ONE CARD:
   *   - `mode` absent / `'claim'` — the QUICK path. Brave-only web search plus a
   *     low-temperature synthesis, answered in the chat thread and never written
   *     to the `fact_checks` table.
   *   - `mode: 'article'` — the LAST pill, always present: hand the whole article
   *     to the SERVER-side check, which is the only path that may attribute a
   *     rating to a fact-checking organisation (ClaimReview). `claim` is empty
   *     here; the article is the subject.
   *
   *  UI-CONFIRMED ONLY (`USER_CONFIRMED_ONLY_ACTIONS`): a check spends a search
   *  round-trip plus a thinking synthesis, so no model-driven path may start one
   *  — and on a multi-claim card an agent-side apply would start every one of
   *  them from a single typed "yes". */
  | {
      type: 'fact_check_claim';
      label: string;
      claim: string;
      subject: FactCheckSubject;
      mode?: 'claim' | 'article';
    }
  // -- Scoring recalibration (M-P5c) — UI-CONFIRMED ONLY --
  /** Re-tune the on-device scoring constants from the retained override sample.
   *
   *  Staged, never called directly. MEASURED 2026-08-03 against the real
   *  gateway: with the invitation in history the model called the old execute-
   *  immediately `runCalibration` tool on a bare "thanks!" 20/20 times, and an
   *  explicit "this is the ONLY action a confirmation may trigger" prompt block
   *  did NOT change that (also 20/20). Prompt wording is therefore not a
   *  consent gate, so consent moved to the UI: this action executes only when
   *  the user taps Confirm on the ProposalCard. The agent's `applyProposal`
   *  tool deliberately REFUSES to apply it, so no phrasing can execute it. */
  | { type: 'run_calibration' }
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
  /** source-pref v47 (D2/D6). Boost / deprioritize a whole SOURCE SCOPE
   *  ("prefer Indian sources") — stored as ONE preference row carrying a live
   *  predicate, never expanded into a row per matching outlet.
   *
   *  `scopeKind` is inlined as the `'country'` literal rather than imported
   *  from lib/database/models/PublicationPreference (`SourceScopeKind`) because
   *  the harness is RN/DB-free; the two are kept structurally identical by the
   *  RN executor, which assigns this straight into `SourceScopeRef`.
   *
   *  `scopeValue` is ALREADY RESOLVED to the render-time token (ISO alpha-3) by
   *  the sanitizer — the model only ever emits an English country name, and an
   *  unresolvable one drops the action rather than minting a row that can never
   *  fire. `label` is the human display name stored in `publication_name`.
   *
   *  No `'mute'`: a scope mute is not synthesized into a hard filter anywhere
   *  (Phase 1 deliberately excludes scope rows from the muted-publication
   *  hard-filter derivation in lib/mera-protocol/stage-scoring.ts), so offering
   *  it would promise an exclusion nothing implements. Rejected in both the
   *  sanitizer and the executor. */
  | {
      type: 'set_source_scope_pref';
      scopeKind: 'country';
      scopeValue: string;
      label: string;
      publicationPref: 'boost' | 'deprioritize';
    }
  /** Add a soft/hard suppression rule (a "not interested" filter).
   *  `suppressionKind` + `suppressionValue` make it STRUCTURED (exact match on
   *  one article field); absent ⇒ a keyword filter over `suppressionPattern` /
   *  `suppressionKeywords`. The sanitizer downgrades a structured filter whose
   *  value the article context can't corroborate back to a keyword one (D9). */
  | {
      type: 'add_suppression';
      suppressionPattern: string;
      suppressionKeywords?: string[];
      suppressionStrength?: number;
      suppressionKind?: SuppressionKindName;
      suppressionValue?: string;
    }
  /** Remove an ACTIVE "not interested" filter (D5: an audited mutation, not a
   *  silent delete — routed through ACTION_NAMES.RETIRE_SUPPRESSION so it logs
   *  and inverts). `suppressionId` is a `persona_suppressions` row id the
   *  sanitizer resolved against the filters it put in <context>; `pattern` is
   *  the resolved display phrase (looked up from that same list, never taken
   *  from the model). */
  | { type: 'retire_suppression'; suppressionId: string; pattern: string }
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

/** Serializable article snapshot for a `fact_check_claim` action — the minimal
 *  subset the on-device fact-check runner needs, with field names that map 1:1
 *  onto `enqueueFactCheck`'s parameters so the executor forwards it unchanged.
 *
 *  Deliberately NOT reused from `TrackFeedbackSubject`: that one carries `title`
 *  where this carries `articleTitle`, and two structurally-similar shapes with
 *  different consumers would typecheck into a call with an empty title. */
export interface FactCheckSubject {
  /** Origin surface, for the persisted row's provenance ('fact-check-chat'). */
  surface: string;
  articleId: string;
  articleTitle: string;
  /** The article's canonical URL, when known. Carried for the runner's citation
   *  only — reading the article body is explicitly out of scope. */
  articleUrl?: string;
  publicationName?: string;
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
  /** Reference "now" (epoch ms), INJECTED by the caller — never read from the
   *  clock inside the builder, so the rendered context is a pure function of its
   *  inputs and the prompt goldens stay pinnable. Rendered as a `Today: <ISO>`
   *  line so proposeTrack can't propose a season/year that has already ended. */
  nowMs: number;
  /** The article's own publication date (ISO string), when the caller knows it
   *  (the follow-a-story path carries it on TrackFeedbackSubject.pubDate).
   *  Rendered as a `Published: <ISO>` line in the ARTICLE block — disambiguates
   *  a story read weeks after it broke. Absent/unparseable = line omitted. */
  articlePubDate?: string | null;
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
  /** The Feed-tab verdict the user gave on this article (Round-4 P4 handoff) —
   *  grounds the agent's proposals. Absent for chats opened outside the feed. */
  verdict?: 'like' | 'dislike';
  /** The user's ACTIVE "not interested" filters, newest-first. Rendered as an
   *  `## YOUR FILTERS` block (article-matching ones first, capped) so the agent
   *  can offer to REMOVE one, and used to validate a `retire_suppression`
   *  proposal. Absent/empty ⇒ the block is omitted and retire_suppression is
   *  rejected outright. */
  activeSuppressions?: ActiveSuppressionView[];
  /** The CLAIM PICKER is active on this turn (cloud only — see
   *  `buildArticleFeedbackSystemPrompt`'s `factCheck`). Widens the rendered
   *  article description to the length the 85%-separability measurement was
   *  established against; the local path is untouched. */
  factCheck?: boolean;
  /** Human-readable breadcrumb LABELS of the inline feedback-tree options the
   *  user tapped before opening chat (e.g. ["Not a good suggestion", "Wrong
   *  topic"]). Rendered as a `TAPPED OPTIONS` line. Absent/empty when none. */
  tappedOptions?: string[];
}
