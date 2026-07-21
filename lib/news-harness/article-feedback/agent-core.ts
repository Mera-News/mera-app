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

import type {
  FeedbackContextInput,
  ProposalAction,
  StagedProposal,
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
  'set_high_priority',
  'retire_topic',
] as const;

/** Publication-preference kinds the agent may set on a named publication. */
const VALID_PUBLICATION_PREFS = new Set(['boost', 'deprioritize', 'mute']);
/** Clamp bound for a topic-weight nudge delta — keeps "show less/more" gentle. */
const MAX_TOPIC_WEIGHT_DELTA = 0.5;

const FEATURE_REQUEST_TITLE_MAX = 80;
const FEATURE_REQUEST_SUMMARY_MAX = 500;

/** Target ceiling on a proposed follow-topic sentence (prompt guidance). */
const MAX_TRACK_WORDS = 18;
/** Hard cap on the accepted track text we stage (defensive trim). */
const MAX_TRACK_CHARS = 200;
/** Max distinct track-scope options a single choose-one track card offers. */
const MAX_TRACK_OPTIONS = 3;

function trunc(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
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
- add_suppression — filter out a phrase the user never wants (suppressionPattern; suppressionStrength 0.9 = never show it, 0.5 = just less of it).
- set_high_priority — pin a MATCHED topic the user cares strongly about (highPriority true), or unpin (false).
- retire_topic — the user is DONE with a MATCHED topic entirely (stronger than a small set_topic_weight nudge): retire it so it stops matching (topicText).
- submit_feature_request — Mera CANNOT change app settings, hide a single article, or change scoring thresholds; use this ONLY for capabilities none of the above cover. title = short feature name (NO prefix); summary = 2–4 English sentences, NO personal info (no names/emails/locations/facts). Explanation: "I'll send this suggestion to the Mera team."; expected_effects: "The team will consider it — this won't change your feed today."

## Following a story (the proposeTrack tool)
When the user wants to FOLLOW / TRACK this unfolding story, call proposeTrack with ONE durable sentence (${MAX_TRACK_WORDS} words or fewer) describing what to keep following:
- Describe the CONTINUING story (the protest, the trial, the negotiation, the outbreak…), NOT this single article, so future developments also match.
- Include the concrete who / what / where anchors that keep it specific. Do not invent details absent from the ARTICLE.
- Plain, neutral language. No clickbait, no ALL CAPS, no trailing punctuation.
- If the user redirects ("track the protest itself, not this article"), call proposeTrack AGAIN with the re-scoped topic.
- If TRACK STATE says already following, do NOT propose — just tell them it's already being followed.
Example: proposeTrack {"track": "Updates on the student protest in Sonbhadra over exam results"}

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

- proposeChanges: {"explanation": string, "expected_effects": string, "choose_one"?: boolean, "actions": [{"type": string, "statement"?, "fact_id"?, "new_statement"?, "topics"?: string[], "title"?, "summary"?, "topicText"?, "delta"?: number, "weight"?: number, "publicationId"?, "publicationPref"?: "boost"|"deprioritize"|"mute", "suppressionPattern"?, "suppressionKeywords"?: string[], "suppressionStrength"?: number, "highPriority"?: boolean}]}
- proposeTrack: {"track": string, "options"?: string[]}
- applyProposal: {}
- cancelProposal: {}

## Example (format only)
<tool_call>{"name": "proposeChanges", "arguments": {"explanation": "You want less of this.", "expected_effects": "Pick how far to go.", "choose_one": true, "actions": [{"type": "set_topic_weight", "topicText": "cricket", "delta": -0.3}, {"type": "retire_topic", "topicText": "cricket"}]}}</tool_call>
<tool_call>{"name": "proposeTrack", "arguments": {"track": "Updates on the student protest in Sonbhadra over exam results", "options": ["The Sonbhadra exam-result protest", "The wider UP student exam-reform movement"]}}</tool_call>`;
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
  const { facts, context: ctx, fallbackTitle, proposal, isTracked, relatedCoverage, verdict, tappedOptions } = input;

  // --- ARTICLE ---
  let articleBlock: string;
  if (ctx) {
    const s = ctx.suggestion;
    const title = s.title_en ?? s.title_original ?? fallbackTitle ?? '(untitled)';
    const lines = [`Title: ${trunc(title, 160)}`];
    if (s.publication_name) lines.push(`Publication: ${trunc(s.publication_name, 80)}`);
    if (s.description_en) lines.push(`Description: ${trunc(s.description_en, ARTICLE_DESC_TRUNC)}`);
    // Category + entities feed the "less of this" choose-one alternatives (one
    // line each; capped so the block stays compact).
    if (ctx.category) lines.push(`Category: ${trunc(ctx.category, 60)}`);
    const entities = (ctx.entities ?? []).slice(0, MAX_ARTICLE_ENTITIES);
    if (entities.length > 0) lines.push(`Entities: ${entities.join(', ')}`);
    articleBlock = `## ARTICLE\n${lines.join('\n')}`;
  } else {
    articleBlock = `## ARTICLE\nTitle: ${trunc(fallbackTitle ?? '(untitled)', 160)}`;
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

  const alwaysBlocks = [articleBlock, statusBlock, matchedTopicsBlock, producingBlock];
  if (verdictBlock) alwaysBlocks.push(verdictBlock);
  if (relatedCoverageBlock) alwaysBlocks.push(relatedCoverageBlock);
  if (trackStateBlock) alwaysBlocks.push(trackStateBlock);
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
          'Propose following this article\'s unfolding story as a durable topic. Never tracks directly — stages a confirm card. track = ONE plain sentence (≤18 words) describing the continuing story (who/what/where), not this single article. Optionally give 2–3 `options` (specific event ↔ bigger story) grounded ONLY in RELATED COVERAGE — the user then picks one scope.',
        parameters: {
          type: 'object',
          properties: {
            track: {
              type: 'string',
              description: 'The durable follow-topic sentence (≤18 words).',
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: '2–3 alternative follow-topic sentences at different scopes (specific event ↔ wider story), each ≤18 words, grounded ONLY in RELATED COVERAGE. When ≥2 valid, the card becomes single-select.',
            },
          },
          required: ['track'],
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
      return `suppress "${trunc(a.suppressionPattern, 60)}"`;
    case 'set_high_priority':
      return `${a.highPriority ? 'pin' : 'unpin'} topic "${trunc(a.topicText, 60)}"`;
    case 'retire_topic':
      return `retire topic "${trunc(a.topicText, 60)}"`;
    case 'track_story':
      return `follow "${trunc(a.trackText, 80)}"`;
  }
}

type ValidatedAction = { action: ProposalAction } | { error: string };

function validateAction(raw: unknown, factIds: Set<string>): ValidatedAction {
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
      const pattern = typeof o.suppressionPattern === 'string' ? o.suppressionPattern.trim() : '';
      if (pattern.length === 0) return { error: 'add_suppression requires a non-empty suppressionPattern' };
      const keywords = Array.isArray(o.suppressionKeywords)
        ? o.suppressionKeywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).map((k) => k.trim())
        : undefined;
      const action: ProposalAction = { type: 'add_suppression', suppressionPattern: pattern };
      if (keywords && keywords.length > 0) action.suppressionKeywords = keywords;
      if (typeof o.suppressionStrength === 'number' && Number.isFinite(o.suppressionStrength)) {
        action.suppressionStrength = o.suppressionStrength;
      }
      return { action };
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

  const actions: ProposalAction[] = [];
  for (const raw of rawActions) {
    const validated = validateAction(raw, factIds);
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
 * Pure decision for the `proposeTrack` tool: validates the LLM's one-sentence
 * `track` text and stages a single `track_story` action carrying the caller's
 * origin `subject` snapshot. The subject is embedded in the action (not read
 * from a store at confirm time) so the staged proposal is fully reconstructable
 * from the persisted tool call. Returns an error result on empty text.
 *
 * The already-tracked guard lives in the RN adapter (it needs an async DB read);
 * this function assumes the caller decided a proposal is warranted.
 */
export function decideProposeTrack(
  args: Record<string, unknown>,
  subject: TrackFeedbackSubject,
): ToolExecutionResult {
  const trimTrack = (s: string): string =>
    s.length > MAX_TRACK_CHARS ? `${s.slice(0, MAX_TRACK_CHARS - 1)}…` : s;

  // Distinct, non-empty scope options (specific ↔ broad). ≥2 → single-select.
  const options = Array.isArray(args.options)
    ? Array.from(
        new Set(
          args.options
            .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
            .map((o) => trimTrack(o.trim())),
        ),
      ).slice(0, MAX_TRACK_OPTIONS)
    : [];

  const id = `track-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  if (options.length >= 2) {
    const actions: ProposalAction[] = options.map((trackText) => ({
      type: 'track_story',
      trackText,
      subject,
    }));
    const proposal: StagedProposal = {
      id,
      explanation: '',
      expectedEffects: '',
      actions,
      chooseOne: true,
    };
    return {
      result: { staged: true, proposalId: id, chooseOne: true, options, subject },
      sideEffects: { proposal },
    };
  }

  // Single-option flow (unchanged): fall back to `track` (or a lone option).
  const raw =
    (typeof args.track === 'string' && args.track.trim()) || options[0] || '';
  if (!raw) return { result: { error: 'track is required' } };
  const trackText = trimTrack(raw);

  const proposal: StagedProposal = {
    id,
    explanation: '',
    expectedEffects: '',
    actions: [{ type: 'track_story', trackText, subject }],
  };

  // subject is echoed so deriveThreadItems can rebuild the confirmable action
  // from the persisted tool result (the tool INPUT carries only `track`).
  return {
    result: { staged: true, proposalId: proposal.id, track: trackText, subject },
    sideEffects: { proposal },
  };
}
