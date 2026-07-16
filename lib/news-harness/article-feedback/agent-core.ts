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
} from '../core/types';

// --- Context caps (named so the budget is auditable) ---
const MAX_MATCHED_TOPICS = 10;
const MAX_PRODUCING_FACTS = 5;
const MAX_ALL_FACTS = 12; // newest-first — needed for "more of this" diagnosis
const ARTICLE_DESC_TRUNC = 160;
const FACT_STATEMENT_TRUNC = 120;
const TOPICS_PER_FACT_PREVIEW = 3;
// Drop the (largest) ALL-FACTS block first if the assembled context exceeds
// this — keeps the local path's ~3072-token input budget comfortable.
const CONTEXT_TOKEN_BUDGET = 1800;

const VALID_ACTION_TYPES = new Set([
  'add_fact',
  'update_fact',
  'delete_fact',
  'add_topics',
  'remove_topics',
  'submit_feature_request',
]);

const FEATURE_REQUEST_TITLE_MAX = 80;
const FEATURE_REQUEST_SUMMARY_MAX = 500;

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

## Capabilities
- Mera CAN ONLY adjust the user's persona: add / update / delete facts, and add / remove topics on a fact. Changing facts and topics is what changes which news gets surfaced.
- Mera CANNOT: block or restrict a publication / source, change scoring thresholds, hide a specific article, change app settings, or anything else outside fact/topic edits.
- If the user asks for something Mera cannot do (e.g. "I don't like this publication"), clearly say Mera can't do that today, and ask if they'd like to send a feature request to the Mera team. If they agree, stage it via proposeChanges with a single submit_feature_request action: title = short feature name (do NOT include any prefix), summary = 2–4 sentences describing the capability, written in English, with NO personal info (no names, emails, locations, or the user's facts — describe it generically, e.g. "ability to mute a publication"). Explanation: "I'll send this suggestion to the Mera team."; expected_effects: "The team will consider it — this won't change your feed today."

## Rules
- NEVER change anything directly. ALWAYS stage changes via the proposeChanges tool — a ≤2-sentence explanation, a ≤2-sentence expected_effects, and a MINIMAL action list.
- Action types: add_fact, update_fact, delete_fact, add_topics, remove_topics (persona edits), and submit_feature_request (for capabilities Mera lacks). Reference facts by the [id] shown in <context>.
- For a vague "less of this", ask ONE clarifying question FIRST — is it the topic, the publication, or the angle? — before proposing.
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

- proposeChanges: {"explanation": string, "expected_effects": string, "actions": [{"type": string, "statement"?: string, "fact_id"?: string, "new_statement"?: string, "topics"?: string[], "title"?: string, "summary"?: string}]}
- applyProposal: {}
- cancelProposal: {}

## Example (format only)
<tool_call>{"name": "proposeChanges", "arguments": {"explanation": "You wanted less startup-funding news.", "expected_effects": "You'll see fewer startup-funding stories.", "actions": [{"type": "remove_topics", "fact_id": "abc123", "topics": ["startup funding"]}]}}</tool_call>`;
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
  const { facts, context: ctx, fallbackTitle, proposal } = input;

  // --- ARTICLE ---
  let articleBlock: string;
  if (ctx) {
    const s = ctx.suggestion;
    const title = s.title_en ?? s.title_original ?? fallbackTitle ?? '(untitled)';
    const lines = [`Title: ${trunc(title, 160)}`];
    if (s.publication_name) lines.push(`Publication: ${trunc(s.publication_name, 80)}`);
    if (s.description_en) lines.push(`Description: ${trunc(s.description_en, ARTICLE_DESC_TRUNC)}`);
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

  // --- PENDING PROPOSAL ---
  const pendingBlock = proposal
    ? '## PENDING PROPOSAL\n'
      + `${proposal.explanation}\n`
      + `Actions: ${proposal.actions.map(describeAction).join('; ')}\n`
      + 'If the user confirms call applyProposal; if they decline call cancelProposal.'
    : null;

  const alwaysBlocks = [articleBlock, statusBlock, matchedTopicsBlock, producingBlock];
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
            actions: {
              type: 'array',
              description: 'Minimal list of persona changes.',
              items: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['add_fact', 'update_fact', 'delete_fact', 'add_topics', 'remove_topics', 'submit_feature_request'],
                    description: 'Action kind.',
                  },
                  statement: { type: 'string', description: 'add_fact: the new fact (English).' },
                  fact_id: { type: 'string', description: 'update/delete/add_topics/remove_topics: target fact [id].' },
                  new_statement: { type: 'string', description: 'update_fact: replacement statement.' },
                  topics: { type: 'array', items: { type: 'string' }, description: 'add_topics/remove_topics: topic texts.' },
                  title: { type: 'string', description: 'submit_feature_request: short feature name (≤80 chars, no "[Feature Request]" prefix).' },
                  summary: { type: 'string', description: 'submit_feature_request: 2–4 sentence description, English, NO personal info.' },
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
  };

  // proposalId is echoed in the result so deriveThreadItems can key the rebuilt
  // proposal card to store.proposal / resolvedProposals.
  return {
    result: { staged: true, actionCount: actions.length, proposalId: proposal.id },
    sideEffects: { proposal },
  };
}
