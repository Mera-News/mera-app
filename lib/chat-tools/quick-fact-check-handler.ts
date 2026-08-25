// quickFactCheck — the QUICK path's tool handler, plus the tap that starts it.
//
// WHAT IT IS. The user taps one claim pill on the fact-check card and Confirms.
// This runs Brave-only web search rounds (never the claim verbatim — see
// `buildSearchQueries`) and one LOW-TEMPERATURE synthesis over numbered
// evidence, then answers IN THE CHAT THREAD. That is the whole feature: *here is
// what the web says right now*.
//
// TWO SUBTRACTIONS from the runner it reuses, and both are load-bearing:
//   1. NO ClaimReview lookup. Attributing a rating to a fact-checking
//      organisation is the SERVER path's job and only its job, because that
//      attribution comes from an index only the server queries. A quick answer
//      that said "Alt News rated this False" would blur the two speeds this
//      feature is built on.
//   2. NO PERSISTENCE. The answer is chat-only and ephemeral. It is NEVER
//      written to the `fact_checks` table — that table and the Dashboard list
//      are exclusively for server-checked results, so "in the Dashboard"
//      reliably means *properly checked, with sources*.
//
// WHY THE MODEL DOES NOT NARRATE THE RESULT. The obvious wiring — hand this back
// to the chat model as a tool result and let it write the sentence — puts an
// UNGUARDED hop between the evidence and the reader, and it is precisely the hop
// where "we could not search" turns into "I found nothing about that". The
// requirement is that an unavailable search can never produce a found-nothing
// answer; a requirement enforced by prompt wording at the last hop is not
// enforced at all, and a test of the handler's return value would pass while the
// user read the opposite. So the OUTCOME decided here is what the card renders,
// through the single mapping in `quickFactCheckCopyKey`, and the test asserts on
// that mapping rather than on a model's willingness to obey.
//
// This is why `proposeFactCheck` is a model tool and `quickFactCheck` is not:
// the model chooses WHAT could be checked, the user chooses WHICH, and neither
// the model nor a typed "yes" can start or narrate the check.

import { cloudComplete } from '../llm/cloudComplete';
import { BIG_MODEL } from '../llm/constants';
import {
  ENOUGH_EVIDENCE,
  MAX_EVIDENCE_IN_PROMPT,
  MIN_SEARCH_ROUNDS,
  SYNTHESIS_DEADLINE_MS,
  buildSearchQueries,
  buildSynthesisMessages,
  clampVerdictToEvidence,
  parseSynthesis,
  resolveCitations,
  type FactCheckCitationPayload,
  type FactCheckClaimPayload,
} from '../fact-check/fact-check-runner';
import {
  searchWeb,
  searchWebBatch,
  type WebSearchResult,
} from '../web-search/web-search-client';
import logger from '../logger';
import type { ProposalAction } from '../llm/types';

/**
 * THE FOUR OUTCOMES, and the two that must never collapse into one.
 *
 * `searched-empty` and `search-unavailable` both end with zero evidence and mean
 * opposite things: one is a real answer about the world ("the index has nothing
 * on this"), the other is an admission ("we did not look"). The gateway contract
 * is what tells them apart — `200 + []` searched, `503 search-unavailable` did
 * not — so this branch keys on whether ANY round returned `ok`, never on how
 * many results came back.
 */
export type QuickFactCheckOutcome =
  | 'answered'
  | 'searched-empty'
  | 'search-unavailable'
  | 'synthesis-failed';

export interface QuickFactCheckAnswer {
  outcome: QuickFactCheckOutcome;
  /** Closed verdict vocabulary, and ONLY on `answered`. Every other outcome
   *  carries null: a verdict with no evidence behind it is the fabricated
   *  all-clear this whole design exists to prevent. */
  verdict: string | null;
  summary: string | null;
  claims: FactCheckClaimPayload[];
  citations: FactCheckCitationPayload[];
  /** Evidence items that reached the prompt — the citation index space. */
  evidenceCount: number;
}

export interface QuickFactCheckInput {
  claim: string;
  articleTitle?: string | null;
  publicationName?: string | null;
}

export interface QuickFactCheckDeps {
  searchWeb: typeof searchWeb;
  searchWebBatch: typeof searchWebBatch;
  complete: (req: {
    systemPrompt: string;
    prompt: string;
    model: string;
    temperature: number;
    maxTokens: number;
  }) => Promise<string>;
  now: () => number;
}

const defaultDeps: QuickFactCheckDeps = {
  searchWeb,
  searchWebBatch,
  complete: (req) => cloudComplete(req),
  now: () => Date.now(),
};

/** Output budget for the synthesis. Same as the old runner's — the JSON object
 *  carries a summary plus up to four sub-assertions. */
const SYNTHESIS_MAX_TOKENS = 1200;

/**
 * The locale key the CARD renders for an answer.
 *
 * The single mapping from outcome to user-visible copy, exported so the
 * "unavailable must never read as found-nothing" rule is testable at the exact
 * seam where text is chosen. Adding an outcome without adding a key here is a
 * type error, and pointing two outcomes at one key is what the test forbids.
 */
export function quickFactCheckCopyKey(answer: QuickFactCheckAnswer): string {
  switch (answer.outcome) {
    case 'answered':
      return 'factCheck.quickAnswered';
    case 'searched-empty':
      // WE SEARCHED. The index had nothing. A real answer about the world.
      return 'factCheck.quickNothingFound';
    case 'search-unavailable':
      // WE DID NOT SEARCH. Must never read as the line above.
      return 'factCheck.quickCouldNotSearch';
    case 'synthesis-failed':
      return 'factCheck.quickFailed';
  }
}

/**
 * Run one quick check. Never throws.
 *
 * Ordering is load-bearing, exactly as it was in the runner it descends from:
 * every zero-evidence exit happens BEFORE the model is called, so there is no
 * path on which an answer with nothing behind it carries a verdict.
 */
export async function handleQuickFactCheck(
  input: QuickFactCheckInput,
  overrides: Partial<QuickFactCheckDeps> = {},
): Promise<QuickFactCheckAnswer> {
  const deps: QuickFactCheckDeps = { ...defaultDeps, ...overrides };
  const claim = (input.claim ?? '').trim();
  const empty = (outcome: QuickFactCheckOutcome): QuickFactCheckAnswer => ({
    outcome,
    verdict: null,
    summary: null,
    claims: [],
    citations: [],
    evidenceCount: 0,
  });
  if (!claim) return empty('search-unavailable');

  // ── Search rounds ────────────────────────────────────────────────────────
  //
  // THE FIRST `MIN_SEARCH_ROUNDS` GO OUT TOGETHER, THE REST STAY CONDITIONAL.
  // Those rounds always run (see MIN_SEARCH_ROUNDS: one round already clears
  // ENOUGH_EVIDENCE, so without the floor rounds 2 and 3 would be dead code),
  // which means running them one after another buys nothing but wall clock —
  // and this is the path the user sits and watches. Batching them costs the
  // same two Brave requests and one shared-limiter grant instead of two.
  //
  // Round 3 is NOT batched with them. It is genuinely conditional — it only
  // runs when the first two came back thin — so folding it in would turn a
  // search we usually skip into one we always bill.
  const evidence: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  let okRounds = 0;
  const collect = (results: WebSearchResult[]) => {
    for (const r of results) {
      if (!r?.url || seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);
      evidence.push(r);
    }
  };

  const queries = buildSearchQueries(claim, input.articleTitle);
  const upfront = queries.slice(0, MIN_SEARCH_ROUNDS);
  const conditional = queries.slice(MIN_SEARCH_ROUNDS);

  if (upfront.length > 0) {
    const batch = await deps.searchWebBatch(upfront);
    if (batch.ok) {
      for (const entry of batch.searches) {
        // An entry with `error` was never looked up. Counting it as a
        // successful round is exactly how "we could not look" turns into
        // "nobody has published on this".
        if (entry.error !== undefined) continue;
        okRounds++;
        collect(entry.results ?? []);
      }
    }
  }

  for (const query of conditional) {
    if (evidence.length >= ENOUGH_EVIDENCE) break;
    const outcome = await deps.searchWeb(query);
    if (!outcome.ok) continue;
    okRounds++;
    collect(outcome.results);
  }

  // NOT "no results" — no successful ROUND. Zero of our searches reached the
  // provider, so we know nothing at all and must not pretend otherwise. This is
  // the branch the must-fail test drives.
  if (okRounds === 0) return empty('search-unavailable');
  // We asked, and the index had nothing. A real answer, and a different one.
  if (evidence.length === 0) return empty('searched-empty');

  // ── Synthesis ────────────────────────────────────────────────────────────
  // ONE array from here on: the prompt's numbering, the citation index space and
  // `resolveCitations` must all index the SAME list, or "citation [7]" resolves
  // to a page the model never saw.
  const shortlist = evidence.slice(0, MAX_EVIDENCE_IN_PROMPT);
  const messages = buildSynthesisMessages(
    claim,
    shortlist,
    input.articleTitle,
    input.publicationName,
  );
  const systemPrompt = typeof messages[0]?.content === 'string' ? messages[0].content : '';
  const prompt = typeof messages[1]?.content === 'string' ? messages[1].content : '';

  let answer: string;
  try {
    answer = await withDeadline(
      deps.complete({
        systemPrompt,
        prompt,
        // NON-STREAMING and thinking-OFF, unlike the old background runner's
        // `cloudChatStream` (which hardcodes `enable_thinking: true`). Nothing
        // renders until the answer is whole, so a stream buys nothing here, and
        // a reasoning trace is tens of seconds the user spends staring at a
        // spinner. Temperature 0 for the same reason it was 0 there: this is an
        // extraction, not prose.
        model: BIG_MODEL,
        temperature: 0,
        maxTokens: SYNTHESIS_MAX_TOKENS,
      }),
      SYNTHESIS_DEADLINE_MS,
      deps.now,
    );
  } catch (err) {
    logger.warn('[quick-fact-check] synthesis failed', { error: String(err) });
    // A model failure is not a fact about the claim.
    return empty('synthesis-failed');
  }

  const parsed = parseSynthesis(answer, shortlist.length);
  return {
    outcome: 'answered',
    // THE STRUCTURAL GUARD, kept: with no evidence the model's answer is
    // discarded rather than trusted. Unreachable from here (we returned above on
    // an empty shortlist) and kept anyway, because the day someone reorders
    // these branches is the day it earns its keep.
    verdict: clampVerdictToEvidence(parsed.verdict, shortlist.length),
    summary: parsed.summary,
    claims: parsed.claims,
    // Indices only. A number the evidence list cannot resolve is dropped, which
    // is what makes a fabricated source impossible rather than unlikely.
    citations: resolveCitations(parsed.citationIndices, shortlist),
    evidenceCount: shortlist.length,
  };
}

/**
 * Rejects if `work` outlives `ms`.
 *
 * The timer is CLEARED in a `finally`, not merely left to fire into an unraced
 * promise: an uncleared one keeps the JS timer queue alive for the full deadline
 * after a fast answer, which in a test run reads as "Jest did not exit" and on
 * device is a needless wakeup.
 */
function withDeadline<T>(work: Promise<T>, ms: number, now: () => number): Promise<T> {
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`quick fact check timed out after ${now() - started}ms`)),
        ms,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// The tap
// ───────────────────────────────────────────────────────────────────────────

/**
 * Start the check the user tapped, and put its answer in the thread.
 *
 * Fire-and-forget by design: it registers the entry FIRST (so the card appears
 * immediately, in its running state) and settles it when the work finishes. The
 * Confirm button must not sit disabled for the length of a search round.
 *
 * `mode: 'article'` is the always-last pill: it hands the whole article to the
 * SERVER check and says so. Nothing about it is quick, and nothing about it is
 * ephemeral — that request is exactly the one whose result the Dashboard
 * carries.
 */
export function startFactCheckFromAction(action: ProposalAction): void {
  if (action.type !== 'fact_check_claim') return;
  const { useFloatingChatStore } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../stores/floating-chat-store') as typeof import('../stores/floating-chat-store');
  const store = useFloatingChatStore.getState();
  const id = `qfc-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  if (action.mode === 'article') {
    store.beginQuickFactCheck({
      id,
      mode: 'article',
      label: action.label,
      claim: '',
      status: 'running',
      createdAt: Date.now(),
    });
    void (async () => {
      let lodged = false;
      try {
        // The SERVER client, owned by the fact-check unit of this wave. Lazily
        // required for the same reason the executor lazily requires this file:
        // a static import would drag Apollo and the fact_checks table into every
        // consumer, for a branch only this pill reaches.
        const { requestFactCheck } =
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('../fact-check/fact-check-graphql-client') as typeof import('../fact-check/fact-check-graphql-client');
        const outcome = await requestFactCheck(
          action.subject.articleId,
          action.subject.articleTitle,
        );
        // A ROW BACK IS THE ONLY PROOF. `requestFactCheck` never throws: it
        // swallows a transport failure into `{ terminal: false, row: null }`,
        // which is byte-identical to the (documented, unlikely) case where the
        // resolver lodges the job without echoing a row. The two cannot be told
        // apart from here, so the ambiguity resolves in the recoverable
        // direction — "I couldn't confirm it went through" for a request that
        // did, rather than "it's in the Dashboard" for one that did not. The
        // Dashboard is the one surface that must never claim a check exists.
        lodged = outcome.row !== null;
      } catch (err) {
        logger.warn('[quick-fact-check] article request failed', { error: String(err) });
      }
      useFloatingChatStore.getState().settleQuickFactCheck(id, { articleRequested: lodged });
    })();
    return;
  }

  store.beginQuickFactCheck({
    id,
    mode: 'claim',
    label: action.label,
    claim: action.claim,
    status: 'running',
    createdAt: Date.now(),
  });
  void (async () => {
    const answer = await handleQuickFactCheck({
      claim: action.claim,
      articleTitle: action.subject.articleTitle,
      publicationName: action.subject.publicationName,
    });
    useFloatingChatStore.getState().settleQuickFactCheck(id, { answer });
  })();
}
