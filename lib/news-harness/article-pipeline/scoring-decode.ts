// news-harness: pure decoders for the cloud scoring, reason and verifier
// responses. Split verbatim from scoring.ts, which keeps the call builders.

import { parseV3NoteResponse } from '../prompts/prompts';
import {
  DEFAULT_HARNESS_CONFIG,
  type ArticlePipelineConfig,
} from '../core/config';
import { NOOP_LOGGER, type HarnessLogger } from '../core/ports';
import type {
  BatchCompletionResult,
  DecodedResults,
  ScoringCandidate,
} from '../core/types';
import type { FeedVerifierLabel } from './scoring';

const ARTICLE_CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;

/**
 * Parse a verifier batch response — a JSON array of N `{"v":"yes"|"no"}` objects
 * (bare "yes"/"no" strings also accepted). Returns exactly `expectedCount`
 * labels. CONSERVATIVE by contract: on parse failure, length mismatch, or any
 * non-"no" token, the article is KEPT ("yes") — the verifier only ever demotes
 * on an explicit, well-formed "no". (This is the failure mode the experiment
 * measured at ~1–2 of 14 batches, handled as a keep.)
 */
export function parseFeedVerifierResponse(
  output: string,
  expectedCount: number,
  logger: HarnessLogger = NOOP_LOGGER,
  id?: string,
): FeedVerifierLabel[] {
  const keepAll = (): FeedVerifierLabel[] =>
    new Array<FeedVerifierLabel>(expectedCount).fill('yes');

  const trimmed = output.trim();
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        const labels: FeedVerifierLabel[] = parsed.map((v) => {
          let s = '';
          if (typeof v === 'string') s = v;
          else if (v && typeof v === 'object') {
            const o = v as Record<string, unknown>;
            s = String(o.v ?? o.a ?? o.decision ?? o.label ?? o.keep ?? '');
          }
          // Only an explicit "no" demotes; everything else keeps (conservative).
          return s.toLowerCase().trim() === 'no' ? 'no' : 'yes';
        });
        if (labels.length === expectedCount) return labels;
        logger.warn(
          'Feed verifier: array length mismatch — conservative keep for batch',
          { expected: expectedCount, got: labels.length, id },
        );
        return keepAll();
      }
    } catch {
      // fall through
    }
  }

  logger.warn('Feed verifier: failed to parse output — conservative keep', {
    output: trimmed.slice(0, 200),
    expected: expectedCount,
    id,
  });
  return keepAll();
}

/**
 * Apply verifier decisions to a raw score map IN PLACE: for each `verify:N`
 * result, parse its labels and set every "no" article to
 * config.feedVerifierDemoteScore (only when its current raw score is above that,
 * so nothing is ever raised). A per-chunk error → conservative keep for that
 * chunk. Returns the number of articles demoted. Pure — the LLM call is the
 * caller's responsibility.
 */
export function applyFeedVerifierDecisions(
  scoreMap: Map<string, number>,
  verifyIdToCandidates: Map<string, ScoringCandidate[]>,
  batchResults: BatchCompletionResult[],
  config: ArticlePipelineConfig = ARTICLE_CFG,
  logger: HarnessLogger = NOOP_LOGGER,
): number {
  let demoted = 0;
  for (const result of batchResults) {
    if (!result.id.startsWith('verify:')) continue;
    const chunkCandidates = verifyIdToCandidates.get(result.id) ?? [];
    if (result.error) {
      logger.warn('[applyFeedVerifierDecisions] verify chunk failed — keeping', {
        chunkId: result.id,
        error: result.error,
        chunkSize: chunkCandidates.length,
      });
      continue; // conservative: keep every article in a failed chunk
    }
    const labels = parseFeedVerifierResponse(
      result.output,
      chunkCandidates.length,
      logger,
      result.id,
    );
    chunkCandidates.forEach((c, i) => {
      if (labels[i] !== 'no') return;
      const cur = scoreMap.get(c.id);
      if (typeof cur === 'number' && cur > config.feedVerifierDemoteScore) {
        scoreMap.set(c.id, config.feedVerifierDemoteScore);
        demoted += 1;
      }
    });
  }
  return demoted;
}

// --- v3 NOTE pass — shared decode ----------------------------------------
//
// Pulled out of `scoring-pipeline::applyV3NoteResults` so the decision logic has
// exactly ONE implementation. That function still owns the DB writes (which
// cannot run outside the app), but it no longer owns the RULES — which is what
// makes the offline goldset replay a measurement of the SHIPPED behaviour rather
// than of a look-alike written beside it. Same argument, and the same shape, as
// `parseFeedVerifierResponse` / `applyFeedVerifierDecisions` above.

/** What the note pass decided for one article. */
export interface V3NoteDecisions {
  /** Ids the model explicitly demoted (`{"keep": false}`). The caller writes
   *  `feedVerifierDemoteScore` + a terminal reason-skipped state. */
  demoteIds: string[];
  /** id → the sentence to persist, for kept rows that produced one. */
  reasons: Map<string, string>;
  /** Results that could not be read as a verdict at all (error, or output the
   *  note parser rejected). FAIL OPEN — the caller leaves the pass-1 score and
   *  `reason_pending` so the orphan sweep retries. An unreadable answer is not
   *  evidence that an article deserves demoting. */
  unusableIds: string[];
}

/**
 * Decode a batch of per-article `reason:<id>` note results into keep/demote
 * decisions. Pure: no DB, no LLM, no clock.
 *
 * FAIL OPEN in both directions, matching the shipped contract:
 *   - an errored or unparseable result is `unusable`, never a demote;
 *   - a KEEP with no sentence is neither demoted nor captioned — the row stays
 *     scored and still owed a note, rather than stamped terminal with nothing to
 *     show.
 * Only an explicit `{"keep": false}` demotes.
 */
export function decodeV3NoteResults(
  batchResults: { id: string; output: string; error?: string }[],
): V3NoteDecisions {
  const demoteIds: string[] = [];
  const reasons = new Map<string, string>();
  const unusableIds: string[] = [];

  for (const res of batchResults) {
    if (!res.id.startsWith('reason:')) continue;
    const id = res.id.slice('reason:'.length);
    if (res.error) {
      unusableIds.push(id);
      continue;
    }
    const verdict = parseV3NoteResponse(res.output ?? '');
    if (!verdict) {
      unusableIds.push(id);
      continue;
    }
    if (!verdict.keep) demoteIds.push(id);
    else if (verdict.why) reasons.set(id, verdict.why);
  }

  return { demoteIds, reasons, unusableIds };
}

/**
 * Decode a raw BatchCompletionResult[] back into per-candidate score + reason
 * maps. Kept in one place so sync and async paths produce identical outputs.
 */
export function decodeCloudBatchResults(
  params: {
    batchResults: BatchCompletionResult[];
    promptsById: Map<string, string>;
    chunkIdToCandidates: Map<string, ScoringCandidate[]>;
  },
  config: ArticlePipelineConfig = ARTICLE_CFG,
  logger: HarnessLogger = NOOP_LOGGER,
): DecodedResults {
  const { batchResults, promptsById, chunkIdToCandidates } = params;
  const scoreMap = new Map<string, number>();
  const reasonMap = new Map<string, string>();
  const failedIds = new Set<string>();
  const rescoreMap = new Map<string, number>();

  for (const result of batchResults) {
    if (result.id.startsWith('score:')) {
      const chunkCandidates = chunkIdToCandidates.get(result.id) ?? [];
      if (result.error) {
        logger.warn('[decodeCloudBatchResults] chunk score failed', {
          chunkId: result.id,
          error: result.error,
          chunkSize: chunkCandidates.length,
        });
        chunkCandidates.forEach((c) => {
          scoreMap.set(c.id, config.fallbackRelevance);
          failedIds.add(c.id);
        });
        continue;
      }
      const scores = parseBatchRelevanceResponse(
        result.output,
        chunkCandidates.length,
        chunkCandidates[0]?.id ?? result.id,
        promptsById.get(result.id),
        config,
        logger,
      );
      chunkCandidates.forEach((c, i) => scoreMap.set(c.id, scores[i]));
    } else if (result.id.startsWith('reason:')) {
      const serverId = result.id.slice('reason:'.length);
      if (result.error) {
        reasonMap.set(serverId, '');
      } else {
        const { reason, rescore } = parseReasonResult(
          result.output,
          serverId,
          promptsById.get(result.id),
          logger,
        );
        reasonMap.set(serverId, reason);
        if (rescore) rescoreMap.set(serverId, rescore.score);
      }
    }
  }

  return { scoreMap, reasonMap, failedIds, rescoreMap };
}

// --- Response parsing ---

function clampRelevance(n: number): number {
  return Math.max(0, Math.min(1.1, n));
}

/**
 * Product-tier bands keyed by the stake tag the model outputs alongside each
 * score (`{"k":"family","s":0.72}`): FEED stakes 0.40–1.10, interest-only
 * 0.25–0.39, none 0.05–0.24. The decoder clamps a score into its declared
 * band, so a right classification with a drifted score still lands in the
 * right tier. Unknown tags fall back to plain 0–1.1 clamping.
 */
const STAKE_SCORE_BANDS: Record<string, [number, number]> = {
  home: [0.4, 1.1],
  family: [0.4, 1.1],
  travel: [0.4, 1.1],
  domain: [0.4, 1.1],
  attend: [0.4, 1.1],
  interest: [0.25, 0.39],
  none: [0.05, 0.24],
};

/**
 * Optional counters a CALLER may pass into {@link parseBatchRelevanceResponse}
 * to learn how well the model held its own output contract on this batch.
 *
 * WHY THIS EXISTS. The relevance prompt tells the model that `s` "MUST lie
 * inside the band of the `k` you chose. If your score wants to leave the band,
 * your `k` is wrong." The decoder has always enforced that by CLAMPING — so a
 * self-contradicting answer is silently corrected and the product is fine, but
 * the fact that the model contradicted itself is thrown away. That fact is a
 * direct, free measure of instruction-following: it needs no rater, no labels
 * and no extra call, and it is available on every batch the scorer has ever
 * run. `bandViolations` over `tieredEntries` is the metric; `bandViolationMass`
 * carries the SIZE of the disagreement, because one answer off by 0.01 and one
 * off by 0.6 are not the same finding.
 *
 * NOT INSTRUMENTATION. These count properties of MODEL OUTPUT within a single
 * decode call. Nothing here observes, derives from, or is keyed to a reader —
 * there is no row written, no counter persisted and no id of any kind. The
 * accumulator is created by the caller, lives as long as the caller's run, and
 * production passes none: omit the argument and this module behaves exactly as
 * it did before, which is why every existing call site is untouched.
 */
export interface RelevanceDecodeStats {
  /** Entries decoded from a well-formed JSON array, tiered or legacy. */
  entries: number;
  /** Entries that arrived as `{"k","s"}` — the only ones with a band to hold. */
  tieredEntries: number;
  /** Entries that arrived as a bare number (legacy shape, no `k`). */
  legacyNumberEntries: number;
  /** Tiered entries whose `k` is not in {@link STAKE_SCORE_BANDS}. These skip
   *  band clamping entirely and fall back to a plain 0–1.1 clamp, so they are
   *  worth separating from a violation: the contract was not broken, it was
   *  not engaged. */
  unknownStakeTags: number;
  /** Tiered entries whose `s` fell outside the band its own `k` declares. */
  bandViolations: number;
  /** Total absolute distance the violations were moved by the clamp. Divide by
   *  `bandViolations` for the mean severity. */
  bandViolationMass: number;
  /** The batch did not come back as a parseable JSON array at all and the
   *  regex fallback ran. */
  regexFallbacks: number;
  /** The array parsed but did not hold `expectedCount` entries. */
  lengthMismatches: number;
  /** Nothing parseable at all — every article in the batch took
   *  `fallbackRelevance`. */
  totalFailures: number;
}

/** A zeroed accumulator. Callers that want stats create one and pass it in. */
export function newRelevanceDecodeStats(): RelevanceDecodeStats {
  return {
    entries: 0,
    tieredEntries: 0,
    legacyNumberEntries: 0,
    unknownStakeTags: 0,
    bandViolations: 0,
    bandViolationMass: 0,
    regexFallbacks: 0,
    lengthMismatches: 0,
    totalFailures: 0,
  };
}

function clampToStakeBand(
  s: number,
  k: unknown,
  stats?: RelevanceDecodeStats,
): number {
  const band = typeof k === 'string' ? STAKE_SCORE_BANDS[k] : undefined;
  if (!band) {
    if (stats) stats.unknownStakeTags++;
    return clampRelevance(s);
  }
  const clamped = Math.max(band[0], Math.min(band[1], clampRelevance(s)));
  if (stats) {
    // Measure the violation against the RAW value, not the 0–1.1 clamp, so a
    // wild `s` of 7.0 under `"k":"none"` reports its real distance instead of
    // the distance left after another clamp already hid most of it.
    const distance = s < band[0] ? band[0] - s : s > band[1] ? s - band[1] : 0;
    if (distance > 0) {
      stats.bandViolations++;
      stats.bandViolationMass += distance;
    }
  }
  return clamped;
}

/**
 * The last complete, balanced top-level JSON array in `text`, or null.
 *
 * WHY THE LAST AND NOT THE FIRST. A thinking model writes a draft array while
 * reasoning and its real answer at the end. z-ai/glm-5.3-flash does exactly
 * that: the captured fixture in `test/fixtures/feed/news-harness/glm-leaked-scoring.json`
 * holds the array twice, once inside the trace and once after `</think>`.
 * Taking the first reads the draft; taking the last reads the conclusion.
 *
 * Tracks string state so a bracket inside a JSON string cannot unbalance the
 * scan, and only counts TOP-LEVEL arrays so a nested one is never returned on
 * its own.
 */
function extractLastJsonArray(text: string): string | null {
  let depth = 0;
  let start = -1;
  let last: string | null = null;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ']') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) last = text.slice(start, i + 1);
      }
    }
  }
  return last;
}

/**
 * True when `text` carries prose, i.e. anything a model might be THINKING in
 * rather than answering with.
 *
 * This is the gate on the regex fallback. That fallback used to take the first
 * numbers found anywhere, which on a leaked reasoning trace meant scraping
 * "Article 0", "I'll go 0.60-0.63" and "Let's say 0.62" and returning them as
 * scores — a measured, silent wrong answer that included a 1.00 EMERGENCY-tier
 * score invented from the model's scratch work.
 *
 * A letter is the test because a legitimate bare list ("0.61, 0.22") has none
 * and every trace has many. Deliberately strict: a chatty-but-correct
 * "here you go: 0.61, 0.22" is now a clean failure too. That trade is
 * one-sided — a chatty model that still answers is rare and costs one batch a
 * fallback score, while a thinking model's trace is routine and cost us
 * invented scores that nothing recorded as a failure.
 */
function looksLikeProse(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

/**
 * Parse a batched relevance response — a JSON array of N entries in input
 * order, where each entry is either a float in 0.0–1.1 (legacy format) or a
 * `{"k":"<stake>","s":<float>}` object (tiered format; `s` is clamped into
 * the band declared by `k`). Falls back to extracting any numbers via regex
 * if the output isn't valid JSON. Always returns exactly `expectedCount`
 * scores, padding with the fallback relevance if the LLM returned fewer.
 *
 * `stats` is optional and write-only: pass a {@link newRelevanceDecodeStats}
 * accumulator to learn how well the model held its output contract (see
 * {@link RelevanceDecodeStats}). Omit it — as every production call site does —
 * and the returned scores and every log line are byte-for-byte what they were
 * before the parameter existed.
 */

/**
 * One decoded pass-1 entry: the band-clamped score, and the stake tag the model
 * used to reach it.
 *
 * THE TAG IS WHY THIS EXISTS. `k` was read purely to pick a clamp band and then
 * thrown away, which is fine for the product and useless for measurement: the
 * question "did a foreign-domestic story get tagged `home`?" cannot be answered
 * from the score, because `home`, `family`, `travel`, `domain` and `attend` all
 * share the band [0.40, 1.10]. Callers that want the tag pass an out-array;
 * callers that do not are byte-identical to before.
 *
 * `null` for a legacy bare-number entry (no tag was sent) and for an entry that
 * failed to decode, so the array always lines up index-for-index with the
 * scores.
 */
function mapRelevanceEntries(
  parsed: unknown[],
  stats: RelevanceDecodeStats | undefined,
): { numbers: number[]; tags: (string | null)[] } {
  const numbers: number[] = [];
  const tags: (string | null)[] = [];
  for (const v of parsed) {
    if (typeof v === 'number') {
      if (stats) {
        stats.entries++;
        stats.legacyNumberEntries++;
      }
      numbers.push(clampRelevance(v));
      tags.push(null);
      continue;
    }
    if (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as { s?: unknown }).s === 'number'
    ) {
      if (stats) {
        stats.entries++;
        stats.tieredEntries++;
      }
      const k = (v as { k?: unknown }).k;
      numbers.push(clampToStakeBand((v as { s: number }).s, k, stats));
      tags.push(typeof k === 'string' ? k : null);
      continue;
    }
    numbers.push(NaN);
    tags.push(null);
  }
  return { numbers, tags };
}

/** Fill a caller's tag out-array so it lines up with the scores that are about
 *  to be returned: same length, `null` where no tag was decoded. */
function emitStakeTags(
  out: (string | null)[] | undefined,
  tags: (string | null)[],
  count: number,
): void {
  if (!out) return;
  out.length = 0;
  for (let i = 0; i < count; i++) out.push(tags[i] ?? null);
}

export function parseBatchRelevanceResponse(
  output: string,
  expectedCount: number,
  id: string,
  prompt?: string,
  config: ArticlePipelineConfig = ARTICLE_CFG,
  logger: HarnessLogger = NOOP_LOGGER,
  stats?: RelevanceDecodeStats,
  /** Optional out-array for the per-article stake tag (`k`). Filled to the
   *  same length as the returned scores. Omit it and nothing changes. */
  stakeTagsOut?: (string | null)[],
): number[] {
  const trimmed = output.trim();
  emitStakeTags(stakeTagsOut, [], expectedCount);

  // Primary path: JSON array of numbers.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const { numbers, tags } = mapRelevanceEntries(parsed, stats);
      if (numbers.every((n) => !isNaN(n))) {
        if (numbers.length === expectedCount) {
          emitStakeTags(stakeTagsOut, tags, expectedCount);
          return numbers;
        }
        if (stats) stats.lengthMismatches++;
        logger.warn(
          'Batch relevance: array length mismatch — padding with fallback',
          {
            expected: expectedCount,
            got: numbers.length,
            id,
          },
        );
        const padded = numbers.slice(0, expectedCount);
        while (padded.length < expectedCount)
          padded.push(config.fallbackRelevance);
        // Padded rows took `fallbackRelevance`, which no tag produced, so they
        // read as `null` rather than borrowing a neighbour's tag.
        emitStakeTags(stakeTagsOut, tags, expectedCount);
        return padded;
      }
    }
    // Single-number JSON (legacy format) — only valid for single-article chunks.
    if (typeof parsed === 'number' && expectedCount === 1)
      return [clampRelevance(parsed)];
  } catch {
    // fall through
  }

  // Second chance: the LAST balanced top-level array in the text. A thinking
  // model prefixes its answer with a trace (and may draft the array inside it),
  // so the array we want is the final one, not the first thing that parses.
  const lastArray = extractLastJsonArray(trimmed);
  if (lastArray) {
    try {
      const parsed: unknown = JSON.parse(lastArray);
      if (Array.isArray(parsed)) {
        const { numbers, tags } = mapRelevanceEntries(parsed, stats);
        if (numbers.every((n) => !isNaN(n))) {
          if (numbers.length === expectedCount) {
            emitStakeTags(stakeTagsOut, tags, expectedCount);
            return numbers;
          }
          if (stats) stats.lengthMismatches++;
          logger.warn(
            'Batch relevance: recovered array length mismatch — padding with fallback',
            { expected: expectedCount, got: numbers.length, id },
          );
          const padded = numbers.slice(0, expectedCount);
          while (padded.length < expectedCount)
            padded.push(config.fallbackRelevance);
          emitStakeTags(stakeTagsOut, tags, expectedCount);
          return padded;
        }
      }
    } catch {
      // fall through to the prose gate
    }
  }

  // Regex fallback, now gated on the text carrying NO prose. See
  // `looksLikeProse`: scraping numbers out of a reasoning trace produced
  // confident, wrong, unrecorded scores, which is worse than no answer.
  if (!looksLikeProse(trimmed)) {
    if (stats) stats.regexFallbacks++;
    const matches = trimmed.match(/-?\d+\.?\d*/g) ?? [];
    const nums = matches
      .map((s) => parseFloat(s))
      .filter((n) => !isNaN(n))
      .map(clampRelevance);

    if (nums.length >= expectedCount) return nums.slice(0, expectedCount);
    if (nums.length > 0) {
      logger.warn(
        'Batch relevance: regex fallback under-filled — padding with fallback',
        {
          expected: expectedCount,
          got: nums.length,
          id,
          prompt,
        },
      );
      const padded = [...nums];
      while (padded.length < expectedCount) padded.push(config.fallbackRelevance);
      return padded;
    }
  }

  if (stats) stats.totalFailures++;
  logger.warn('Batch relevance: failed to parse output — using fallback for all', {
    output: trimmed,
    expected: expectedCount,
    id,
    prompt,
  });
  return new Array<number>(expectedCount).fill(config.fallbackRelevance);
}

/**
 * Dash characters that get used as clause punctuation: em dash, en dash and
 * horizontal bar. Hyphen-minus is deliberately NOT here — it is a real word
 * joiner ("on-device", "AI-industry") and replacing it would corrupt prose.
 */
const CLAUSE_DASHES = /(\s*)([\u2014\u2013\u2015])(\s*)/g;

/** Hard cap on a stored reason, applied at a word boundary. */
const REASON_MAX_CHARS = 200;

/**
 * Replace a dash used as clause punctuation with a comma, leaving real ranges
 * alone.
 *
 * WHY THE DECODER AND NOT JUST THE PROMPT. The reason is the only LLM-generated
 * user-facing string in the feed, and house style has no em dashes. A prompt
 * rule is advice the model can ignore; this is deterministic. It also covers
 * the ON-DEVICE path for free, which a cloud prompt rule cannot: the local
 * reason prompt carries its own copy of the voice rule rather than sharing the
 * cloud constant, so only shared post-processing reaches both.
 *
 * THREE CASES THAT ARE NOT CLAUSE PUNCTUATION, each one a real output:
 *  - Between digits it is a RANGE ("2014–2016", "10–15%"). Left exactly as it
 *    was, whitespace included.
 *  - Leading or trailing, there is no second clause to join, so a comma would
 *    be worse than nothing. Dropped.
 *  - A hyphen is not in the class at all, so hyphenated words are untouched.
 *
 * Never concatenates: "a—b" becomes "a, b", never "ab".
 */
function replaceClauseDashes(text: string): string {
  return text.replace(
    CLAUSE_DASHES,
    (match: string, _pre: string, _dash: string, _post: string, offset: number, whole: string) => {
      const before = whole.slice(0, offset);
      const after = whole.slice(offset + match.length);
      if (/\d$/.test(before) && /^\d/.test(after)) return match;
      if (before.trim().length === 0) return '';
      if (after.trim().length === 0) return '';
      return ', ';
    },
  );
}

/**
 * Cut to `max` characters at a word boundary.
 *
 * The prompt asks for 25 words or fewer, so reaching the cap already means
 * something went wrong upstream. The old `slice(0, max)` then made it visibly
 * broken by cutting mid-word. No ellipsis: a trailing "…" dresses a failure up
 * as an intentional summary. A single token longer than the cap has no boundary
 * to cut at, so it is hard-cut rather than emptied.
 */
function cutAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
}

/**
 * Openers that mean the model is DELIBERATING rather than answering.
 *
 * A backstop, not the main defence — the structural checks in
 * {@link parseReasonResponse} (a `</think>` closer, an unclosed `<think>`) carry
 * the weight. This catches the case a thinking model produces with no tags at
 * all, which is what z-ai/glm-5.3-flash does at the shipped 64-token reason
 * budget: it returns "Let me analyze this article..." cut mid-word, and the old
 * decoder handed that to the reader as the card's "why this matters to you".
 *
 * Deliberately narrow, anchored, and case-sensitive on the first letter,
 * because real reasons start with capitals and some start with these letters:
 * "Indian rail strike...", "Letting agents in Amsterdam...", "First-time buyer
 * rules...". Each alternative therefore requires what FOLLOWS the word, not
 * just the word.
 */
const DELIBERATION_OPENER =
  /^(?:Let(?: me| us|'s) |First,? I |I(?:'ll| will| need to| am going to| should) |Okay,? |OK,? |Alright,? |Looking at (?:this|the) (?:article|user))/;

/**
 * A reason that tells the reader about the SCORING SYSTEM instead of the news.
 *
 * The shipped prompt bans it in words and the promoted v2 rules ban it again,
 * and the model still does it: measured over 567 reasons in one interleaved
 * run, 10 named a score ("warranting a high FEED score", "warranting a feed
 * score of 0.68"). That is 1.8% overall, and it survived a prompt rule written
 * specifically to stop it, which is the whole argument for enforcing it here:
 * a prompt rule is advice, a decoder is not.
 *
 * THE BARE-DECIMAL CLAUSE IS THE RISKY ONE and it is deliberately narrow. A
 * reason may legitimately carry a figure ("a 0.5% cut", "0.25 percentage
 * points"), so a decimal is only treated as a leaked score when it is NOT
 * followed by a percent sign or a unit word. That still leaves a real false
 * positive available - a story about a 0.75 exchange rate - and that trade is
 * accepted on frequency: a reason quoting a bare sub-1 decimal that is not a
 * percentage is far rarer than the model narrating its own score, and the cost
 * of the false positive is one missing note rather than a wrong one.
 */
const REASON_NAMES_A_SCORE =
  /\b(?:feed score|relevance score|score of|priority score)\b|\b0\.\d{1,2}\b(?!\s*(?:%|percent|percentage|pp\b))/i;

/**
 * A pass-2 score, decoded from the reason call's `{"k","s","reason"}` object.
 *
 * WHY PASS 2 SCORES AT ALL. Pass 1 judges five articles in one batched call and
 * is the cheap filter; pass 2 visits ONE article with the same rubric and the
 * same facts, and can therefore see what a batch cannot. Measured n=9 on the
 * Portuguese parental-leave story against a Dutch persona: pass 1 emitted
 * `k:"home"` 6/9 even with the publication's country in the prompt, while the
 * reason pass was already writing "foreign-domestic, no tie" and had no way to
 * act on it, because its output was a bare string.
 */
export interface ReasonRescore {
  /** The stake tag pass 2 chose. Always a key of {@link STAKE_SCORE_BANDS}: an
   *  unrecognised tag yields no rescore at all, so an invented tag can never
   *  skip the band discipline by falling back to a plain 0–1.1 clamp. */
  k: string;
  /** `s` exactly as the model emitted it, before any clamping. Kept so a
   *  caller can see what the model said as well as what was used. */
  s: number;
  /** `s` clamped into the band `k` declares. THIS is the value that replaces
   *  the pass-1 score. */
  score: number;
}

/**
 * Optional counters a CALLER may pass into {@link parseReasonResult}, in the
 * same spirit and with the same non-instrumentation guarantee as
 * {@link RelevanceDecodeStats}: they count properties of MODEL OUTPUT within one
 * decode call, nothing is keyed to a reader, nothing is persisted, and
 * production passes none.
 *
 * There is deliberately NO "band changed up/down" counter here. That metric
 * compares the pass-2 band against the PASS-1 band, and the decoder never sees
 * a pass-1 score — it decodes one response in isolation. Computing it here
 * would mean inventing a baseline. It belongs to whoever holds both scores,
 * which is the runner.
 */
export interface ReasonDecodeStats {
  /** Responses that yielded a usable `k` + `s`. */
  rescoreApplied: number;
  /** Responses with no usable `k` + `s`: a legacy plain string, a `{reason}`
   *  object, a truncated object that failed `JSON.parse`, a non-numeric `s`, or
   *  a `k` that is not a known stake tag. Every one of these leaves the pass-1
   *  score standing. */
  rescoreUnparsed: number;
  /** Rescores whose `s` fell outside the band its own `k` declares and was
   *  clamped into it. The prompt states the band rule, so this is a free,
   *  rater-free measure of how well the model held its own output contract —
   *  exactly what `bandViolations` measures for pass 1. */
  rescoreBandViolations: number;
  /** Total absolute distance those violations were moved by the clamp. Divide
   *  by `rescoreBandViolations` for the mean severity. */
  rescoreBandViolationMass: number;
}

/** A zeroed accumulator. Callers that want stats create one and pass it in. */
export function newReasonDecodeStats(): ReasonDecodeStats {
  return {
    rescoreApplied: 0,
    rescoreUnparsed: 0,
    rescoreBandViolations: 0,
    rescoreBandViolationMass: 0,
  };
}

/**
 * A response wholly wrapped in a markdown code fence, unwrapped.
 *
 * The reason prompt says "no markdown", and for a plain-string answer the
 * existing `[*#]` strip was enough. An OBJECT answer is different: ```` ```json ````
 * is the single most common way a model dresses up JSON, and a fenced object
 * fails `JSON.parse` outright, which would cost the rescore AND (via the
 * bare-decimal rule seeing the raw `"s":0.62`) the reason too. Anchored at both
 * ends so it can never bite a reason that merely contains a backtick.
 */
function stripCodeFence(text: string): string {
  const m = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(text);
  return m ? m[1].trim() : text;
}

/**
 * Pull `{"k","s"}` out of an already-parsed pass-2 object, or nothing.
 *
 * FAILS OPEN, ALWAYS. Every rejection here means "the pass-1 score stands",
 * never "demote" and never "throw". The one thing it will not do is accept a
 * tag it does not recognise: `clampToStakeBand` falls back to a plain 0–1.1
 * clamp on an unknown `k`, which would let an invented tag put any number it
 * liked onto the row.
 */
function extractRescore(
  parsed: Record<string, unknown>,
  stats?: ReasonDecodeStats,
): ReasonRescore | undefined {
  const k = parsed.k;
  const s = parsed.s;
  if (typeof k !== 'string' || STAKE_SCORE_BANDS[k] === undefined) return undefined;
  if (typeof s !== 'number' || !Number.isFinite(s)) return undefined;
  const score = clampToStakeBand(s, k);
  if (stats) {
    const band = STAKE_SCORE_BANDS[k];
    // Measured against the RAW value, not the 0–1.1 clamp, for the same reason
    // `clampToStakeBand`'s own accounting is: a wild `s` should report its real
    // distance rather than the distance left after another clamp hid most of it.
    const distance = s < band[0] ? band[0] - s : s > band[1] ? s - band[1] : 0;
    if (distance > 0) {
      stats.rescoreBandViolations++;
      stats.rescoreBandViolationMass += distance;
    }
  }
  return { k, s, score };
}

/**
 * Decode one pass-2 response into the reason the reader sees and, when the
 * response carried one, the score that replaces pass 1's.
 *
 * THE TWO HALVES FAIL IN OPPOSITE DIRECTIONS, ON PURPOSE.
 *  - The SCORE fails open: anything unparseable leaves the pass-1 score exactly
 *    where it was. An unreadable answer is not evidence that an article should
 *    move, in either direction.
 *  - The REASON fails closed, exactly as it always has: the reasoning-trace
 *    rejection, the deliberation-opener rejection and
 *    {@link REASON_NAMES_A_SCORE} all still return an empty reason, and the row
 *    stays `reason_pending` for the sweep.
 *
 * THE BARE-DECIMAL RULE IS NOT MOVED OFF THE RAW-TEXT PATH, and that is
 * load-bearing. A TRUNCATED object — `{"k":"home","s":0.62,"reason":"Parliament's
 * delay` — fails `JSON.parse`, so it arrives at that rule as raw text carrying a
 * visible `0.62` and is rejected. Applying the rule only to an extracted
 * `reason` FIELD would have let that same string through the strip chain and
 * onto the card as the reader-facing note.
 */
export function parseReasonResult(
  output: string,
  id: string,
  prompt?: string,
  logger: HarnessLogger = NOOP_LOGGER,
  stats?: ReasonDecodeStats,
): { reason: string; rescore?: ReasonRescore } {
  let text = output.trim();
  let rescore: ReasonRescore | undefined;

  // A leaked reasoning trace, handled BEFORE anything else so no later step can
  // tidy one into something that reads like prose. Two shapes, both measured
  // live against z-ai/glm-5.3-flash:
  //
  //  - `trace</think>answer` — keep only what follows the LAST closer. This is
  //    the same rule as lib/llm/reasoning-leak, applied here so it also covers
  //    the on-device path and harness-local, neither of which goes through
  //    cloudComplete.
  //  - an UNCLOSED `<think>` — the trace was cut before the model finished
  //    thinking, so there is no answer in the string at all. Reject.
  const lastCloser = text.lastIndexOf('</think>');
  if (lastCloser !== -1) {
    text = text.slice(lastCloser + '</think>'.length).trim();
  } else if (text.includes('<think>')) {
    logger.warn('Reason generation: unclosed reasoning trace — rejected', { id });
    if (stats) stats.rescoreUnparsed++;
    return { reason: '' };
  }

  if (DELIBERATION_OPENER.test(text)) {
    logger.warn('Reason generation: output is deliberation, not a reason', {
      id,
      output: text.slice(0, 120),
    });
    if (stats) stats.rescoreUnparsed++;
    return { reason: '' };
  }

  try {
    const parsed: unknown = JSON.parse(stripCodeFence(text));
    if (typeof parsed === 'string' && parsed.length > 0) {
      text = parsed;
    } else if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      rescore = extractRescore(obj, stats);
      // `'reason' in obj` stays the guard for the TEXT half: an object carrying
      // only `k`/`s` is a score with no note, which is a different state from a
      // note that failed to parse, and `text` must keep its raw value so the
      // existing failure logging still shows what arrived.
      if (typeof obj.reason === 'string') text = obj.reason;
    }
  } catch {
    text = text.replace(/^["']|["']$/g, '');
  }
  if (stats) {
    if (rescore) stats.rescoreApplied++;
    else stats.rescoreUnparsed++;
  }

  text = text
    .replace(/\*?\*?\[User facts\]\*?\*?.*$/gm, '')
    .replace(/\*?\*?Relevance Score:?\s*[\d.]+\*?\*?/gi, '')
    .replace(/\*?\*?Why this matters to you:?\*?\*?\s*/gi, '')
    .replace(/[*#]+/g, '')
    .replace(/\n+/g, ' ');
  // Dashes are replaced BEFORE the whitespace collapse on purpose: ", " emitted
  // where the model already had spaces around the dash would otherwise leave a
  // double space, and the existing collapse cleans it up for free.
  text = replaceClauseDashes(text)
    .replace(/\s{2,}/g, ' ')
    .trim();

  // The score guard runs HERE, after the echoed-label strip, not before it.
  // The two cases look similar and are not: "Relevance Score: 0.62 Dutch tax
  // vote affects your work." is the model echoing its own INPUT, and the strip
  // above has always repaired it into a perfectly good sentence - rejecting
  // that would cost the reader a note over a formatting slip. What this rejects
  // is the model narrating a score TO THE READER, which no strip can repair
  // because the score is load-bearing in the prose ("warranting a 0.68 feed
  // score"). Checking before the strip conflated the two and threw away the
  // repairable one; a test caught it.
  if (REASON_NAMES_A_SCORE.test(text)) {
    logger.warn('Reason generation: reason names the score to the reader', {
      id,
      output: text.slice(0, 120),
    });
    // The rescore SURVIVES a rejected reason. The two are separate judgements
    // arriving in one response: the model narrating its score to the reader is
    // a voice defect in the sentence, not evidence that the number is wrong.
    return { reason: '', rescore };
  }

  if (text.length > 0) {
    return { reason: cutAtWordBoundary(text, REASON_MAX_CHARS), rescore };
  }

  logger.warn('Reason generation: failed to parse LLM output', {
    output: output.trim(),
    id,
    prompt,
  });

  return { reason: '', rescore };
}

/**
 * The reason half of {@link parseReasonResult}.
 *
 * Kept as the signature it has always had — `string` in, `string` out — because
 * several call sites want only the sentence, and because harness-local runners
 * compile against it. A caller that wants the pass-2 score calls
 * `parseReasonResult` directly.
 */
export function parseReasonResponse(
  output: string,
  id: string,
  prompt?: string,
  logger: HarnessLogger = NOOP_LOGGER,
): string {
  return parseReasonResult(output, id, prompt, logger).reason;
}
