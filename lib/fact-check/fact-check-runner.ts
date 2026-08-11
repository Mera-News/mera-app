/**
 * The QUICK fact-check machinery: search rounds, synthesis parsing, and the
 * guards that stop a model inventing a source.
 *
 * ── WHAT THIS FILE STOPPED BEING (pivot P8c) ───────────────────────────────
 * It used to be a two-tier on-device JOB that also did a ClaimReview lookup and
 * WROTE ITS ANSWER TO THE `fact_checks` TABLE. Both halves are gone, and their
 * absence is the design:
 *
 *   - TIER 1 (ClaimReview) moved to the SERVER. It is the only lookup that can
 *     say "Alt News rated this False", and it must stay the only thing that can:
 *     the quick path is a summary of what the web says right now, and letting it
 *     attribute a rating would blur the two speeds the whole feature is built
 *     around. `checkedBy` / `checkedByStatus` therefore no longer originate
 *     here; their types stay exported because the RENDER layer
 *     (`fact-check-types.ts`) reads server rows through them.
 *   - PERSISTENCE is gone with it. A quick answer is chat-only and ephemeral —
 *     it lives in the conversation like any other reply and is NEVER written to
 *     `fact_checks`, so "in the Dashboard" keeps meaning *properly checked, with
 *     sources*.
 *
 * ── WHAT SURVIVED, AND WHY ─────────────────────────────────────────────────
 * The guards, unchanged, because they are what make a fabricated source
 * impossible rather than unlikely:
 *   - `clampVerdictToEvidence` forces `unverifiable` on an empty evidence set,
 *     whatever the model said. `supported` is unreachable with zero evidence by
 *     construction, not by prompt.
 *   - citations resolve ONLY by numeric index into evidence actually fetched, so
 *     an index the list cannot resolve is dropped.
 *   - `coerceVerdict`'s negation guard: a negated verdict word degrades to
 *     `unverifiable` rather than printing the opposite of what was said.
 * And `buildSearchQueries`, which never pastes the claim verbatim —
 * `MAX_QUERY_CHARS` is 200 and a sentence-shaped query just returns the article
 * the reader started from.
 *
 * ── PRIOR ART ──────────────────────────────────────────────────────────────
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
 * ── THE HONESTY CONTRACT THAT SURVIVES HERE ───────────────────────────────
 *   we searched, evidence found  → a verdict, clamped to that evidence
 *   we searched, index empty     → `unverifiable`, and the reader is told the
 *                                  search came back empty. A real answer.
 *   we could not search at all    → NO verdict, and the reader is told we could
 *                                  not look. Never "I found nothing".
 *
 * The last two are the pair this design exists to keep apart: both end with zero
 * evidence and they mean opposite things. The gateway contract is what
 * distinguishes them — `200 + []` is a search that happened, `503`
 * + `code: 'search-unavailable'` is a search that did not — so the branch keys
 * on `outcome.ok`, never on `results.length`.
 *
 * No React, no stores, no persistence — every function here is pure but for the
 * types it borrows, so both honesty cases are unit-testable without a network.
 * The I/O half lives in `lib/chat-tools/quick-fact-check-handler.ts`.
 */

import type { WireMessage } from '../llm/cloudComplete';
import { MAX_QUERY_CHARS, type WebSearchResult } from '../web-search/web-search-client';

// ───────────────────────────────────────────────────────────────────────────
// Payload fragments
// ───────────────────────────────────────────────────────────────────────────
//
// Only the two shapes the QUICK path produces live here. The full row shape
// (`FactCheckRow`, `checkedBy`, `checkedByStatus`) belongs to the SERVER answer
// and is declared in `fact-check-types.ts` — this file must not carry a second,
// drifting copy of it.

/** A source. `uri`, not `url` — the render layer reads `uri`. Optionals accept
 *  `null` as well as `undefined` because a server row arrives from GraphQL,
 *  where every optional field is `Maybe<T>`. */
export interface FactCheckCitationPayload {
  uri: string;
  title?: string | null;
  snippet?: string | null;
}

/** One sub-assertion the synthesis broke the claim into. */
export interface FactCheckClaimPayload {
  claim: string;
  assessment: string;
  note?: string | null;
}

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

function fit(query: string, max: number = MAX_QUERY_CHARS): string {
  const trimmed = query.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
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

export function buildSynthesisMessages(
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
// Search-round budget
// ───────────────────────────────────────────────────────────────────────────

/** Stop collecting once we have plenty — every extra round is latency the user
 *  is watching and gateway quota nobody capped. */
export const ENOUGH_EVIDENCE = 8;
/**
 * Rounds that ALWAYS run, before `ENOUGH_EVIDENCE` is allowed to stop the loop.
 *
 * Without this the multi-query design is dead code: the gateway hardcodes
 * `count = 10`, so round 1 alone clears a threshold of 8 and rounds 2 and 3
 * never execute. The rounds are not more of the same — round 2 adds the
 * fact-check register and round 3 pivots onto the headline, and they surface
 * DIFFERENT documents, which is the whole point of Loki's "several short,
 * targeted queries" that this file credits. Round 3 stays conditional: it only
 * earns its latency when the first two came back thin.
 */
export const MIN_SEARCH_ROUNDS = 2;
/** Evidence items that reach the prompt (and therefore the citation index
 *  space). Two full rounds is ~20 results; every one of them in the prompt is
 *  context the synthesis does not need and latency the user waits through. */
export const MAX_EVIDENCE_IN_PROMPT = 12;
/** Wall-clock ceiling on the synthesis stream. Past this the answer is not
 *  worth the wait — and the QUICK path is the one the user sits and watches. */
export const SYNTHESIS_DEADLINE_MS = 90_000;
export const SYNTHESIS_MAX_CHARS = 12_000;
