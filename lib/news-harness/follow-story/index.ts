// news-harness — the FollowStoryAgent's portable brain (PURE, RN-free).
//
// The "follow a story" chat started from the Followed-stories screen: there is
// NO article, only what the user types. Mera asks what they want to follow, then
// proposes 3–4 scope pills through the SAME `proposeTrack` tool the article
// surface uses — so the staged proposal, the ProposalCard rendering, the resume
// path (deriveThreadItems) and the executor (track_story →
// trackStoryWithProposal) are all the existing ones, unchanged.
//
// What is genuinely new here is only the surrounding conversation: a system
// prompt that scopes a story from FREE TEXT instead of from an ARTICLE +
// RELATED COVERAGE block, and a tiny <context> (the injected date anchor plus
// any pending proposal). Everything else is imported from the article-feedback
// core rather than restated:
//   - decideProposeTrack / parseTrackScopeOptions  (staging + parsing)
//   - the ProposalAction / StagedProposal shapes    (core/types)
//
// Everything that touches WatermelonDB, Zustand, the logger or any expo/RN
// module stays in lib/llm/agents/FollowStoryAgent.ts.

import type { StagedProposal, ToolDefinition, TrackFeedbackSubject } from '../core/types';

/** Target ceilings mirrored from the article path's scope pills (prompt
 *  guidance only — the parser enforces the hard char cap). */
const MAX_TRACK_LABEL_WORDS = 5;
const MAX_TRACK_SEARCH_WORDS = 8;
/** Display cap on a pending pill label rendered back into <context>. */
const PENDING_LABEL_TRUNC = 80;

/**
 * `originSurface` stamped on a story followed from the Followed-stories screen.
 * Distinct from the article surfaces ('detail', 'feed', …) so the origin of a
 * free-text follow stays legible in the row.
 */
export const FOLLOW_STORY_SURFACE = 'tracked-stories-chat';

/**
 * The origin snapshot a free-text follow tracks against. There is no article, so
 * `articleId` / `title` are deliberately EMPTY — every consumer already handles
 * that: `trackStory` seeds `member_article_ids: []` and skips the member
 * snapshot when `articleId` is falsy, and `normalizeTrackedQuery` cannot match a
 * blank id, so the duplicate guard in `trackStoryWithProposal` is simply inert
 * here (a free-text follow has no article identity to be a duplicate of).
 *
 * `origin: 'article'` rather than `'suggestion'` because nothing about this
 * follow came from a personalized suggestion row.
 */
export function makeFollowStorySubject(): TrackFeedbackSubject {
  return {
    origin: 'article',
    surface: FOLLOW_STORY_SURFACE,
    articleId: '',
    title: '',
    pubDate: null,
    stableClusterId: null,
    publicationName: null,
  };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildFollowStorySystemPrompt(params: {
  needsToolFormat: boolean;
  languageName?: string;
}): string {
  const { needsToolFormat, languageName } = params;

  const languageRule = languageName
    ? `LANGUAGE: ALWAYS write conversational text in **${languageName}**, with no exceptions — even if the user writes in another language. Scope labels and search queries stay English.`
    : "LANGUAGE: Match the user's language (switch if they switch). Scope labels and search queries stay English.";

  const toolSection = needsToolFormat ? buildFollowStoryToolFormat() : '';

  return `You are Mera, helping the user start FOLLOWING a news story.

## The one thing you do here
The user came from their Followed stories screen and wants to follow something new. There is NO article in this conversation — only what the user tells you.
1. If you do not yet know what they want to follow, ask ONE short question: what story or subject should Mera follow?
2. As soon as they name something, call proposeTrack with 3–4 scope OPTIONS at widening scope (the narrow specific event → the broad ongoing story) so they can pick how much of it to follow.
3. Never claim a story is being followed until the user picks a scope on the card.

## Following a story (the proposeTrack tool)
Each option has TWO fields:
- "label": the SHORT display name shown to the user (${MAX_TRACK_LABEL_WORDS} words or fewer, Title Case, no trailing punctuation). Generic and recognisable — e.g. "Russia–Ukraine war".
- "search": a plain lowercase retrieval query (${MAX_TRACK_SEARCH_WORDS} words or fewer) with the concrete who / what / where entity anchors that make future articles match — e.g. "russia ukraine civilian infrastructure attacks". NOT shown to the user.
Rules:
- Order options narrow → broad. Track the CONTINUING story, not one event, so future developments keep matching.
- Ground every option in what the USER said. Do not invent entities they never mentioned; if their request is too vague to anchor (e.g. "the news"), ask one clarifying question instead of guessing.
- Scopes must stay matchable indefinitely. Check the Today date in <context>: NEVER name an already-ended year, season or edition, and prefer an UNDATED scope ("Hungarian Grand Prix updates") over a dated one.
- If the user redirects ("no, the protests themselves"), call proposeTrack AGAIN with re-scoped options.
- Mera can only follow a story here. For anything else (feed tuning, facts, settings) say plainly that this chat only starts a followed story.

## The confirm card
The card the user sees IS the plan: it lists the scopes and they tap ONE. You never apply it for them — a scope is chosen by tapping, never by typing "yes". If they decline, call cancelProposal. If they ask for different scopes, call proposeTrack again.

Keep replies short (≤2 sentences). ${languageRule}${toolSection}`;
}

/** XML tool-call format block for the local (no native tool-calling) path. */
function buildFollowStoryToolFormat(): string {
  return `

## Tools
Write conversational text, then emit tool calls when needed.
Format: <tool_call>{"name": "toolName", "arguments": {...}}</tool_call>

- proposeTrack: {"options": [{"label": string, "search": string}]}
- cancelProposal: {}

## Example (format only)
<tool_call>{"name": "proposeTrack", "arguments": {"options": [{"label": "Attacks on Ukraine infrastructure", "search": "russia ukraine civilian infrastructure attacks"}, {"label": "Russia–Ukraine war", "search": "russia ukraine war"}, {"label": "European security crisis", "search": "europe russia security military tensions"}]}}</tool_call>`;
}

// ---------------------------------------------------------------------------
// Dynamic context (rebuilt every turn)
// ---------------------------------------------------------------------------

export interface FollowStoryContextInput {
  /** Reference "now" (epoch ms), INJECTED by the adapter — this module never
   *  reads the clock, so the rendered prompt stays a pure function of its
   *  inputs. Anchors scopes to the present (no already-ended seasons). */
  nowMs: number;
  /** The single in-flight staged proposal, re-injected every turn so the
   *  one-shot LOCAL path can still resolve a decline. */
  proposal: StagedProposal | null;
}

function trunc(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Epoch-ms → `YYYY-MM-DD` (UTC). UTC, not locale, so the prompt does not drift
 *  with the device timezone. */
function isoDay(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The `<context>` block for the follow-a-story chat. Deliberately tiny: there is
 * no article, no suggestion and no persona to diagnose here, so the only inputs
 * that change the model's behaviour are the date anchor and whether a scope card
 * is already on screen.
 *
 * The user's OTHER followed stories are intentionally NOT listed. Nothing in
 * this flow de-duplicates against them (a free-text follow has no article
 * identity to collide on), so listing them would only spend tokens on a
 * constraint the executor does not enforce.
 */
export function buildFollowStoryContext(input: FollowStoryContextInput): string {
  const { nowMs, proposal } = input;

  const blocks: string[] = [`Today: ${isoDay(nowMs) ?? 'unknown'}`];

  // Only `track_story` actions can be staged here, and a block that named no
  // scopes ("offering: .") would be worse than no block at all — so the gate is
  // on the rendered LABELS, not merely on a proposal being present.
  const labels = (proposal?.actions ?? [])
    .map((a) => (a.type === 'track_story' ? trunc(a.label, PENDING_LABEL_TRUNC) : ''))
    .filter((l) => l.length > 0);
  if (labels.length > 0) {
    blocks.push(
      '## PENDING SCOPE CARD\n'
        + `The user is looking at a card offering: ${labels.join('; ')}.\n`
        + 'They pick one by TAPPING it — do not apply it yourself and do not say the story is being followed yet. If they decline, call cancelProposal.',
    );
  }

  return `<context>\n${blocks.join('\n\n')}\n</context>`;
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI JSON Schema for cloud chat)
// ---------------------------------------------------------------------------

/**
 * The follow-story tool surface: `proposeTrack` + `cancelProposal`.
 *
 * `applyProposal` is deliberately ABSENT. The card this flow stages is always
 * single-select (`chooseOne`), and only `ProposalCard.handleConfirm` knows the
 * user's chosen pill — a model-driven apply would execute EVERY scope and mint
 * three topics plus three followed stories from one "yes". Consent lives in the
 * UI tap, so the tool that could bypass it is not offered at all (and the
 * adapter refuses it a second time if a model invents the name).
 *
 * The sibling surfaces DO offer the tool, so they enforce the same rule at the
 * top of their handler via `proposalRequiresUserChoice`
 * (lib/news-harness/core/proposals.ts) — for a while they did not, and the
 * article Track surface applied all three pills on a typed "yes".
 */
export function getFollowStoryToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'proposeTrack',
        description:
          'Propose following the story the user described, as a durable topic. Never follows directly — stages a card the user taps. Give 3–4 `options` at widening scope (narrow event → broad ongoing story), each a scope pill with a short display `label` and a hidden lowercase `search` retrieval query. Ground every option in what the USER said; there is no article in this conversation.',
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
                '3–4 scope pills ordered narrow → broad, grounded ONLY in what the user asked to follow.',
            },
          },
          required: ['options'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancelProposal',
        description: 'Discard the pending scope card when the user declines.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
}
