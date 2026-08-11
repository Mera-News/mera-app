/**
 * The on-device fact-check job: two tiers, and only one of them uses a model.
 *
 * PRIOR ART — Loki / OpenFactVerification (https://github.com/Libr-AI/OpenFactVerification,
 * MIT, ~1.2k stars). Its pipeline is *decompose → check-worthiness → generate
 * queries → gather evidence → verify*, and this file is an ADAPTATION of the
 * last three stages, not a port: Loki is Python, server-side, batch-oriented and
 * wired to OpenAI + Serper, so nothing could be copied even if we wanted to.
 * What we took:
 *   - its *query generation* stage's principle — several short, targeted
 *     queries per claim rather than one long one. Loki asks a model for the
 *     "minimum number of questions needed to verify the claim"; we build them
 *     deterministically instead, because `MAX_QUERY_CHARS = 200`, the gateway
 *     hardcodes `count = 10`, and one more model round trip on a device-driven
 *     job is latency the user watches.
 *   - its *verify* stage's output contract — a reasoned relationship between
 *     evidence and claim (`SUPPORTS | REFUTES | IRRELEVANT`), widened to this
 *     app's existing five-token verdict vocabulary.
 * The first two stages are the CLAIM PICKER's, not this file's: the user has
 * already chosen exactly one assertion by the time we are called.
 *
 * ── TIER 1: `checkedBy[]`, and no model touches it ─────────────────────────
 * A ClaimReview lookup (`claim-review-client.ts`). `publisher.name`,
 * `url`, `textualRating` and `title` map field-for-field onto the
 * `FactCheckOrganisation` shape the UI already renders. An organisation
 * therefore CANNOT be hallucinated and its rating stays verbatim — the
 * `describeOrganisationVerdict` invariant holds by construction rather than by
 * prompt discipline. Measured on the prod corpus, ~4% of articles are the genre
 * fact-checkers cover, so an EMPTY `checkedBy` is the normal, honest outcome.
 *
 * ── TIER 2: the narrative, which is what the user actually sees ────────────
 * Up to three short web searches, then one synthesis pass on `BIG_MODEL`
 * (`cloudChatStream` already hardcodes `enable_thinking: true`).
 *
 * ── THE HONESTY CONTRACT — three outcomes, three DISTINCT states ───────────
 *   a fact-checker published  → `checkedBy` populated  → `complete`
 *   nobody published          → `checkedBy: []`        → `complete`
 *   we could not look         → no verdict at all      → `blocked`
 *
 * The third row is the whole point. Two structural guards enforce it, because a
 * counter-metric that cannot fail is not a counter-metric:
 *   1. `blocked` is decided BEFORE the model is ever called, so a blocked row
 *      cannot carry a verdict — there is no code path that produces one.
 *   2. `clampVerdictToEvidence` forces `unverifiable` whenever the evidence set
 *      is empty, whatever the model said. `supported` is unreachable with zero
 *      evidence by construction, which matters because today's search client
 *      still reports a DISABLED provider as an empty success (G1 is changing
 *      that; this clamp does not depend on G1 landing).
 * Citations get the same treatment: only indices that resolve to a URL we
 * actually fetched survive, so the model cannot invent a source.
 *
 * No React. Every I/O seam is injected (`FactCheckRunnerDeps`) so the three
 * honesty cases are unit-testable without a network.
 */

import { BIG_MODEL } from '../llm/constants';
import { cloudChatStream, type SseEvent, type WireMessage } from '../llm/cloudComplete';
import { searchWeb, MAX_QUERY_CHARS, type WebSearchResult } from '../web-search/web-search-client';
import { searchClaimReviews, type ClaimReviewEntry } from './claim-review-client';
import { upsertFactCheck } from '../database/services/fact-check-record-service';
import logger from '../logger';

// ───────────────────────────────────────────────────────────────────────────
// The payload shape — EXACTLY today's, so the render layer is untouched
// ───────────────────────────────────────────────────────────────────────────

/** One organisation's own published rating. `verdict` is verbatim.
 *
 *  The optional fields accept `null` as well as `undefined` on purpose: the
 *  render layer (`fact-check-types.ts`) aliases these types, and a row stored
 *  before the pivot came from GraphQL, where every optional field is `Maybe<T>`
 *  — i.e. explicitly null. Narrowing to `string | undefined` would make a
 *  legacy payload unassignable to the type that describes it. */
export interface FactCheckOrganisationPayload {
  organisation: string;
  url?: string | null;
  verdict?: string | null;
  summary?: string | null;
}

/** A source. `uri`, not `url` — the render layer reads `uri`. */
export interface FactCheckCitationPayload {
  uri: string;
  title?: string | null;
  snippet?: string | null;
}

export interface FactCheckClaimPayload {
  claim: string;
  assessment: string;
  note?: string | null;
}

/**
 * What lands in `payload_json`. Structurally identical to the GraphQL
 * `FactCheck` row the panel used to read, deliberately: `fact-check-state.ts`,
 * `FactCheckSources.tsx` and `FactCheckCard.tsx` keep working with no change.
 * Declared locally rather than imported from the generated types — the server
 * schema is being torn down and this must outlive it.
 */
export interface FactCheckPayload {
  _id: string;
  articleTitle?: string | null;
  articleUrl?: string | null;
  publicationName?: string | null;
  status: FactCheckRunStatus;
  verdict?: string | null;
  summary?: string | null;
  claims: FactCheckClaimPayload[];
  checkedBy: FactCheckOrganisationPayload[];
  citations: FactCheckCitationPayload[];
  createdAt: string;
  completedAt?: string | null;
  /** The claim the user picked, echoed so a row is self-describing. */
  claim: string;
  /** Runner attempts spent. Bounds the recovery task's re-drive loop. */
  attempts: number;
  /** When the CURRENT attempt started. `requested_at` is insert-only, so this
   *  is the only thing that can say "this run is stale". */
  startedAt: number;
  model?: string | null;
  /** Why a row is `blocked`. Never a verdict. */
  blockedReason?: string | null;
}

export type FactCheckRunStatus = 'processing' | 'complete' | 'blocked' | 'failed';

/** Closed verdict vocabulary — `normalizeVerdict` in fact-check-state.ts. */
const VERDICTS = new Set(['supported', 'disputed', 'unsupported', 'mixed', 'unverifiable']);
const ASSESSMENTS = new Set(['supported', 'disputed', 'unsupported', 'unverifiable']);

// ───────────────────────────────────────────────────────────────────────────
// Verdict coercion — reproduced from the server's `coerceVerdict`
// ───────────────────────────────────────────────────────────────────────────

/**
 * Words that flip a verdict when they appear BEFORE it. Copied from
 * `mera-server/libs/mera-shared/src/fact-check/gemini-fact-check.service.ts`
 * so the two implementations cannot drift apart while both exist.
 */
const NEGATIONS = new Set([
  'not', 'no', 'never', 'none', 'neither', 'nor', 'cannot', 'without',
  'isn', 'aren', 'wasn', 'doesn', 'didn',
]);

/**
 * Coerce free text to the closed verdict set.
 *
 * Scans for a known verdict WORD rather than requiring the whole string to be
 * one, because models append justification ("mixed — two of four claims hold").
 * A NEGATION ANYWHERE BEFORE the verdict word — "not supported", "no claims are
 * disputed" — yields `unverifiable`, never the word itself: printing
 * "supported" for an answer that said the exact opposite is the single worst
 * output this feature can produce. Only the words BEFORE the match are scanned,
 * which is what keeps it from over-firing on a trailing justification
 * ("mixed — two claims are not corroborated").
 *
 * The failure is deliberately asymmetric. Over-coercing to `unverifiable` shows
 * "we could not establish this" for an answer we could have shown; under-
 * coercing shows a confident verdict that is backwards. Only one is survivable.
 */
export function coerceVerdict(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return 'unverifiable';
  let negated = false;
  for (const word of raw.toLowerCase().split(/[^a-z]+/)) {
    if (word === '') continue;
    if (VERDICTS.has(word)) return negated ? 'unverifiable' : word;
    if (NEGATIONS.has(word)) negated = true;
  }
  return 'unverifiable';
}

function coerceAssessment(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return 'unverifiable';
  let negated = false;
  for (const word of raw.toLowerCase().split(/[^a-z]+/)) {
    if (word === '') continue;
    if (ASSESSMENTS.has(word)) return negated ? 'unverifiable' : word;
    if (NEGATIONS.has(word)) negated = true;
  }
  return 'unverifiable';
}

/**
 * THE STRUCTURAL GUARD. With no evidence there is nothing a verdict could be
 * derived from, so the model's answer is discarded rather than trusted.
 *
 * This is not belt-and-braces for a bug we have not seen: today's web-search
 * client reports a DISABLED provider as `{ ok: true, results: [] }`, so without
 * this clamp a gateway with the flag off would produce a confident "supported"
 * that is byte-identical to a real one. `supported` must be UNREACHABLE with an
 * empty evidence set, by construction, not by prompt.
 */
export function clampVerdictToEvidence(verdict: string, evidenceCount: number): string {
  return evidenceCount > 0 ? verdict : 'unverifiable';
}

// ───────────────────────────────────────────────────────────────────────────
// Query building — Loki's "several short targeted queries", deterministic
// ───────────────────────────────────────────────────────────────────────────

/** Latin-script filler that costs query budget and buys no recall. Non-Latin
 *  scripts fall through untouched — this list is a trim, not a tokenizer. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'that', 'this', 'these', 'those', 'it', 'its', 'has', 'have', 'had',
  'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should', 'may',
  'might', 'about', 'into', 'over', 'after', 'before', 'than', 'then', 'so',
]);

function contentWords(text: string, limit: number): string[] {
  const words = (text ?? '')
    .replace(/["“”'’`]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, ''))
    .filter((w) => w.length > 0);
  const kept = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  // A claim written entirely in stopwords is not a claim, but a query of ""
  // would 400 — fall back to the raw words rather than sending nothing.
  return (kept.length > 0 ? kept : words).slice(0, limit);
}

function fit(query: string): string {
  const trimmed = query.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= MAX_QUERY_CHARS) return trimmed;
  const cut = trimmed.slice(0, MAX_QUERY_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Up to three SHORT, distinct web-search queries for one claim.
 *
 * The claim is never pasted verbatim: `MAX_QUERY_CHARS` is 200 and a
 * sentence-shaped query returns the article we started from. Round 1 is the
 * claim's content words, round 2 adds the fact-check register, round 3 pivots
 * onto the headline so a claim phrased in the article's own words can still
 * find a differently-worded report elsewhere. Duplicates are dropped, so a
 * short claim legitimately yields fewer than three rounds.
 */
export function buildSearchQueries(claim: string, articleTitle?: string | null): string[] {
  const out: string[] = [];
  const push = (q: string) => {
    const fitted = fit(q);
    if (fitted.length >= 2 && !out.includes(fitted)) out.push(fitted);
  };
  push(contentWords(claim, 12).join(' '));
  push(`${contentWords(claim, 7).join(' ')} fact check`);
  if (articleTitle) {
    push(`${contentWords(articleTitle, 7).join(' ')} ${contentWords(claim, 4).join(' ')}`);
  }
  return out.slice(0, 3);
}

/** The ClaimReview query: this API matches on claim TEXT, so unlike the web
 *  search it wants the sentence — merely trimmed to the length cap. The retry
 *  is the shortened form, for a claim too specific to match anything. */
export function buildClaimReviewQueries(claim: string): string[] {
  const out: string[] = [];
  const push = (q: string) => {
    const fitted = fit(q);
    if (fitted.length >= 2 && !out.includes(fitted)) out.push(fitted);
  };
  push(claim);
  push(contentWords(claim, 8).join(' '));
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Synthesis prompt — Loki's verify stage, widened to our vocabulary
// ───────────────────────────────────────────────────────────────────────────

const SYNTHESIS_SYSTEM = [
  'You assess ONE claim against numbered search results, for a news reader.',
  '',
  'Decide, for the claim and for each sub-assertion inside it, whether the evidence',
  'SUPPORTS it, REFUTES it, or is IRRELEVANT to it. Reason from the evidence only.',
  '',
  'HARD RULES.',
  '1. Use ONLY the numbered evidence below. You have no other knowledge of this story.',
  '2. If the evidence does not settle the claim, say so — "unverifiable" is a correct,',
  '   expected answer and is far better than a guess. Most news is never fact-checked.',
  '3. Never cite a source that is not in the numbered list. Cite by NUMBER only.',
  '4. Do not describe the claim as true or false because it sounds plausible.',
  '',
  'Reply with ONE JSON object and nothing else:',
  '{',
  '  "verdict": "supported" | "disputed" | "unsupported" | "mixed" | "unverifiable",',
  '  "summary": "2-3 plain sentences for a reader: what the sources actually say.",',
  '  "claims": [',
  '    { "claim": "one sub-assertion, restated plainly",',
  '      "assessment": "supported" | "disputed" | "unsupported" | "unverifiable",',
  '      "note": "one sentence citing the evidence numbers that decided it" }',
  '  ],',
  '  "citations": [1, 3]',
  '}',
  '',
  'verdict meanings: supported = the evidence backs it; disputed = sources disagree;',
  'unsupported = the evidence contradicts it; mixed = parts hold and parts do not;',
  'unverifiable = the evidence does not settle it. At most 4 entries in "claims".',
].join('\n');

function buildSynthesisMessages(
  claim: string,
  evidence: WebSearchResult[],
  articleTitle?: string | null,
  publicationName?: string | null,
): WireMessage[] {
  const lines = evidence.map(
    (e, i) =>
      `[${i + 1}] ${e.title}\n${e.url}\n${(e.snippet ?? '').slice(0, 320)}`,
  );
  const context = [
    articleTitle ? `The reader is looking at an article headlined: ${articleTitle}` : null,
    publicationName ? `Published by: ${publicationName}` : null,
    '',
    `CLAIM TO ASSESS:\n${claim}`,
    '',
    `EVIDENCE (${evidence.length} results):`,
    ...lines,
  ]
    .filter((l) => l !== null)
    .join('\n');
  return [
    { role: 'system', content: SYNTHESIS_SYSTEM },
    { role: 'user', content: context },
  ];
}

// ───────────────────────────────────────────────────────────────────────────
// Parsing
// ───────────────────────────────────────────────────────────────────────────

export interface ParsedSynthesis {
  verdict: string;
  summary: string | null;
  claims: FactCheckClaimPayload[];
  citationIndices: number[];
}

/** Pull the first balanced-looking JSON object out of a model answer. */
function extractJsonObject(text: string): Record<string, any> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Record<string, any>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Model answer → the fields we store. Never throws.
 *
 * A model that ignores the JSON contract still has to produce a verdict, so the
 * fallback scans the prose through the same negation-guarded `coerceVerdict` —
 * an unparseable answer degrades to `unverifiable`, never to a confident one.
 */
export function parseSynthesis(text: string, evidenceCount: number): ParsedSynthesis {
  const obj = extractJsonObject(text ?? '');
  if (!obj) {
    return {
      verdict: coerceVerdict(text),
      summary: null,
      claims: [],
      citationIndices: [],
    };
  }
  const claims: FactCheckClaimPayload[] = Array.isArray(obj.claims)
    ? obj.claims
      .filter((c: any) => c && typeof c.claim === 'string' && c.claim.trim().length > 0)
      .slice(0, 4)
      .map((c: any) => ({
        claim: String(c.claim).trim(),
        assessment: coerceAssessment(c.assessment),
        note: typeof c.note === 'string' && c.note.trim() ? String(c.note).trim() : undefined,
      }))
    : [];
  const citationIndices: number[] = Array.isArray(obj.citations)
    ? obj.citations
      .map((n: any) => (typeof n === 'number' ? n : Number.parseInt(String(n), 10)))
      // A number the evidence list cannot resolve is a hallucinated source.
      .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= evidenceCount)
    : [];
  const summary =
    typeof obj.summary === 'string' && obj.summary.trim().length > 0
      ? obj.summary.trim()
      : null;
  return {
    verdict: coerceVerdict(typeof obj.verdict === 'string' ? obj.verdict : ''),
    summary,
    claims,
    citationIndices: [...new Set(citationIndices)],
  };
}

/**
 * Indices → real citations.
 *
 * The model never supplies a URL, only a number, and a number that does not
 * resolve is dropped. That is what makes a fabricated source impossible rather
 * than unlikely. When the model cites nothing at all we fall back to the
 * evidence we actually gathered, so a complete check always shows its working.
 */
export function resolveCitations(
  indices: number[],
  evidence: WebSearchResult[],
  fallbackLimit = 5,
): FactCheckCitationPayload[] {
  const picked = indices
    .map((n) => evidence[n - 1])
    .filter((e): e is WebSearchResult => !!e && typeof e.url === 'string');
  const chosen = picked.length > 0 ? picked : evidence.slice(0, fallbackLimit);
  const seen = new Set<string>();
  const out: FactCheckCitationPayload[] = [];
  for (const e of chosen) {
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    out.push({ uri: e.url, title: e.title || undefined, snippet: e.snippet || undefined });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// The job
// ───────────────────────────────────────────────────────────────────────────

export interface FactCheckJob {
  readonly factCheckId: string;
  readonly articleId: string;
  readonly claim: string;
  readonly claimKey: string;
  readonly articleTitle?: string;
  readonly articleUrl?: string;
  readonly publicationName?: string;
  /** BCP-47, for the ClaimReview lookup. Retried unset when it yields nothing. */
  readonly languageCode?: string;
  /** Attempts already spent. The recovery task carries this forward. */
  readonly attempts?: number;
}

export interface FactCheckRunnerDeps {
  searchClaimReviews: typeof searchClaimReviews;
  searchWeb: typeof searchWeb;
  chatStream: (req: {
    messages: WireMessage[];
    model: string;
    temperature?: number;
    maxTokens?: number;
  }) => AsyncGenerator<SseEvent>;
  persist: typeof upsertFactCheck;
  now: () => number;
}

const defaultDeps: FactCheckRunnerDeps = {
  searchClaimReviews,
  searchWeb,
  chatStream: (req) => cloudChatStream(req),
  persist: upsertFactCheck,
  now: () => Date.now(),
};

/** Stop collecting once we have plenty — every extra round is latency the user
 *  is waiting through and gateway quota nobody capped. */
const ENOUGH_EVIDENCE = 8;
/** Wall-clock ceiling on the synthesis stream. `BIG_MODEL` with thinking on is
 *  tens of seconds; past this the answer is not worth the wait. */
const SYNTHESIS_DEADLINE_MS = 120_000;
const SYNTHESIS_MAX_CHARS = 12_000;
/** Attempts before a repeatedly-failing row stops being re-driven. It then goes
 *  `blocked` — terminal and verdict-free — rather than looping forever. */
export const MAX_FACT_CHECK_ATTEMPTS = 3;

export interface FactCheckRunResult {
  status: FactCheckRunStatus;
  verdict: string | null;
  checkedByCount: number;
  evidenceCount: number;
  blockedReason?: string;
}

/**
 * Run one check to completion and persist the outcome. Never throws.
 *
 * Ordering is load-bearing: every `blocked` exit happens BEFORE the model is
 * called, so there is no path on which a blocked row carries a verdict.
 */
export async function runFactCheck(
  job: FactCheckJob,
  overrides: Partial<FactCheckRunnerDeps> = {},
): Promise<FactCheckRunResult> {
  const deps: FactCheckRunnerDeps = { ...defaultDeps, ...overrides };
  const startedAt = deps.now();
  const attempts = (job.attempts ?? 0) + 1;

  const base = {
    _id: job.factCheckId,
    articleTitle: job.articleTitle ?? null,
    articleUrl: job.articleUrl ?? null,
    publicationName: job.publicationName ?? null,
    claim: job.claim,
    createdAt: new Date(startedAt).toISOString(),
    attempts,
    startedAt,
  };

  const write = async (
    payload: FactCheckPayload,
  ): Promise<void> => {
    await deps.persist({
      articleId: job.articleId,
      factCheckId: job.factCheckId,
      articleTitle: job.articleTitle ?? null,
      claim: job.claim,
      claimKey: job.claimKey,
      status: payload.status,
      // BLOCKED ROWS CARRY NO VERDICT. Asserted here as well as by construction,
      // because this is the one field that could turn "we could not look" into
      // a green all-clear.
      verdict: payload.status === 'blocked' ? null : (payload.verdict ?? null),
      payload,
    });
  };

  const blocked = async (reason: string): Promise<FactCheckRunResult> => {
    logger.warn('[fact-check] blocked', { reason, articleId: job.articleId });
    await write({
      ...base,
      status: 'blocked',
      verdict: null,
      summary: null,
      claims: [],
      checkedBy: [],
      citations: [],
      completedAt: new Date(deps.now()).toISOString(),
      blockedReason: reason,
    });
    return { status: 'blocked', verdict: null, checkedByCount: 0, evidenceCount: 0, blockedReason: reason };
  };

  // Re-stamp `processing` so the recovery task can tell a live run from a
  // stranded one (`requested_at` is insert-only and cannot).
  await write({
    ...base,
    status: 'processing',
    verdict: null,
    summary: null,
    claims: [],
    checkedBy: [],
    citations: [],
    completedAt: null,
  });

  // ── Tier 1 ───────────────────────────────────────────────────────────────
  let checkedBy: ClaimReviewEntry[] = [];
  {
    const queries = buildClaimReviewQueries(job.claim);
    // (query, languageCode) pairs: shortened retry first, then the language
    // dropped — the ClaimReview corpus skews hard to a handful of languages, so
    // a language-scoped miss is often an artefact rather than an answer.
    const attemptsList: { query: string; languageCode?: string }[] = [
      ...queries.map((query) => ({ query, languageCode: job.languageCode })),
      ...(job.languageCode ? [{ query: queries[0], languageCode: undefined }] : []),
    ];
    for (const attempt of attemptsList) {
      const outcome = await deps.searchClaimReviews(attempt);
      // Unavailable is NOT empty. Bailing here — before any model call — is
      // what makes "we could not look" impossible to confuse with "nobody
      // published".
      if (!outcome.ok) return blocked(`claim-review:${outcome.error}`);
      if (outcome.entries.length > 0) {
        checkedBy = outcome.entries;
        break;
      }
    }
  }

  // ── Tier 2 ───────────────────────────────────────────────────────────────
  const evidence: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  let okRounds = 0;
  let lastSearchError: string | undefined;
  for (const query of buildSearchQueries(job.claim, job.articleTitle)) {
    if (evidence.length >= ENOUGH_EVIDENCE) break;
    const outcome = await deps.searchWeb(query);
    if (!outcome.ok) {
      lastSearchError = outcome.error;
      continue;
    }
    okRounds++;
    for (const r of outcome.results) {
      if (!r?.url || seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);
      evidence.push(r);
    }
  }
  // Not "no results" — no successful ROUND. Zero of our searches reached the
  // provider, so we know nothing at all and must not pretend otherwise.
  if (okRounds === 0) return blocked(`web-search:${lastSearchError ?? 'search-unavailable'}`);

  const organisations: FactCheckOrganisationPayload[] = checkedBy.map((c) => ({
    organisation: c.organisation,
    url: c.url,
    verdict: c.verdict,
    summary: c.summary,
  }));

  // Searches ran and returned nothing at all. There is nothing to synthesise
  // from, so the model is not called: an answer built on zero evidence is the
  // fabricated all-clear this feature exists to avoid. `unverifiable` is the
  // honest, renderable outcome, and `checkedBy` may still be populated.
  if (evidence.length === 0) {
    await write({
      ...base,
      status: 'complete',
      verdict: 'unverifiable',
      summary: null,
      claims: [],
      checkedBy: organisations,
      citations: [],
      completedAt: new Date(deps.now()).toISOString(),
    });
    return {
      status: 'complete',
      verdict: 'unverifiable',
      checkedByCount: organisations.length,
      evidenceCount: 0,
    };
  }

  // ── Synthesis ────────────────────────────────────────────────────────────
  let answer = '';
  try {
    const deadline = deps.now() + SYNTHESIS_DEADLINE_MS;
    const stream = deps.chatStream({
      messages: buildSynthesisMessages(
        job.claim,
        evidence,
        job.articleTitle,
        job.publicationName,
      ),
      model: BIG_MODEL,
      temperature: 0,
      maxTokens: 1200,
    });
    for await (const event of stream) {
      if (event.type === 'text-delta') answer += event.delta;
      else if (event.type === 'error') throw new Error(event.message);
      if (answer.length > SYNTHESIS_MAX_CHARS || deps.now() > deadline) break;
    }
  } catch (err) {
    logger.warn('[fact-check] synthesis failed', {
      error: String(err),
      attempts,
      articleId: job.articleId,
    });
    // A model failure is not a fact about the claim. At the attempt cap it
    // becomes `blocked` (terminal, verdict-free) rather than a row the recovery
    // task re-drives forever.
    if (attempts >= MAX_FACT_CHECK_ATTEMPTS) return blocked('synthesis-failed');
    await write({
      ...base,
      status: 'failed',
      verdict: null,
      summary: null,
      claims: [],
      checkedBy: organisations,
      citations: [],
      completedAt: null,
    });
    return {
      status: 'failed',
      verdict: null,
      checkedByCount: organisations.length,
      evidenceCount: evidence.length,
    };
  }

  const parsed = parseSynthesis(answer, evidence.length);
  const verdict = clampVerdictToEvidence(parsed.verdict, evidence.length);
  await write({
    ...base,
    status: 'complete',
    verdict,
    summary: parsed.summary,
    claims: parsed.claims,
    checkedBy: organisations,
    citations: resolveCitations(parsed.citationIndices, evidence),
    completedAt: new Date(deps.now()).toISOString(),
    model: BIG_MODEL,
  });
  return {
    status: 'complete',
    verdict,
    checkedByCount: organisations.length,
    evidenceCount: evidence.length,
  };
}
