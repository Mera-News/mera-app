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
  /** CLOUD only — LOCAL has no retrieval tools at all, so it must not be told
   *  to use them. Part of the caller's prompt CACHE KEY. */
  canSearch?: boolean;
  /** The user's "Web search in chat" setting. Also part of the cache key: a
   *  prompt cached while it was off keeps telling the model it cannot search
   *  after the user turns it on, which is a reported bug, not a hypothetical. */
  webSearch?: boolean;
}): string {
  const { needsToolFormat, languageName, canSearch = false, webSearch = false } = params;

  const languageRule = languageName
    ? `LANGUAGE: ALWAYS write conversational text in **${languageName}**, with no exceptions — even if the user writes in another language. Scope labels and search queries stay English.`
    : "LANGUAGE: Match the user's language (switch if they switch). Scope labels and search queries stay English.";

  const toolSection = needsToolFormat ? buildFollowStoryToolFormat() : '';

  // THE FIX FOR THE REFUSAL. Without retrieval this agent had no article, no
  // index and a rule against inventing entities, so a user naming anything
  // recent left it with "ask again" or "I cannot help" as its only compliant
  // moves — and it picked the second often enough to be reported as a bug.
  const searchTools = webSearch ? 'searchNews (and webSearch if it finds nothing)' : 'searchNews';
  const lookupStep = canSearch ? `look it up with ${searchTools} unless you are already sure what it is, then ` : '';
  const groundingSuffix = canSearch ? ' and in what your searches returned' : '';
  const unrecognisedSuffix = canSearch
    ? ': search for it first, and scope it from the headlines you get back'
    : ': ask them for one detail that pins it down (who, where, or what happened)';
  const lookupSection = canSearch
    ? `

## Looking the story up first
You have no article and no memory of this week's news, so a story the user names may be one you have never seen. Search before you scope.
- searchNews FIRST. It searches Mera's own index, which is the coverage a followed story will actually match, so its headlines tell you which entity names belong in a "search" scope.${webSearch ? '\n- webSearch only when searchNews came back with nothing useful. It confirms what a story is called and who is in it; it cannot tell you what Mera can retrieve. Put every query you need into ONE call — they run at the same time.' : ''}
- Then propose scopes built from the names you actually saw in those results.
- If both come back empty, say plainly that you could not find recent coverage and ask the user for one detail that pins it down. Do NOT say you do not understand them.`
    : '';

  return `You are Mera, helping the user start FOLLOWING a news story.

## The one thing you do here
The user came from their Followed stories screen and wants to follow something new. There is NO article in this conversation — only what the user tells you.
1. The FIRST message on this screen is always a request to follow a story, even when it names nothing ("I want to follow a story"). It is never a question you cannot help with. Answer it with ONE short question: what story or subject should Mera follow?
2. As soon as they name something, ${lookupStep}call proposeTrack with 3–4 scope OPTIONS at widening scope (the narrow specific event → the broad ongoing story) so they can pick how much of it to follow.
3. Never claim a story is being followed until the user picks a scope on the card.${lookupSection}

## Following a story (the proposeTrack tool)
Each option has TWO fields:
- "label": the SHORT display name shown to the user (${MAX_TRACK_LABEL_WORDS} words or fewer, Title Case, no trailing punctuation). Generic and recognisable — e.g. "Russia–Ukraine war".
- "search": a short retrieval query (${MAX_TRACK_SEARCH_WORDS} words or fewer) with the concrete who / what / where entity anchors that make future articles match — e.g. "Russia Ukraine civilian infrastructure attacks". NOT shown to the user.
Rules:
- Order options narrow → broad. Track the CONTINUING story, not one event, so future developments keep matching.
- Ground every option in what the USER said${groundingSuffix}. Do not invent entities from memory; if their request names no subject at all (e.g. "the news"), ask one clarifying question instead of guessing.
- If they name something you do not recognise, that is not a reason to refuse${unrecognisedSuffix}.
- ONE incident in ONE place: keep that venue, street, building or town name inside "search" — it is the anchor that stops the scope matching every other story nearby. A place is not a date, so the scope still stays undated.
- KEEP THE CAPITALS on proper nouns in "search" (sentence case, never lowercase): retrieval recognises a place by its capital letter, so an all-lowercase query cannot be filtered by place and pulls the right subject from the wrong town.
- Scopes must stay matchable indefinitely. Check the Today date in <context>: NEVER name an already-ended year, season or edition, and prefer an UNDATED scope ("Hungarian Grand Prix updates") over a dated one.
- If the user redirects ("no, the protests themselves"), call proposeTrack AGAIN with re-scoped options.
- Mera can only follow a story here. If the user asks for something genuinely different (feed tuning, facts, settings) say plainly that this chat only starts a followed story. Naming a story you have not heard of is NOT one of those cases.

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
<tool_call>{"name": "proposeTrack", "arguments": {"options": [{"label": "Attacks on Ukraine infrastructure", "search": "Russia Ukraine civilian infrastructure attacks"}, {"label": "Russia–Ukraine war", "search": "Russia Ukraine war"}, {"label": "European security crisis", "search": "Europe Russia security military tensions"}]}}</tool_call>`;
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
/**
 * `searchNews` — Mera's OWN index, and the PRIMARY grounding tool here.
 *
 * It is first for a reason that is not preference: `proposeTrack`'s `search`
 * field has to be a query Mera's retrieval can actually match, and the articles
 * this returns ARE that corpus. A web result is a URL on someone else's site;
 * it can tell the model a story exists, but it cannot tell it which words will
 * keep matching future coverage. CLOUD only, like its siblings — the LOCAL turn
 * never pushes a `role:'tool'` message back, so a search the model can never
 * read is strictly worse than no tool.
 */
const SEARCH_NEWS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'searchNews',
    description:
      "Search Mera's own news index (last 48 hours) for real articles about a subject. Use it BEFORE proposing scopes whenever you are not certain what the user is referring to, or when they name something recent: the headlines it returns are the coverage a followed story will match, so they tell you which entity names belong in a scope. Returns HEADLINES ONLY — no article text and no link.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms, in English.' },
      },
      required: ['query'],
    },
  },
};

/**
 * `webSearch` — the FALLBACK grounding tool, behind the user's "Web search in
 * chat" toggle. Declared only when that toggle is on: the gate is on the
 * DECLARATION as well as in the handler, and both are load-bearing (a persisted
 * conversation can replay a call made while the toggle was on).
 *
 * Second to `searchNews` because a Brave hit does not tell you what Mera can
 * retrieve. It answers "does this story exist and what is it called", which is
 * exactly what the model needs when the last 48 hours of Mera's index have
 * nothing and it would otherwise refuse.
 */
const WEB_SEARCH_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'webSearch',
    description:
      "Search the public web when Mera's own index has nothing on what the user named and you would otherwise be guessing. Use it to find out what the story is actually called and who is involved, then propose scopes from that. Only the search words are sent — never the user's facts or feed.",
    parameters: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Up to 4 search queries, 2-200 characters each. Put EVERYTHING you need to look up in this ONE call: they are searched at the same time. Never search one thing, read the result, and then search the next.',
        },
      },
      required: ['queries'],
    },
  },
};

/**
 * @param mode LOCAL gets the proposal tools only — see SEARCH_NEWS_TOOL.
 * @param webSearchEnabled the user's "Web search in chat" setting.
 */
export function getFollowStoryToolDefinitions(
  mode: 'CLOUD' | 'LOCAL' = 'CLOUD',
  webSearchEnabled: boolean = false,
): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'proposeTrack',
        description:
          'Propose following the story the user described, as a durable topic. Never follows directly — stages a card the user taps. Give 3–4 `options` at widening scope (narrow event → broad ongoing story), each a scope pill with a short display `label` and a hidden `search` retrieval query. Ground every option in what the USER said; there is no article in this conversation.',
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
                      'Hidden retrieval query with concrete who/what/where anchors (≤8 words, e.g. "Russia Ukraine civilian infrastructure attacks"). Sentence case, proper nouns KEEP their capitals — retrieval recognises a place by its capital letter. NOT shown to the user.',
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
    ...(mode === 'CLOUD' ? [SEARCH_NEWS_TOOL] : []),
    ...(mode === 'CLOUD' && webSearchEnabled ? [WEB_SEARCH_TOOL] : []),
  ];
}
