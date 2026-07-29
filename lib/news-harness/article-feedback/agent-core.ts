// news-harness — the ArticleFeedbackAgent's portable brain.
//
// Pure, RN-free logic for the article-suggestion feedback chat surface: the
// system-prompt builder, the dynamic <context> assembler (re-signed over plain
// inputs), the OpenAI tool definitions, and the propose/confirm decision logic
// (validation → StagedProposal / ProposalAction construction).
//
// Everything that touches WatermelonDB, Zustand stores, the app logger, or any
// expo/react-native module stays in lib/llm/agents/ArticleFeedbackAgent.ts —
// that thin adapter reads the data and hands plain values to this module.

import { SUPPRESSION_KINDS } from '../core/types';
import type {
  ActiveSuppressionView,
  FeedbackContextInput,
  ProposalAction,
  StagedProposal,
  SuggestionFeedbackContext,
  SuppressionKindName,
  ToolDefinition,
  ToolExecutionResult,
  TrackFeedbackSubject,
} from '../core/types';

// --- Context caps (named so the budget is auditable) ---
const MAX_MATCHED_TOPICS = 10;
const MAX_PRODUCING_FACTS = 5;
const MAX_ALL_FACTS = 12; // newest-first — needed for "more of this" diagnosis
const ARTICLE_DESC_TRUNC = 160;
const FACT_STATEMENT_TRUNC = 120;
const TOPICS_PER_FACT_PREVIEW = 3;
const MAX_ARTICLE_ENTITIES = 8;
const MAX_RELATED_COVERAGE = 5;
const RELATED_COVERAGE_TITLE_TRUNC = 120;
/** Max ACTIVE filters rendered in `## YOUR FILTERS` — the ones matching THIS
 *  article come first, so the tail this drops is the least relevant. Smaller
 *  than the persona chat's cap because the article context already carries an
 *  ARTICLE + FACTS + COVERAGE payload. */
const MAX_ACTIVE_FILTERS = 8;
const SUPPRESSION_PATTERN_TRUNC = 60;
// Drop the (largest) ALL-FACTS block first if the assembled context exceeds
// this — keeps the local path's ~3072-token input budget comfortable.
const CONTEXT_TOKEN_BUDGET = 1800;

const VALID_ACTION_TYPES = new Set([
  // legacy fact/topic CRUD
  'add_fact',
  'update_fact',
  'delete_fact',
  'add_topics',
  'remove_topics',
  'submit_feature_request',
  // Wave-9 rails-backed persona mutations
  'set_topic_weight',
  'add_negative_topic',
  'set_publication_pref',
  'add_suppression',
  // not-interested P4a: removing a filter is a first-class chat action (D6).
  'retire_suppression',
  'set_high_priority',
  'retire_topic',
]);

/** Action enum shared by the JSON-Schema tool def and its test (single source). */
const PROPOSAL_ACTION_ENUM = [
  'add_fact',
  'update_fact',
  'delete_fact',
  'add_topics',
  'remove_topics',
  'submit_feature_request',
  'set_topic_weight',
  'add_negative_topic',
  'set_publication_pref',
  'add_suppression',
  'retire_suppression',
  'set_high_priority',
  'retire_topic',
] as const;

/**
 * The suppression kinds the ARTICLE context can corroborate a value against
 * (D9). `event_type` and `place` stay in the tool enum — the schema mirrors
 * SUPPRESSION_KINDS so a future context expansion just works — but the article
 * context exposes no eventType/geoTags field, so a value claimed for them can
 * never be checked and is downgraded to a keyword filter like any other
 * uncorroborated value.
 */
const CORROBORABLE_SUPPRESSION_KINDS: ReadonlySet<string> = new Set([
  'category',
  'entity',
  'publication',
  'topic',
]);

/** trim + lowercase — the same normalization the runtime matcher applies
 *  (scoring-engine/persona-context::normText). Inlined rather than imported so
 *  this module keeps its narrow import surface. */
function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

/** Publication-preference kinds the agent may set on a named publication. */
const VALID_PUBLICATION_PREFS = new Set(['boost', 'deprioritize', 'mute']);
/** Clamp bound for a topic-weight nudge delta — keeps "show less/more" gentle. */
const MAX_TOPIC_WEIGHT_DELTA = 0.5;

const FEATURE_REQUEST_TITLE_MAX = 80;
const FEATURE_REQUEST_SUMMARY_MAX = 500;

/** Target ceiling on a scope pill's display label (prompt guidance). */
const MAX_TRACK_LABEL_WORDS = 5;
/** Target ceiling on a scope pill's hidden search query (prompt guidance). */
const MAX_TRACK_SEARCH_WORDS = 8;
/** Hard cap on the display label / search text we stage (defensive trim). */
const MAX_TRACK_CHARS = 200;
/** Max distinct track-scope pills a single follow-a-story card offers. */
const MAX_TRACK_OPTIONS = 4;

/** One scope pill the follow-a-story flow offers: a shown display `label` + a
 *  hidden `search` retrieval query. The LLM emits 3–4 of these at widening
 *  scopes (narrow event → broad ongoing story); the user picks one by its
 *  label, and `search` is what gets minted as the tracked topic. */
export interface TrackScopeOption {
  label: string;
  search: string;
}

function trimTrack(s: string): string {
  const t = (s ?? '').trim();
  return t.length > MAX_TRACK_CHARS ? `${t.slice(0, MAX_TRACK_CHARS - 1)}…` : t;
}

/**
 * Parse the LLM's raw `proposeTrack` options into clean scope pills. Accepts the
 * structured shape (`[{ label, search }]`) and tolerates a legacy string option
 * (`"scope text"` → label === search). Drops entries missing a label, trims, and
 * dedupes by label (case-insensitive), capped at MAX_TRACK_OPTIONS. Shared by
 * the live path (decideProposeTrack) and the resume path (deriveThreadItems) so
 * both rebuild identical actions.
 */
export function parseTrackScopeOptions(raw: unknown): TrackScopeOption[] {
  if (!Array.isArray(raw)) return [];
  const out: TrackScopeOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let label = '';
    let search = '';
    if (typeof entry === 'string') {
      label = entry.trim();
      search = label;
    } else if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      label = typeof rec.label === 'string' ? rec.label.trim() : '';
      search = typeof rec.search === 'string' ? rec.search.trim() : '';
      // A label with no distinct search still tracks (search falls back to it).
      if (!search) search = label;
    }
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: trimTrack(label), search: trimTrack(search) });
    if (out.length >= MAX_TRACK_OPTIONS) break;
  }
  return out;
}

/**
 * Does this ACTIVE filter match the article the chat is about? Mirrors
 * `scoring-engine/suppression.ts::suppressionMatchesCandidate` for the fields
 * the feedback context actually exposes; kinds it cannot corroborate
 * (`event_type`, `place`) simply report false — this only decides DISPLAY ORDER
 * and the "matches this article" hint, never whether the filter fires.
 */
function suppressionMatchesArticle(
  s: ActiveSuppressionView,
  ctx: SuggestionFeedbackContext | null,
): boolean {
  if (!ctx) return false;
  const kind = s.kind ?? 'keyword';
  if (kind === 'keyword') {
    const haystack = [
      norm(ctx.suggestion.title_en ?? ctx.suggestion.title_original ?? ''),
      norm(ctx.suggestion.description_en ?? ''),
      ...(ctx.entities ?? []).map(norm),
    ].join('  ');
    const needle = norm(s.pattern);
    return needle.length > 0 && haystack.includes(needle);
  }
  const value = norm(s.value);
  if (value.length === 0) return false;
  switch (kind) {
    case 'category':
      return norm(ctx.category) === value;
    case 'entity':
      return (ctx.entities ?? []).some((e) => norm(e) === value);
    case 'publication':
      return norm(ctx.suggestion.publication_name) === value;
    case 'topic':
      return (ctx.matchedTopicTexts ?? []).some((t) => norm(t) === value);
    default:
      return false;
  }
}

/**
 * Orders the user's ACTIVE filters for <context>: the ones matching THIS
 * article first (they are what a "why am I not seeing…" / "unhide this" turn is
 * about), then the rest in caller order (newest-first), capped at
 * MAX_ACTIVE_FILTERS. Pure; exported for the token-budget test.
 */
export function selectActiveFiltersForContext(
  suppressions: ActiveSuppressionView[] | undefined,
  ctx: SuggestionFeedbackContext | null,
): { row: ActiveSuppressionView; matches: boolean }[] {
  const rows = (suppressions ?? []).filter((s) => s && typeof s.id === 'string' && s.id.length > 0);
  const decorated = rows.map((row) => ({ row, matches: suppressionMatchesArticle(row, ctx) }));
  return [
    ...decorated.filter((d) => d.matches),
    ...decorated.filter((d) => !d.matches),
  ].slice(0, MAX_ACTIVE_FILTERS);
}

function trunc(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Epoch-ms → `YYYY-MM-DD` (UTC). UTC (not locale) on purpose: the rendered
 * prompt must be a pure function of the injected clock, so goldens stay pinnable
 * regardless of the runner's timezone. Returns null for a non-finite input.
 */
function isoDay(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** ISO-ish date string → `YYYY-MM-DD` (UTC), or null when unparseable. */
function isoDayFromString(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  return isoDay(Date.parse(raw));
}

/**
 * Token estimator — mirrors lib/llm/tokens.ts::estimateTokens byte-for-byte.
 * Kept inline so the harness stays free of the lib/llm import graph (the budget
 * heuristic is stable; if lib/llm/tokens.ts changes, mirror it here).
 */
function estimateTokens(text: string): number {
  const cjkPattern = /[一-鿿㐀-䶿豈-﫿]/g;
  const cjkMatches = text.match(cjkPattern);
  const cjkCount = cjkMatches?.length ?? 0;
  const nonCjkCount = text.length - cjkCount;
  return Math.ceil(cjkCount / 1.2) + Math.ceil(nonCjkCount / 4);
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildArticleFeedbackSystemPrompt(params: {
  needsToolFormat: boolean;
  languageName?: string;
}): string {
  const { needsToolFormat, languageName } = params;

  const languageRule = languageName
    ? `LANGUAGE: ALWAYS write conversational text in **${languageName}**, with no exceptions — even if the user writes in another language. Fact statements stay English.`
    : 'LANGUAGE: Match the user\'s language (switch if they switch). Fact statements stay English.';

  const toolSection = needsToolFormat ? buildArticleFeedbackToolFormat() : '';

  return `You are Mera, helping the user understand and shape their personalized news feed.

## How Mera works
- The user tells Mera facts about themselves (job, location, family, interests).
- Each fact generates interest TOPICS.
- Topics semantically search incoming news — matching articles become suggestions.
- An on-device model scores each candidate 0–10 for relevance and writes a short reason note.

## Your role
- Explain WHY this article was suggested, using ARTICLE, MATCHED TOPICS, and the FACTS in <context>.
- Handle feedback: "more like this" (strengthen the matching facts/topics) and "less like this" (weaken or remove them).

## Article access (by design)
- You see ONLY limited metadata: title, publication, and a short description — NEVER the full article text.
- Help with news questions as best you can from that, but when the user probes for detail beyond it, say plainly you don't have the full article and recommend reading it — the human-written article is the source of truth. AI summaries can distort information (bias, hallucination, lost nuance).

## Capabilities — what proposeChanges can do
Persona edits (reference facts by the [id] in <context>):
- add_fact / update_fact / delete_fact — the user's facts.
- add_topics / remove_topics — interest topics on a fact.
Feed-tuning actions (reference topics by their TEXT from MATCHED TOPICS, publications by NAME):
- set_topic_weight — "show me less/more of <topic>": nudge a MATCHED topic's weight by a small delta (negative to see less, positive to see more; keep |delta| ≤ 0.5).
- add_negative_topic — this article is the wrong topic/place/angle: mint a down-ranking negative topic (topicText, e.g. "Delhi crime").
- set_publication_pref — boost / deprioritize / mute a NAMED publication (publicationId = the publication name, publicationPref = boost|deprioritize|mute). Use mute only for a clear "stop showing me <source>".
- add_suppression — filter something out (suppressionPattern = the phrase; suppressionStrength 0.9 = never show it, 0.5 = just less of it). For an EXACT filter also send suppressionKind + suppressionValue, and COPY THE VALUE VERBATIM from <context>: category ← Category, entity ← Entities, publication ← Publication, topic ← MATCHED TOPICS. A value you paraphrase or invent matches NOTHING. So: with "Category: Entertainment" → {"suppressionKind":"category","suppressionValue":"Entertainment"}; your own words "celebrity stuff" → {"suppressionPattern":"celebrity"} with NO kind/value.
- retire_suppression — the user wants an existing filter GONE ("stop hiding X", "show me X again"): suppressionId = an [id] from YOUR FILTERS in <context>. Never invent an id; if it isn't listed, say you can't find that filter.
- set_high_priority — pin a MATCHED topic the user cares strongly about (highPriority true), or unpin (false).
- retire_topic — the user is DONE with a MATCHED topic entirely (stronger than a small set_topic_weight nudge): retire it so it stops matching (topicText).
- submit_feature_request — Mera CANNOT change app settings, hide a single article, or change scoring thresholds; use this ONLY for capabilities none of the above cover. title = short feature name (NO prefix); summary = 2–4 English sentences, NO personal info (no names/emails/locations/facts). Explanation: "I'll send this suggestion to the Mera team."; expected_effects: "The team will consider it — this won't change your feed today."

## Following a story (the proposeTrack tool)
When the user wants to FOLLOW / TRACK this unfolding story, call proposeTrack with 3–4 scope OPTIONS at widening scope — from the narrow specific event to the broad ongoing story — so the user can pick how much they want to follow. Read the ARTICLE and the RELATED COVERAGE titles to judge the real span of the story; base the options on what that coverage actually spans, not just this one article.
Each option has TWO fields:
- "label": the SHORT display name shown to the user (${MAX_TRACK_LABEL_WORDS} words or fewer, Title Case, no trailing punctuation). This is a generic, recognisable topic name — e.g. "Russia–Ukraine war", "Attacks on Ukraine infrastructure".
- "search": a plain lowercase retrieval query (${MAX_TRACK_SEARCH_WORDS} words or fewer) with the concrete who / what / where entity anchors that make future articles match — e.g. "russia ukraine civilian infrastructure attacks". NOT shown to the user.
Rules:
- Order options narrow → broad. Make the labels GENERIC enough that future developments keep matching (track the CONTINUING story, not this single article).
- Do not invent entities absent from the ARTICLE / RELATED COVERAGE. Plain, neutral language; no clickbait, no ALL CAPS.
- Scopes must stay matchable indefinitely. Check the Today / Published dates in <context>: NEVER name an already-ended year, season or edition, and prefer an UNDATED scope ("Hungarian Grand Prix updates") over a dated one.
- If the user redirects ("track the protest itself, not this article"), call proposeTrack AGAIN with re-scoped options.
- If TRACK STATE says already following, do NOT propose — just tell them it's already being followed.
Example — article "Russia strikes humanitarian sites in Ukraine": proposeTrack {"options": [{"label": "Attacks on Ukraine infrastructure", "search": "russia ukraine civilian infrastructure attacks"}, {"label": "Russia–Ukraine war", "search": "russia ukraine war"}, {"label": "European security crisis", "search": "europe russia security military tensions"}]}

## Rules
- NEVER change anything directly. ALWAYS stage changes via the proposeChanges tool — a ≤2-sentence explanation, a ≤2-sentence expected_effects, and a MINIMAL action list.
- Pick the LEAST drastic action that fits: "less cricket" → set_topic_weight (small negative delta), not a mute. "Mute Times of India" → set_publication_pref mute. "Wrong Delhi — I meant Delhi Ohio" → add_negative_topic.
- "Less of this / not for me" → ONE proposeChanges with choose_one:true offering 2–4 mutually-exclusive alternatives ordered least→most drastic (e.g. down-weight the topic → suppress a named ENTITY → retire the topic → suppress the CATEGORY). The user picks exactly one; typing free text (e.g. "mute the source") is always an option.
- "This isn't important to me" → ask ONE short why-question FIRST, then stage the persona update their answer implies.
- When a PENDING PROPOSAL is shown and the user confirms (yes / ok / do it, in any language) call applyProposal; if they decline call cancelProposal. If they say anything else, leave the proposal pending and answer normally.
- Keep replies short (≤2 sentences). ${languageRule}${toolSection}`;
}

/**
 * XML tool-call format block for the local path (same convention as the persona
 * agent's buildToolFormatSection, but scoped to the 3 proposal tools with one
 * compact proposeChanges example).
 */
function buildArticleFeedbackToolFormat(): string {
  return `

## Tools
Write conversational text, then emit tool calls when needed.
Format: <tool_call>{"name": "toolName", "arguments": {...}}</tool_call>

- proposeChanges: {"explanation": string, "expected_effects": string, "choose_one"?: boolean, "actions": [{"type": string, "statement"?, "fact_id"?, "new_statement"?, "topics"?: string[], "title"?, "summary"?, "topicText"?, "delta"?: number, "weight"?: number, "publicationId"?, "publicationPref"?: "boost"|"deprioritize"|"mute", "suppressionPattern"?, "suppressionKeywords"?: string[], "suppressionStrength"?: number, "suppressionKind"?: ${SUPPRESSION_KINDS.join('|')}, "suppressionValue"?, "suppressionId"?, "highPriority"?: boolean}]}
  suppressionValue: copy VERBATIM from <context>, or omit it together with suppressionKind. suppressionId: an [id] from YOUR FILTERS.
- proposeTrack: {"options": [{"label": string, "search": string}]}
- applyProposal: {}
- cancelProposal: {}

## Example (format only)
<tool_call>{"name": "proposeChanges", "arguments": {"explanation": "You want less of this.", "expected_effects": "Pick how far to go.", "choose_one": true, "actions": [{"type": "set_topic_weight", "topicText": "cricket", "delta": -0.3}, {"type": "retire_topic", "topicText": "cricket"}]}}</tool_call>
<tool_call>{"name": "proposeTrack", "arguments": {"options": [{"label": "Attacks on Ukraine infrastructure", "search": "russia ukraine civilian infrastructure attacks"}, {"label": "Russia–Ukraine war", "search": "russia ukraine war"}, {"label": "European security crisis", "search": "europe russia security military tensions"}]}}</tool_call>`;
}

// ---------------------------------------------------------------------------
// Dynamic context (rebuilt every turn)
// ---------------------------------------------------------------------------

/**
 * Assembles the `<context>` block from plain inputs the adapter has already
 * fetched. Mirrors the old ArticleFeedbackAgent.buildContext exactly, including
 * the limited-article-access status wording and the ALL-FACTS drop when the
 * assembled context exceeds CONTEXT_TOKEN_BUDGET.
 */
export function buildFeedbackContext(input: FeedbackContextInput): string {
  const { facts, context: ctx, fallbackTitle, proposal, isTracked, relatedCoverage, verdict, tappedOptions, nowMs, articlePubDate, activeSuppressions } = input;

  // Injected clock (never read here) — anchors the agent to the present so
  // proposeTrack scopes can't name a season/year that is already over.
  const todayLine = `Today: ${isoDay(nowMs) ?? 'unknown'}`;
  const publishedDay = isoDayFromString(articlePubDate);

  // --- ARTICLE ---
  let articleBlock: string;
  if (ctx) {
    const s = ctx.suggestion;
    const title = s.title_en ?? s.title_original ?? fallbackTitle ?? '(untitled)';
    const lines = [`Title: ${trunc(title, 160)}`];
    if (publishedDay) lines.push(`Published: ${publishedDay}`);
    if (s.publication_name) lines.push(`Publication: ${trunc(s.publication_name, 80)}`);
    if (s.description_en) lines.push(`Description: ${trunc(s.description_en, ARTICLE_DESC_TRUNC)}`);
    // Category + entities feed the "less of this" choose-one alternatives (one
    // line each; capped so the block stays compact).
    if (ctx.category) lines.push(`Category: ${trunc(ctx.category, 60)}`);
    const entities = (ctx.entities ?? []).slice(0, MAX_ARTICLE_ENTITIES);
    if (entities.length > 0) lines.push(`Entities: ${entities.join(', ')}`);
    articleBlock = `## ARTICLE\n${lines.join('\n')}`;
  } else {
    articleBlock = `## ARTICLE\nTitle: ${trunc(fallbackTitle ?? '(untitled)', 160)}`
      + (publishedDay ? `\nPublished: ${publishedDay}` : '');
  }

  // --- SUGGESTION STATUS ---
  let statusBlock: string;
  if (!ctx) {
    statusBlock = '## SUGGESTION STATUS\nThis article was NOT one of your personalized suggestions.';
  } else if (ctx.suggestion.isScored) {
    // Internal relevance is 0.0–1.1; present on a 0–10 scale for the model.
    const score10 = Math.min(10, ctx.suggestion.relevance * 10).toFixed(1);
    const reason = ctx.suggestion.reason?.trim();
    statusBlock =
      `## SUGGESTION STATUS\nRelevance score: ${score10}/10.`
      + (reason ? ` Reason given: "${trunc(reason, 200)}"` : '');
  } else {
    statusBlock = '## SUGGESTION STATUS\nUnscored — scoring has not finished yet.';
  }

  // --- MATCHED TOPICS ---
  const matchedTopics = ctx?.matchedTopicTexts.slice(0, MAX_MATCHED_TOPICS) ?? [];
  const matchedTopicsBlock =
    '## MATCHED TOPICS\n'
    + (matchedTopics.length > 0 ? matchedTopics.map((t) => `- ${t}`).join('\n') : 'None.');

  // --- FACTS THAT PRODUCED THEM ---
  const producingFacts = ctx?.linkedFacts.slice(0, MAX_PRODUCING_FACTS) ?? [];
  const producingBlock =
    '## FACTS THAT PRODUCED THEM\n'
    + (producingFacts.length > 0
      ? producingFacts.map((f) => `- [${f.id}] ${trunc(f.statement, FACT_STATEMENT_TRUNC)}`).join('\n')
      : 'None.');

  // --- ALL YOUR FACTS (largest block — dropped first if over budget) ---
  const allFactsRows = facts.slice(0, MAX_ALL_FACTS).map((f) => {
    const topics = (f.metadata?.topics ?? []).slice(0, TOPICS_PER_FACT_PREVIEW);
    const topicsSuffix = topics.length > 0 ? ` (topics: ${topics.join(', ')})` : '';
    return `- [${f.id}] ${trunc(f.statement, FACT_STATEMENT_TRUNC)}${topicsSuffix}`;
  });
  const allFactsBlock =
    '## ALL YOUR FACTS\n' + (allFactsRows.length > 0 ? allFactsRows.join('\n') : 'Nothing yet.');

  // --- TRACK STATE (only when the caller knows the follow state) ---
  const trackStateBlock =
    typeof isTracked === 'boolean'
      ? `## TRACK STATE\n${
          isTracked
            ? 'You are ALREADY following this story — do not propose to track it again.'
            : 'You are not yet following this story.'
        }`
      : null;

  // --- RELATED COVERAGE (sibling-cluster titles that ground track options) ---
  const coverageTitles = (relatedCoverage ?? [])
    .map((t) => (t ?? '').trim())
    .filter((t) => t.length > 0)
    .slice(0, MAX_RELATED_COVERAGE);
  const relatedCoverageBlock =
    coverageTitles.length > 0
      ? '## RELATED COVERAGE\n'
        + coverageTitles.map((t) => `- ${trunc(t, RELATED_COVERAGE_TITLE_TRUNC)}`).join('\n')
        + '\nUse ONLY these when proposing track options.'
      : null;

  // --- YOUR FILTERS (active "not interested" rules — enables retire_suppression) ---
  const filterRows = selectActiveFiltersForContext(activeSuppressions, ctx);
  const filtersBlock =
    filterRows.length > 0
      ? '## YOUR FILTERS (things already hidden — retire_suppression removes one by [id])\n'
        + filterRows
          .map(({ row, matches }) => {
            const kind = row.kind ?? 'keyword';
            const kindSuffix = kind === 'keyword' ? '' : ` (${kind})`;
            const matchSuffix = matches ? ' — matches this article' : '';
            return `- [${row.id}] "${trunc(row.pattern, SUPPRESSION_PATTERN_TRUNC)}"${kindSuffix}${matchSuffix}`;
          })
          .join('\n')
      : null;

  // --- PENDING PROPOSAL ---
  const pendingBlock = proposal
    ? '## PENDING PROPOSAL\n'
      + `${proposal.explanation}\n`
      + `Actions: ${proposal.actions.map(describeAction).join('; ')}\n`
      + 'If the user confirms call applyProposal; if they decline call cancelProposal.'
    : null;

  // --- USER VERDICT (Feed-tab handoff) — grounds the proposal ---
  let verdictBlock: string | null = null;
  if (verdict) {
    const lines = [
      `## USER VERDICT\n${verdict === 'like' ? 'The user LIKED this story — they want MORE like it.' : "The user DISLIKED this story — they want FEWER like it."}`,
    ];
    const options = (tappedOptions ?? []).map((o) => (o ?? '').trim()).filter((o) => o.length > 0);
    if (options.length > 0) {
      lines.push(`TAPPED OPTIONS: ${options.join(' → ')}`);
    }
    verdictBlock = lines.join('\n');
  }

  // `todayLine` leads the ALWAYS list so it also survives the over-budget trim
  // below — a fact-heavy persona must not silently lose the date anchor.
  const alwaysBlocks = [todayLine, articleBlock, statusBlock, matchedTopicsBlock, producingBlock];
  if (verdictBlock) alwaysBlocks.push(verdictBlock);
  if (relatedCoverageBlock) alwaysBlocks.push(relatedCoverageBlock);
  if (trackStateBlock) alwaysBlocks.push(trackStateBlock);
  // ALWAYS (never trimmed): a filter list the user is asking about must not
  // silently vanish on a fact-heavy persona — and retire_suppression is
  // rejected outright without it. Capped at MAX_ACTIVE_FILTERS, so it is small.
  if (filtersBlock) alwaysBlocks.push(filtersBlock);
  const trailing = pendingBlock ? [pendingBlock] : [];

  const withAllFacts = [...alwaysBlocks, allFactsBlock, ...trailing];
  const assembled = `<context>\n${withAllFacts.join('\n\n')}\n</context>`;

  if (estimateTokens(assembled) <= CONTEXT_TOKEN_BUDGET) {
    return assembled;
  }

  // Over budget — drop the ALL-FACTS block (largest, and least essential for
  // an already-diagnosed article).
  const trimmed = [...alwaysBlocks, ...trailing];
  return `<context>\n${trimmed.join('\n\n')}\n</context>`;
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI JSON Schema for cloud chat)
// ---------------------------------------------------------------------------

export function getArticleFeedbackToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'proposeChanges',
        description:
          'Stage persona changes for the user to confirm. Never applies them directly. Explanation and expected_effects each ≤2 sentences; actions minimal.',
        parameters: {
          type: 'object',
          properties: {
            explanation: { type: 'string', description: 'Why (≤2 sentences).' },
            expected_effects: { type: 'string', description: 'What changes in the feed (≤2 sentences).' },
            choose_one: {
              type: 'boolean',
              description: 'When true, actions are mutually-exclusive alternatives and the user picks EXACTLY ONE (single-select card). Use for "less of this / not for me".',
            },
            actions: {
              type: 'array',
              description: 'Minimal list of persona changes (or alternatives when choose_one).',
              items: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: [...PROPOSAL_ACTION_ENUM],
                    description: 'Action kind.',
                  },
                  statement: { type: 'string', description: 'add_fact: the new fact (English).' },
                  fact_id: { type: 'string', description: 'update/delete/add_topics/remove_topics: target fact [id].' },
                  new_statement: { type: 'string', description: 'update_fact: replacement statement.' },
                  topics: { type: 'array', items: { type: 'string' }, description: 'add_topics/remove_topics: topic texts.' },
                  title: { type: 'string', description: 'submit_feature_request: short feature name (≤80 chars, no "[Feature Request]" prefix).' },
                  summary: { type: 'string', description: 'submit_feature_request: 2–4 sentence description, English, NO personal info.' },
                  topicText: { type: 'string', description: 'set_topic_weight/set_high_priority/retire_topic: a MATCHED topic text. add_negative_topic: the topic/place to down-rank.' },
                  delta: { type: 'number', description: 'set_topic_weight: weight nudge; negative = show less, positive = show more (|delta| ≤ 0.5).' },
                  weight: { type: 'number', description: 'add_negative_topic: optional explicit weight (defaults to a down-ranking value).' },
                  publicationId: { type: 'string', description: 'set_publication_pref: the publication NAME to adjust.' },
                  publicationPref: { type: 'string', enum: ['boost', 'deprioritize', 'mute'], description: 'set_publication_pref: boost, deprioritize, or mute the named publication.' },
                  suppressionPattern: { type: 'string', description: 'add_suppression: the phrase to filter out of the feed (e.g. an entity or category).' },
                  suppressionKeywords: { type: 'array', items: { type: 'string' }, description: 'add_suppression: optional extra keywords that also match the phrase.' },
                  suppressionStrength: { type: 'number', description: 'add_suppression: 0.9 = never show it, 0.5 = just less of it (defaults to a strong value).' },
                  suppressionKind: {
                    type: 'string',
                    enum: [...SUPPRESSION_KINDS],
                    description:
                      'add_suppression: makes the filter exact instead of a text match. Only send it together with suppressionValue.',
                  },
                  suppressionValue: {
                    type: 'string',
                    description:
                      'add_suppression: the exact field value to filter on, COPIED VERBATIM from <context> — category ← the Category line, entity ← one of Entities, publication ← the Publication line, topic ← one of MATCHED TOPICS. A paraphrased or invented value matches NOTHING; when the phrase is your own wording, omit suppressionKind+suppressionValue and send suppressionPattern alone.',
                  },
                  suppressionId: {
                    type: 'string',
                    description:
                      'retire_suppression: the [id] of a row in the YOUR FILTERS block of <context>. Never invent one.',
                  },
                  highPriority: { type: 'boolean', description: 'set_high_priority: true to pin the topic, false to unpin.' },
                },
                required: ['type'],
              },
            },
          },
          required: ['explanation', 'expected_effects', 'actions'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'proposeTrack',
        description:
          "Propose following this article's unfolding story as a durable topic. Never tracks directly — stages a confirm card. Give 3–4 `options` at widening scope (narrow event → broad ongoing story), each a scope pill with a short display `label` and a hidden lowercase `search` retrieval query. Ground the scope in the ARTICLE + RELATED COVERAGE. The user picks one label; its `search` becomes the tracked topic.",
        parameters: {
          type: 'object',
          properties: {
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: {
                    type: 'string',
                    description:
                      'Short display name shown to the user (≤5 words, Title Case, generic/recognisable, e.g. "Russia–Ukraine war").',
                  },
                  search: {
                    type: 'string',
                    description:
                      'Hidden lowercase retrieval query with concrete who/what/where anchors (≤8 words, e.g. "russia ukraine civilian infrastructure attacks"). NOT shown to the user.',
                  },
                },
                required: ['label', 'search'],
              },
              description:
                '3–4 scope pills ordered narrow → broad, grounded ONLY in the ARTICLE + RELATED COVERAGE.',
            },
          },
          required: ['options'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'applyProposal',
        description: 'Apply the pending proposal when the user confirms.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancelProposal',
        description: 'Discard the pending proposal when the user declines.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Propose/confirm decision logic (pure)
// ---------------------------------------------------------------------------

function describeAction(a: ProposalAction): string {
  switch (a.type) {
    case 'add_fact':
      return `add fact "${trunc(a.statement, 60)}"`;
    case 'update_fact':
      return `update [${a.fact_id}] → "${trunc(a.new_statement, 60)}"`;
    case 'delete_fact':
      return `delete [${a.fact_id}]`;
    case 'add_topics':
      return `add topics to [${a.fact_id}]: ${a.topics.join(', ')}`;
    case 'remove_topics':
      return `remove topics from [${a.fact_id}]: ${a.topics.join(', ')}`;
    case 'submit_feature_request':
      return `send feature request "${trunc(a.title, 60)}" to the Mera team`;
    case 'set_topic_weight':
      return `${a.delta < 0 ? 'show less' : 'show more'} of "${trunc(a.topicText, 60)}"`;
    case 'add_negative_topic':
      return `down-rank "${trunc(a.topicText, 60)}"`;
    case 'set_publication_pref':
      return `${a.publicationPref} publication "${trunc(a.publicationId, 60)}"`;
    case 'add_suppression':
      return a.suppressionKind && a.suppressionValue
        ? `suppress ${a.suppressionKind} "${trunc(a.suppressionValue, 60)}"`
        : `suppress "${trunc(a.suppressionPattern, 60)}"`;
    case 'retire_suppression':
      return `remove the filter "${trunc(a.pattern, 60)}"`;
    case 'set_high_priority':
      return `${a.highPriority ? 'pin' : 'unpin'} topic "${trunc(a.topicText, 60)}"`;
    case 'retire_topic':
      return `retire topic "${trunc(a.topicText, 60)}"`;
    case 'track_story':
      return `follow "${trunc(a.label, 80)}"`;
  }
}

type ValidatedAction = { action: ProposalAction } | { error: string };

/**
 * Everything the sanitizer needs beyond the fact ids, in ONE optional bag so
 * callers that don't have it (and the pre-P4a tests) keep working:
 *
 *  - `article` corroborates a structured suppression value (D9). A value the
 *    article context does not actually contain is downgraded to a keyword
 *    filter rather than staged as a filter that could never fire.
 *  - `activeSuppressions` is the ONLY source of ids `retire_suppression` may
 *    name, and of the display `pattern` we stage — never the model's own text.
 *    Absent/empty ⇒ retire_suppression is rejected outright.
 */
export interface ProposalSanitizerContext {
  article?: SuggestionFeedbackContext | null;
  activeSuppressions?: ActiveSuppressionView[];
}

/** kind → the set of normalized values the ARTICLE actually exposes for it. */
function buildCorroborableValues(
  ctx: SuggestionFeedbackContext | null | undefined,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!ctx) return out;
  const put = (kind: string, values: (string | null | undefined)[]) => {
    const set = new Set(values.map(norm).filter((v) => v.length > 0));
    if (set.size > 0) out.set(kind, set);
  };
  put('category', [ctx.category]);
  put('entity', ctx.entities ?? []);
  put('publication', [ctx.suggestion.publication_name]);
  put('topic', ctx.matchedTopicTexts ?? []);
  return out;
}

function validateAction(
  raw: unknown,
  factIds: Set<string>,
  corroborable: Map<string, Set<string>>,
  filtersById: Map<string, ActiveSuppressionView>,
): ValidatedAction {
  if (raw == null || typeof raw !== 'object') return { error: 'action must be an object' };
  const o = raw as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== 'string' || !VALID_ACTION_TYPES.has(type)) {
    return { error: `invalid action type: ${String(type)}` };
  }

  switch (type) {
    case 'add_fact': {
      if (typeof o.statement !== 'string' || o.statement.trim().length === 0) {
        return { error: 'add_fact requires a non-empty statement' };
      }
      return { action: { type: 'add_fact', statement: o.statement.trim() } };
    }
    case 'update_fact': {
      if (typeof o.fact_id !== 'string' || !factIds.has(o.fact_id)) {
        return { error: `update_fact references unknown fact_id: ${String(o.fact_id)}` };
      }
      if (typeof o.new_statement !== 'string' || o.new_statement.trim().length === 0) {
        return { error: 'update_fact requires a non-empty new_statement' };
      }
      return { action: { type: 'update_fact', fact_id: o.fact_id, new_statement: o.new_statement.trim() } };
    }
    case 'delete_fact': {
      if (typeof o.fact_id !== 'string' || !factIds.has(o.fact_id)) {
        return { error: `delete_fact references unknown fact_id: ${String(o.fact_id)}` };
      }
      return { action: { type: 'delete_fact', fact_id: o.fact_id } };
    }
    case 'add_topics':
    case 'remove_topics': {
      if (typeof o.fact_id !== 'string' || !factIds.has(o.fact_id)) {
        return { error: `${type} references unknown fact_id: ${String(o.fact_id)}` };
      }
      const topics = Array.isArray(o.topics)
        ? o.topics.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
        : [];
      if (topics.length === 0) return { error: `${type} requires a non-empty topics array` };
      return { action: { type, fact_id: o.fact_id, topics } };
    }
    case 'set_topic_weight': {
      const topicText = typeof o.topicText === 'string' ? o.topicText.trim() : '';
      if (topicText.length === 0) return { error: 'set_topic_weight requires a non-empty topicText' };
      if (typeof o.delta !== 'number' || !Number.isFinite(o.delta) || o.delta === 0) {
        return { error: 'set_topic_weight requires a non-zero numeric delta' };
      }
      // Clamp to a gentle nudge so a single confirm can't zero out a topic.
      const delta = Math.max(-MAX_TOPIC_WEIGHT_DELTA, Math.min(MAX_TOPIC_WEIGHT_DELTA, o.delta));
      return { action: { type: 'set_topic_weight', topicText, delta } };
    }
    case 'add_negative_topic': {
      const topicText = typeof o.topicText === 'string' ? o.topicText.trim() : '';
      if (topicText.length === 0) return { error: 'add_negative_topic requires a non-empty topicText' };
      if (typeof o.weight === 'number' && Number.isFinite(o.weight)) {
        return { action: { type: 'add_negative_topic', topicText, weight: o.weight } };
      }
      return { action: { type: 'add_negative_topic', topicText } };
    }
    case 'set_publication_pref': {
      const publicationId = typeof o.publicationId === 'string' ? o.publicationId.trim() : '';
      if (publicationId.length === 0) return { error: 'set_publication_pref requires a non-empty publicationId' };
      const pref = typeof o.publicationPref === 'string' ? o.publicationPref.trim() : '';
      if (!VALID_PUBLICATION_PREFS.has(pref)) {
        return { error: `set_publication_pref requires publicationPref ∈ boost|deprioritize|mute (got: ${String(o.publicationPref)})` };
      }
      return {
        action: {
          type: 'set_publication_pref',
          publicationId,
          publicationPref: pref as 'boost' | 'deprioritize' | 'mute',
        },
      };
    }
    case 'add_suppression': {
      const rawValue = typeof o.suppressionValue === 'string' ? o.suppressionValue.trim() : '';
      // A structured value doubles as the display phrase when the model sent no
      // separate pattern (e.g. muting a publication it quoted verbatim).
      const pattern =
        (typeof o.suppressionPattern === 'string' ? o.suppressionPattern.trim() : '') || rawValue;
      if (pattern.length === 0) return { error: 'add_suppression requires a non-empty suppressionPattern' };
      const keywords = Array.isArray(o.suppressionKeywords)
        ? o.suppressionKeywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).map((k) => k.trim())
        : undefined;
      const action: ProposalAction = { type: 'add_suppression', suppressionPattern: pattern };
      if (keywords && keywords.length > 0) action.suppressionKeywords = keywords;
      if (typeof o.suppressionStrength === 'number' && Number.isFinite(o.suppressionStrength)) {
        action.suppressionStrength = o.suppressionStrength;
      }
      // D9 — a structured filter matches by EXACT equality against one article
      // field, so an invented value ("celebrity stuff" as a category) would be a
      // filter that silently never fires. Keep the structured pair ONLY when the
      // article context corroborates it verbatim; otherwise fall back to the
      // keyword filter, which always works. Prompt wording pushes the model the
      // same way — this makes it an invariant rather than a hope.
      const rawKind = typeof o.suppressionKind === 'string' ? o.suppressionKind.trim().toLowerCase() : '';
      if (
        rawKind
        && rawKind !== 'keyword'
        && rawValue.length > 0
        && (SUPPRESSION_KINDS as readonly string[]).includes(rawKind)
        && CORROBORABLE_SUPPRESSION_KINDS.has(rawKind)
        && corroborable.get(rawKind)?.has(norm(rawValue)) === true
      ) {
        action.suppressionKind = rawKind as SuppressionKindName;
        action.suppressionValue = rawValue;
      }
      return { action };
    }
    case 'retire_suppression': {
      const suppressionId = typeof o.suppressionId === 'string' ? o.suppressionId.trim() : '';
      if (suppressionId.length === 0) {
        return { error: 'retire_suppression requires a non-empty suppressionId' };
      }
      // Strict by construction: with no filters in context there is no id to
      // resolve, so a hallucinated one can never reach the executor.
      const row = filtersById.get(suppressionId);
      if (!row) {
        return { error: `retire_suppression references unknown suppressionId: ${suppressionId}` };
      }
      // `pattern` is resolved from OUR list, never from the model — the confirm
      // card and the PENDING PROPOSAL line can't be made to lie about what is
      // being removed.
      return { action: { type: 'retire_suppression', suppressionId: row.id, pattern: row.pattern } };
    }
    case 'set_high_priority': {
      const topicText = typeof o.topicText === 'string' ? o.topicText.trim() : '';
      if (topicText.length === 0) return { error: 'set_high_priority requires a non-empty topicText' };
      if (typeof o.highPriority !== 'boolean') return { error: 'set_high_priority requires a boolean highPriority' };
      return { action: { type: 'set_high_priority', topicText, highPriority: o.highPriority } };
    }
    case 'retire_topic': {
      const topicText = typeof o.topicText === 'string' ? o.topicText.trim() : '';
      if (topicText.length === 0) return { error: 'retire_topic requires a non-empty topicText' };
      return { action: { type: 'retire_topic', topicText } };
    }
    case 'submit_feature_request': {
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
      if (title.length === 0) return { error: 'submit_feature_request requires a non-empty title' };
      if (title.length > FEATURE_REQUEST_TITLE_MAX) {
        return { error: `submit_feature_request title must be ≤${FEATURE_REQUEST_TITLE_MAX} chars` };
      }
      if (summary.length === 0) return { error: 'submit_feature_request requires a non-empty summary' };
      if (summary.length > FEATURE_REQUEST_SUMMARY_MAX) {
        return { error: `submit_feature_request summary must be ≤${FEATURE_REQUEST_SUMMARY_MAX} chars` };
      }
      return { action: { type: 'submit_feature_request', title, summary } };
    }
    default:
      return { error: `invalid action type: ${type}` };
  }
}

/**
 * Pure propose/confirm decision: validates the raw proposeChanges args against
 * the known fact ids and either returns an error ToolExecutionResult or a
 * `sideEffects.proposal` staging result. Does NOT touch the DB — the adapter
 * passes in the current fact ids (from its getFacts pass).
 */
export function decideProposeChanges(
  args: Record<string, unknown>,
  factIds: Set<string>,
  sanitizerContext: ProposalSanitizerContext = {},
): ToolExecutionResult {
  const explanation = typeof args.explanation === 'string' ? args.explanation.trim() : '';
  const expectedEffects = typeof args.expected_effects === 'string' ? args.expected_effects.trim() : '';
  const rawActions = args.actions;
  // Single-select mode: the actions are mutually-exclusive alternatives.
  const chooseOne = args.choose_one === true;

  if (!explanation) return { result: { error: 'explanation is required' } };
  if (!expectedEffects) return { result: { error: 'expected_effects is required' } };
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    return { result: { error: 'actions must be a non-empty array' } };
  }

  const corroborable = buildCorroborableValues(sanitizerContext.article);
  const filtersById = new Map<string, ActiveSuppressionView>(
    (sanitizerContext.activeSuppressions ?? [])
      .filter((s) => s && typeof s.id === 'string' && s.id.length > 0)
      .map((s) => [s.id, s]),
  );

  const actions: ProposalAction[] = [];
  for (const raw of rawActions) {
    const validated = validateAction(raw, factIds, corroborable, filtersById);
    if ('error' in validated) return { result: { error: validated.error } };
    actions.push(validated.action);
  }

  const proposal: StagedProposal = {
    id: `proposal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    explanation,
    expectedEffects,
    actions,
    // Only mark chooseOne when there is a genuine choice (≥2 alternatives).
    ...(chooseOne && actions.length >= 2 ? { chooseOne: true } : {}),
  };

  // proposalId is echoed in the result so deriveThreadItems can key the rebuilt
  // proposal card to store.proposal / resolvedProposals.
  return {
    result: {
      staged: true,
      actionCount: actions.length,
      proposalId: proposal.id,
      ...(proposal.chooseOne ? { chooseOne: true } : {}),
    },
    sideEffects: { proposal },
  };
}

/**
 * Pure decision for the `proposeTrack` tool: parses the LLM's 3–4 scope
 * `options` (display label + hidden search query) into `track_story` actions,
 * each carrying the caller's origin `subject` snapshot. The subject + the parsed
 * options are echoed in the result so deriveThreadItems can rebuild the exact
 * confirmable proposal from the persisted tool call (no store read). ≥2 pills →
 * a single-select card (the user picks one scope). Returns an error result when
 * no valid option survives parsing.
 *
 * The already-tracked guard lives in the RN adapter (it needs an async DB read);
 * this function assumes the caller decided a proposal is warranted.
 */
export function decideProposeTrack(
  args: Record<string, unknown>,
  subject: TrackFeedbackSubject,
): ToolExecutionResult {
  // Accept the structured `options` (label+search); tolerate a legacy `track`
  // string as a single lone option so an older model output still tracks.
  const rawOptions =
    Array.isArray(args.options) && args.options.length > 0
      ? args.options
      : typeof args.track === 'string' && args.track.trim()
        ? [args.track]
        : [];
  const options = parseTrackScopeOptions(rawOptions);
  if (options.length === 0) return { result: { error: 'options is required' } };

  const id = `track-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const actions: ProposalAction[] = options.map((o) => ({
    type: 'track_story',
    label: o.label,
    searchText: o.search,
    subject,
  }));
  const chooseOne = actions.length >= 2;

  const proposal: StagedProposal = {
    id,
    explanation: '',
    expectedEffects: '',
    actions,
    ...(chooseOne ? { chooseOne: true } : {}),
  };

  // subject + options are echoed so deriveThreadItems can rebuild the confirmable
  // actions from the persisted tool result identically to this live path.
  return {
    result: {
      staged: true,
      proposalId: proposal.id,
      ...(chooseOne ? { chooseOne: true } : {}),
      options,
      subject,
    },
    sideEffects: { proposal },
  };
}
