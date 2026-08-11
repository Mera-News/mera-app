// news-harness — the FactCheckAgent's portable brain (PURE, RN-free).
//
// The "fact-check this" chat started from an article's tick action. It is a
// literal clone of the follow-story flow, one field wider: instead of proposing
// SCOPES to follow, it proposes CLAIMS to check. Same machinery end to end —
// `proposeFactCheck` → StagedProposal of `fact_check_claim` actions →
// ProposalCard single-select pills → executeProposalActions → enqueueFactCheck.
//
// Why a clone rather than an inline sheet: the propose-then-tap card is already
// the app's one consent seam for "the model suggests, the user chooses". A check
// costs a search round-trip plus a thinking synthesis, so it must never start
// without a tap; reusing this path gets that for free, along with the resume
// path (deriveThreadItems) and the persisted-tool-call round trip.
//
// What is genuinely new here is the CONVERSATION: a system prompt that
// decomposes a headline + summary into separately checkable assertions, and a
// <context> carrying the article snapshot. Everything structural is modelled 1:1
// on lib/news-harness/article-feedback/agent-core.ts's
// parseTrackScopeOptions / decideProposeTrack.
//
// Everything that touches WatermelonDB, Zustand, the logger or any expo/RN
// module stays in lib/llm/agents/FactCheckAgent.ts. This module never reads the
// clock — `nowMs` is injected — so the rendered prompt is a pure function of its
// inputs and the golden-prompt tests stay deterministic.

import type {
  FactCheckSubject,
  ProposalAction,
  StagedProposal,
  ToolDefinition,
  ToolExecutionResult,
} from '../core/types';

/** Hard caps enforced by the PARSER (the prompt states softer word targets). */
const MAX_CLAIM_CHARS = 300;
const MAX_LABEL_CHARS = 80;
/** Ceiling on staged options — matches the follow-story card's 4 pills. */
const MAX_CLAIM_OPTIONS = 4;
/** Prompt guidance only. */
const MAX_LABEL_WORDS = 6;
/** Truncation applied to the article summary rendered into <context>. */
const DESCRIPTION_TRUNC = 900;
const TITLE_TRUNC = 300;
/** Display cap on a pending pill label rendered back into <context>. */
const PENDING_LABEL_TRUNC = 80;

/**
 * `originSurface` stamped on a fact check started from an article's tick.
 * Distinct from the feedback surfaces so the origin of a check stays legible in
 * the persisted row.
 */
export const FACT_CHECK_SURFACE = 'fact-check-chat';

// ---------------------------------------------------------------------------
// The article snapshot
// ---------------------------------------------------------------------------

/** The article a fact-check chat is about, as the pure layer sees it. Plain
 *  strings only — the RN adapter reads these off the suggestion/article row. */
export interface FactCheckArticleInput {
  articleId: string;
  title: string;
  description?: string | null;
  url?: string | null;
  publicationName?: string | null;
}

/**
 * The origin snapshot every staged claim carries. Its fields map 1:1 onto
 * `enqueueFactCheck`'s parameters so the executor can hand it straight through.
 *
 * Deliberately NOT `TrackFeedbackSubject`: that carries `title`, this carries
 * `articleTitle`, and the near-miss would typecheck into a call with an empty
 * title. Two shapes with different consumers stay two shapes.
 */
export function makeFactCheckSubject(article: FactCheckArticleInput): FactCheckSubject {
  return {
    surface: FACT_CHECK_SURFACE,
    articleId: article.articleId ?? '',
    articleTitle: (article.title ?? '').trim(),
    ...(article.url ? { articleUrl: article.url } : {}),
    ...(article.publicationName ? { publicationName: article.publicationName } : {}),
  };
}

// ---------------------------------------------------------------------------
// System prompt — THE deliverable
// ---------------------------------------------------------------------------
//
// MEASURED, and two "obvious improvements" REJECTED on the evidence. Replay with
// `harness-local/scripts/replay-fact-check-claims.ts` (real gateway model, real
// wire shape) before changing a word of this.
//
// Null experiment (this prompt, unchanged, 5 runs over 6 fixtures) — the noise
// floor, established BEFORE anything was attributed to an edit:
//   - the tool fires 5/5 on every real-news fixture; option counts are stable
//     (4/4/4/4/4, 2/2/2/2/2, 4/4/4/4/3, 3/2/3/3/4, 1/1/1/1/1);
//   - but only ~50% of the claims recur across ALL FIVE runs (lexical match).
//     Individual claim wording is noisy even with identical input, so no single
//     run — and no single article — can support a conclusion about a prompt edit.
//   - on a pure opinion column the tool correctly stays silent 9 runs in 10.
//
// Two edits were then tried against that floor, both aimed at the 1-in-10 false
// fire, both measured at n=10 on that fixture:
//   - v2: the opinion ban restated as an explicit "could an organisation publish
//     True or False on this sentence?" TEST, plus "an empty card is a CORRECT
//     answer" → 2/10 fired, and one fire was a NEW failure mode v1 never
//     produced: it turned the decline itself into a card option ("Nothing
//     checkable :: The article contains no factual assertion…").
//   - v3: v2 plus an explicit "call NO TOOL AT ALL / never make the absence of a
//     claim an option", in the prompt AND in the tool description → 4/10 fired,
//     the banned degenerate option appeared ANYWAY, and two fires staged the
//     column's own value judgement ("cycle lanes are the best thing to happen to
//     this town in years") — the exact thing the added rules forbade.
//
// So: more prose about when NOT to call the tool made the model call it more,
// and the rules it violated were the ones written most emphatically. 1/10 vs
// 4/10 at n=10 is not significant either way — the honest reading is that none
// of the three variants is distinguishable, which is itself the finding: this
// surface is not improvable by adding prompt pressure, and the shipped text is
// the one the null experiment was actually run on.

export function buildFactCheckSystemPrompt(params: {
  needsToolFormat: boolean;
  languageName?: string;
}): string {
  const { needsToolFormat, languageName } = params;

  // Same split as the follow-story / article-feedback surfaces: conversational
  // text follows the reader, structured payloads stay English. Here the payload
  // reason is concrete rather than stylistic — `claim` is the retrieval key that
  // gets sent to the ClaimReview index and to web search, whose corpora are
  // overwhelmingly English, so a translated claim would simply not match.
  const languageRule = languageName
    ? `LANGUAGE: ALWAYS write conversational text in **${languageName}**, with no exceptions — even if the user writes in another language. Claim labels and claim texts stay ENGLISH: they are search keys, not prose.`
    : "LANGUAGE: Match the user's language (switch if they switch). Claim labels and claim texts stay ENGLISH: they are search keys, not prose.";

  const toolSection = needsToolFormat ? buildFactCheckToolFormat() : '';

  return `You are Mera, helping the user fact-check a news story.

## The one thing you do here
The user tapped the fact-check tick on the article in <context>. Your job is to work out WHICH claims in it can actually be checked, and offer them as options.
1. Read the headline and the summary. Pick out the SEPARATELY CHECKABLE factual assertions.
2. Call proposeFactCheck with 2–4 options, one assertion each. Do this on your FIRST turn — do not ask permission first. Offer only as many as the article really contains: two good options beat four padded ones.
3. If the user types a claim of their own instead, call proposeFactCheck with exactly ONE option built from what they typed.
4. You do NOT decide whether anything is true. You never say a claim is true, false, misleading or debunked, and you never say what a fact-checker found. Checking happens after the user taps an option.

## What counts as a checkable claim (the proposeFactCheck tool)
Each option has TWO fields:
- "label": the SHORT pill text shown to the user (${MAX_LABEL_WORDS} words or fewer, no trailing punctuation) — the distinguishing part of the claim, e.g. "80 vaccines by age 18".
- "claim": ONE self-contained sentence a person could search for WITHOUT ever seeing this article. Name the who / what / where / when explicitly — never "he", "the report", "this study", "the minister". E.g. "Children in the United States receive 80 different vaccines by the age of 18."
Rules:
- ONE assertion per option, and ONE DATUM per card. The commonest mistake is splitting a single fact into several pills by re-expressing it. "Delhi's AQI crossed 450" and "Delhi's air was the worst in five years" are ONE claim, because 450 IS the worst-in-five-years reading. "Inflation fell to 4.2%" and "the government reported inflation fell to 4.2%" are ONE claim. "Liverpool won 2-1" and "Liverpool went top of the table" are ONE claim when the article says the win put them top. Before you add an option, ask what NEW fact it would send to a fact-checker that the options above it do not already send — if the answer is none, do not add it. Also never bundle two assertions into one option with "and".
- Only assertions a fact-checking organisation could plausibly have published on: a specific number, a dated event, an attribution, a statistic, a causal or historical statement. NEVER an opinion, a value judgement, a prediction about the future, a plan, an intention, or anything phrased as a question.
- When someone is QUOTED making an assertion, the checkable claim is the ASSERTION ITSELF, not that they said it. "RFK Jr. said children get 80 vaccines" is a claim about a speech; "children get 80 vaccines by age 18" is the one that gets checked.
- Use ONLY what is in <context>. Never add a number, name, date or place the article did not give you, and never soften or sharpen a figure. If the article says "dozens", your claim says "dozens".
- If the summary is missing and you only have the headline, still propose — but propose FEWER (2 or 3) rather than inventing the detail a summary would have carried.
- If nothing in the article is a factual assertion at all (a pure opinion column, a listings page, a preview of something that has not happened yet), do NOT call proposeFactCheck. Say in one sentence that there is nothing here a fact-checker could rule on, and ask whether there is a specific claim they had in mind. Never manufacture a controversy to fill the card.
- Order options by how likely they are to have been checked: the contested, quantified, widely-repeated claim first; the incidental detail last.

## The confirm card
The card the user sees IS the plan: it lists the claims and they tap ONE. You never start a check for them — a claim is chosen by tapping, never by typing "yes". If they decline, call cancelProposal. If they want a different claim, call proposeFactCheck again with re-picked options.
After you call the tool, say ONE short sentence pointing at the card. Do not restate the claims in prose.

Keep replies short (≤2 sentences). ${languageRule}${toolSection}`;
}

/** XML tool-call format block for the local (no native tool-calling) path. */
function buildFactCheckToolFormat(): string {
  return `

## Tools
Write conversational text, then emit tool calls when needed.
Format: <tool_call>{"name": "toolName", "arguments": {...}}</tool_call>

- proposeFactCheck: {"options": [{"label": string, "claim": string}]}
- cancelProposal: {}

## Example (format only)
<tool_call>{"name": "proposeFactCheck", "arguments": {"options": [{"label": "80 vaccines by age 18", "claim": "Children in the United States receive 80 different vaccines by the age of 18."}, {"label": "Autism rate of 1 in 31", "claim": "One in 31 children in the United States is diagnosed with autism."}, {"label": "Vaccine schedule tripled since 1986", "claim": "The number of vaccine doses on the US childhood immunisation schedule has tripled since 1986."}]}}</tool_call>`;
}

// ---------------------------------------------------------------------------
// Dynamic context (rebuilt every turn)
// ---------------------------------------------------------------------------

export interface FactCheckContextInput {
  /** Reference "now" (epoch ms), INJECTED by the adapter — this module never
   *  reads the clock. Anchors "has this already happened?" judgements. */
  nowMs: number;
  /** The article the tick was tapped on. */
  article: FactCheckArticleInput;
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
 * The `<context>` block for the fact-check chat.
 *
 * The missing-summary case is rendered EXPLICITLY rather than by omitting the
 * line. An absent field reads to a model as "not relevant"; a line that says the
 * summary is unavailable is the thing the system prompt's headline-only rule can
 * actually key on. Reading the article URL is deliberately out of scope, so the
 * url is not even offered here — it travels on the subject for the runner's
 * citation, never as something to fetch.
 */
export function buildFactCheckContext(input: FactCheckContextInput): string {
  const { nowMs, article, proposal } = input;

  const title = trunc(article.title ?? '', TITLE_TRUNC);
  const description = trunc(article.description ?? '', DESCRIPTION_TRUNC);
  const publication = (article.publicationName ?? '').trim();

  const articleLines = [
    '## ARTICLE',
    `Headline: ${title || '(none)'}`,
    ...(publication ? [`Publication: ${publication}`] : []),
    description
      ? `Summary: ${description}`
      : 'Summary: NONE — you have the headline only. Propose 2–3 claims from the headline alone and invent no detail it does not contain.',
  ];

  const blocks: string[] = [`Today: ${isoDay(nowMs) ?? 'unknown'}`, articleLines.join('\n')];

  // Only `fact_check_claim` actions can be staged here, and a block naming no
  // claims ("offering: .") would be worse than no block — so the gate is on the
  // rendered LABELS, not merely on a proposal being present.
  const labels = (proposal?.actions ?? [])
    .map((a) => (a.type === 'fact_check_claim' ? trunc(a.label, PENDING_LABEL_TRUNC) : ''))
    .filter((l) => l.length > 0);
  if (labels.length > 0) {
    blocks.push(
      '## PENDING CLAIM CARD\n'
        + `The user is looking at a card offering: ${labels.join('; ')}.\n`
        + 'They pick one by TAPPING it — do not start a check yourself and do not report any finding yet. If they decline, call cancelProposal.',
    );
  }

  return `<context>\n${blocks.join('\n\n')}\n</context>`;
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI JSON Schema for cloud chat)
// ---------------------------------------------------------------------------

/**
 * The fact-check tool surface: `proposeFactCheck` + `cancelProposal`.
 *
 * `applyProposal` is deliberately ABSENT, for the same reason FollowStoryAgent
 * omits it: the card is single-select, only ProposalCard.handleConfirm knows
 * which claim the user tapped, and a model-driven apply would enqueue every
 * claim on one typed "yes" — four background jobs from one word. Consent is the
 * tap, so the tool that could bypass it is not offered (and the adapter refuses
 * it a second time if a model invents the name).
 */
export function getFactCheckToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'proposeFactCheck',
        description:
          'Offer the user 3–4 separately checkable claims drawn from this article, as a card they tap ONE of. Never checks anything directly and never reports a finding. Each option is one assertion: a short display `label` for the pill plus a self-contained English `claim` sentence that can be searched without the article. If the user typed their own claim, pass exactly one option built from it.',
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
                      'Short pill text shown to the user (≤6 words, no trailing punctuation) — the distinguishing part of the claim, e.g. "80 vaccines by age 18".',
                  },
                  claim: {
                    type: 'string',
                    description:
                      'ONE self-contained English sentence naming who/what/where/when, searchable without the article. No pronouns, no "the report says". E.g. "Children in the United States receive 80 different vaccines by the age of 18."',
                  },
                },
                required: ['label', 'claim'],
              },
              description:
                '2–4 options (or exactly 1 when the user typed their own claim), one assertion each and one DATUM per card, ordered most-likely-checked first. Never pad: an option that sends no new fact to a fact-checker must not be added. Never an opinion, a prediction or a question.',
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
        description: 'Discard the pending claim card when the user declines.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Pure parsing + staging (modelled 1:1 on parseTrackScopeOptions /
// decideProposeTrack in article-feedback/agent-core.ts)
// ---------------------------------------------------------------------------

/** One claim pill: the shown `label` + the searchable `claim` sentence. */
export interface FactCheckClaimOption {
  label: string;
  claim: string;
}

/**
 * Parse the LLM's raw `proposeFactCheck` options into clean claim pills. Accepts
 * the structured shape (`[{ label, claim }]`) and tolerates a bare string option
 * (`"claim text"` → the claim, with the label derived from it). Drops entries
 * with no usable claim, trims to the hard caps, and dedupes by CLAIM
 * (case-insensitive) — not by label, because two pills that differ only in
 * wording of the pill but check the same sentence are one option, and the claim
 * is the thing the runner keys on. Capped at MAX_CLAIM_OPTIONS.
 *
 * Shared by the live path (decideProposeFactCheck) and the resume path
 * (deriveFactCheckProposal) so both rebuild identical actions.
 */
export function parseFactCheckClaimOptions(raw: unknown): FactCheckClaimOption[] {
  if (!Array.isArray(raw)) return [];
  const out: FactCheckClaimOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let label = '';
    let claim = '';
    if (typeof entry === 'string') {
      claim = entry.trim();
    } else if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      label = typeof rec.label === 'string' ? rec.label.trim() : '';
      claim = typeof rec.claim === 'string' ? rec.claim.trim() : '';
    }
    // The CLAIM is load-bearing (it is what gets checked); the label is display
    // only, so a missing one falls back to the claim rather than dropping the
    // option. A missing claim, by contrast, has nothing to check.
    if (!claim) continue;
    if (!label) label = claim;
    const key = claim.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: trunc(label, MAX_LABEL_CHARS), claim: trunc(claim, MAX_CLAIM_CHARS) });
    if (out.length >= MAX_CLAIM_OPTIONS) break;
  }
  return out;
}

/**
 * Pure decision for the `proposeFactCheck` tool: parses the LLM's claim
 * `options` into `fact_check_claim` actions, each carrying the caller's article
 * `subject` snapshot. The subject + the parsed options are echoed in the result
 * so deriveFactCheckProposal can rebuild the exact confirmable proposal from the
 * persisted tool call (no store read).
 *
 * ≥2 pills → a single-select card. A LONE option is deliberately NOT
 * `chooseOne`: that is the "the user typed their own claim" path, and
 * `proposalRequiresUserChoice` (core/proposals.ts) reads a one-action chooseOne
 * as false anyway — matching decideProposeTrack rather than inventing a second
 * rule. The consent guarantee for the single case comes from
 * `USER_CONFIRMED_ONLY_ACTIONS`, which refuses `fact_check_claim` from any
 * non-tap caller.
 *
 * Returns an error result when no valid option survives parsing.
 */
export function decideProposeFactCheck(
  args: Record<string, unknown>,
  subject: FactCheckSubject,
): ToolExecutionResult {
  // Accept the structured `options`; tolerate a lone `claim` string so an older
  // or sloppier model output still stages something checkable.
  const rawOptions =
    Array.isArray(args.options) && args.options.length > 0
      ? args.options
      : typeof args.claim === 'string' && args.claim.trim()
        ? [args.claim]
        : [];
  const options = parseFactCheckClaimOptions(rawOptions);
  if (options.length === 0) return { result: { error: 'options is required' } };

  const id = `factcheck-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const actions: ProposalAction[] = options.map((o) => ({
    type: 'fact_check_claim',
    label: o.label,
    claim: o.claim,
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
