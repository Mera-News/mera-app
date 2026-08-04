// news-harness — fact-combination top-up planning (PURE, RN-free).
//
// r12 J-P1. Topic generation is point-in-time: a topic minted from fact A (plus
// whatever facts existed alongside it) never revisits that decision. If the user
// later adds fact B that would have combined with A into a richer topic, that
// topic is never created. This module decides which facts are worth revisiting
// and builds the ONE combo-only call that revisits them.
//
// Two callers, one code path — deliberately:
//   • the weekly sweep asks "what changed since the watermark?"  (mode 'watermark')
//   • the one-time backfill asks "this fact just lost topics, refill it NOW"
//     (mode 'fillTo')
// A third generator would be the obvious way for the scheduled path and the
// one-shot path to silently drift apart, so there isn't one.
//
// The fact-only half is never re-run: it does not read other facts at all (its
// prompt says so explicitly), so re-running it is pure token waste and pure
// duplicate risk.

import { CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT } from '../prompts/prompts';
import { DEFAULT_HARNESS_CONFIG } from '../core/config';
import type { BatchCall } from '../core/types';
import { buildBaseUserPrompt } from './topic-generation';

const TOPIC_CFG = DEFAULT_HARNESS_CONFIG.topicGen;

/**
 * Ceiling on a fact's ACTIVE topics that the top-up will fill toward.
 *
 * Deliberately equal to HYGIENE_THRESHOLDS.tooBroadTopicFanout (8): a fact above
 * that gets a `too_broad_fact` downweight proposal, so a top-up that pushed
 * facts past it would make the same sweep run argue with itself — fattening a
 * fact and then proposing to penalise it. Because eligibility requires headroom,
 * growth CONVERGES instead of ratcheting: a fact stops being eligible at 8, so
 * the top-up can only ever refill room made by retires and user deletes.
 */
export const TOPUP_FANOUT_CEILING = 8;

/** New topics one fact may gain in a single sweep. */
export const TOPUP_MAX_TOPICS_PER_FACT = 2;

/** Facts revisited per sweep. 4 x 2 = at most 8 new topics per weekly run. */
export const TOPUP_MAX_FACTS_PER_SWEEP = 4;

/** Newest supporting facts injected into the prompt. Bounds prompt tokens and
 *  keeps the model focused on what actually changed. */
export const TOPUP_MAX_NEW_FACTS_IN_PROMPT = 5;

export interface TopupFactInput {
  id: string;
  statement: string;
  createdAtMs: number;
}

export interface TopupTopicInput {
  id: string;
  factId: string;
  text: string;
  /** Epoch ms the row was minted — the per-fact watermark is the max of these. */
  createdAtMs: number;
  /** Only ACTIVE topics count toward the fan-out ceiling. */
  isActive: boolean;
}

export interface TopupCandidate {
  factId: string;
  statement: string;
  /** Facts newer than this fact's watermark, newest-first, already capped. */
  supportingFacts: string[];
  /** Topics to request — never more than the fact's remaining headroom. */
  requestCount: number;
  /** Texts the model must not regenerate (this fact's current topics). */
  excludeTopics: string[];
  /** The watermark this candidate was considered against; the caller persists it
   *  whether or not rows were minted, which is what stops re-consideration. */
  consideredThroughMs: number;
}

export interface SelectTopupOptions {
  /** 'watermark' — only facts with genuinely newer supporting facts (weekly).
   *  'fillTo'    — refill named facts to a target now (one-time backfill). */
  mode?: 'watermark' | 'fillTo';
  /** mode 'fillTo': factId → the active-topic count to restore. */
  fillTargets?: Map<string, number>;
  /** Per-fact watermarks already persisted by a previous run (KV), merged with
   *  the DB-derived max(createdAt) so losing the blob degrades gracefully. */
  consideredThroughByFact?: Map<string, number>;
  /** Facts a higher-priority proposal is about to delete — never worth topping up. */
  excludeFactIds?: Set<string>;
  nowMs?: number;
  maxFacts?: number;
  maxTopicsPerFact?: number;
  fanoutCeiling?: number;
}

/** Lowercase word tokens — same shape the hygiene analyzer uses. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Choose the facts worth revisiting this run.
 *
 * A fact is eligible only when ALL hold:
 *   1. it has headroom below the fan-out ceiling;
 *   2. (watermark mode) at least one OTHER fact is newer than its watermark —
 *      that fact was definitionally absent from the original combo prompt;
 *   3. it is not itself brand new (it was just generated with full context);
 *   4. it is not scheduled for deletion by a higher-priority proposal;
 *   5. it has at least one supporting fact to combine with.
 *
 * Ordered oldest-watermark-first so the most stale facts are revisited first,
 * then sliced. Ties break on factId so the selection is deterministic.
 */
export function selectTopupCandidates(
  facts: TopupFactInput[],
  topics: TopupTopicInput[],
  opts: SelectTopupOptions = {},
): TopupCandidate[] {
  const mode = opts.mode ?? 'watermark';
  const nowMs = opts.nowMs ?? Date.now();
  const maxFacts = opts.maxFacts ?? TOPUP_MAX_FACTS_PER_SWEEP;
  const maxPerFact = opts.maxTopicsPerFact ?? TOPUP_MAX_TOPICS_PER_FACT;
  const ceiling = opts.fanoutCeiling ?? TOPUP_FANOUT_CEILING;
  const excluded = opts.excludeFactIds ?? new Set<string>();

  const activeCount = new Map<string, number>();
  const newestTopicMs = new Map<string, number>();
  const textsByFact = new Map<string, string[]>();
  for (const t of topics) {
    if (t.isActive) activeCount.set(t.factId, (activeCount.get(t.factId) ?? 0) + 1);
    newestTopicMs.set(t.factId, Math.max(newestTopicMs.get(t.factId) ?? 0, t.createdAtMs));
    const list = textsByFact.get(t.factId) ?? [];
    list.push(t.text);
    textsByFact.set(t.factId, list);
  }

  const out: (TopupCandidate & { _sortKey: number })[] = [];

  for (const fact of facts) {
    if (excluded.has(fact.id)) continue;

    // A fact with NO topic rows at all has never had a successful generation —
    // it is mid-flight or failed, and `retryTopicGeneration` owns that case.
    // Without this it would also have watermark 0, making every other fact look
    // "newer" and selecting the brand-new fact that was just generated with the
    // full persona in context.
    if (!newestTopicMs.has(fact.id)) continue;

    const active = activeCount.get(fact.id) ?? 0;

    // Headroom. In fillTo mode the target may be below the ceiling; never above.
    const target =
      mode === 'fillTo'
        ? Math.min(opts.fillTargets?.get(fact.id) ?? 0, ceiling)
        : ceiling;
    const headroom = target - active;
    if (headroom <= 0) continue;

    // The watermark: the later of what we persisted and what the rows show, so
    // a lost KV blob degrades to "recompute from rows" rather than re-firing.
    const watermark = Math.max(
      opts.consideredThroughByFact?.get(fact.id) ?? 0,
      newestTopicMs.get(fact.id) ?? 0,
    );

    const newerFacts = facts
      .filter((f) => f.id !== fact.id && f.createdAtMs > watermark)
      .sort((a, b) => b.createdAtMs - a.createdAtMs);

    // In fillTo mode we regenerate regardless of newness (the fact just lost
    // topics), so fall back to the most recent other facts for context.
    const supportingPool =
      mode === 'fillTo' && newerFacts.length === 0
        ? facts
            .filter((f) => f.id !== fact.id)
            .sort((a, b) => b.createdAtMs - a.createdAtMs)
        : newerFacts;

    if (mode === 'watermark' && newerFacts.length === 0) continue;
    if (supportingFactsAreUnusable(supportingPool)) continue;

    out.push({
      factId: fact.id,
      statement: fact.statement,
      supportingFacts: supportingPool
        .slice(0, TOPUP_MAX_NEW_FACTS_IN_PROMPT)
        .map((f) => f.statement),
      requestCount: Math.min(maxPerFact, headroom),
      excludeTopics: textsByFact.get(fact.id) ?? [],
      consideredThroughMs: nowMs,
      _sortKey: watermark,
    });
  }

  return out
    .sort((a, b) =>
      a._sortKey !== b._sortKey
        ? a._sortKey - b._sortKey
        : a.factId < b.factId
          ? -1
          : a.factId > b.factId
            ? 1
            : 0,
    )
    .slice(0, maxFacts)
    .map(({ _sortKey: _drop, ...c }) => c);
}

function supportingFactsAreUnusable(pool: TopupFactInput[]): boolean {
  return pool.length === 0;
}

/**
 * Build the ONE combo-only call for a candidate.
 *
 * Not a flag on `buildCloudBatchCallsForFact`: that builder always emits the
 * fact-only half when its count is > 0, and the top-up must never re-run it.
 * Thinking is ON for the same reason it is on for generation — deciding whether
 * a genuine combination exists is exactly the judgement being asked for.
 */
export function buildComboOnlyBatchCall(
  candidate: TopupCandidate,
  userLocation: string | null = null,
): BatchCall {
  const prompt = buildBaseUserPrompt(
    {
      factStatement: candidate.statement,
      userLocation,
      otherFacts: candidate.supportingFacts,
      excludeTopics: candidate.excludeTopics,
    },
    true,
  );
  return {
    id: `topup:${candidate.factId}`,
    system: CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
    prompt: `${prompt}\nGenerate at most ${candidate.requestCount} topics — fewer is correct.`,
    temperature: 0.3,
    maxTokens: TOPIC_CFG.cloudThinkingMaxTokens,
    enableThinking: true,
  };
}

export interface PlannedTopupRow {
  text: string;
  normalizedText: string;
}

/**
 * Plan the rows to actually mint.
 *
 * Wider than `planLlmTopicRows` in two ways that both matter:
 *
 *  1. The exclusion set is GLOBAL, not per-fact. A text already held by ANY
 *     topic row — any fact, any status, any provenance — is skipped. This is
 *     what stops the top-up minting a text that a `tracked` topic already owns:
 *     tracked-topic articles hydrate through a quota-exempt path, and a
 *     colliding metered row silently makes that followed story billable again.
 *     It is also what stops the sweep re-appending, week after week, exactly
 *     what the sanity pass just persuaded the user to retire.
 *  2. Near-duplicates are rejected by token Jaccard, not just exact normalized
 *     equality — "Indian cricket team news" vs "India cricket team news" are the
 *     same topic wearing different words, and appending both is the "three
 *     near-identical topics" failure this feature must not create.
 */
/**
 * Token-Jaccard threshold for "this is the same topic in different words".
 *
 * 0.6, MEASURED — not inherited. HYGIENE_THRESHOLDS.duplicateStatementJaccard is
 * 0.8, but that compares fact STATEMENTS (whole sentences); topics are 1-5 words,
 * where 0.8 is far too strict to fire. Measured over real pairs:
 *
 *   0.60  "indian cricket team news" / "india cricket team news"
 *   0.67  "startup tax" / "startup tax incentives"        (prompt calls these out)
 *   0.67  "startup funding" / "startup funding rules"     (   "        "        )
 *   0.75  "bengaluru cricket news" / "... news updates"
 *   ----- decision boundary, 0.2 of clear air -----
 *   0.40  "amsterdam expat tech jobs" / "amsterdam expat childcare"  (DIFFERENT)
 *   0.20  "india tech regulation" / "india tax policy"               (DIFFERENT)
 *   0.00  "indian cricket team news" / "bengaluru stadium redevelopment"
 *
 * KNOWN LIMITATION: bag-of-words similarity cannot catch every restatement —
 * "EU startup regulation" vs "EU startup regulatory changes" scores 0.40 and
 * passes. This check is a backstop, not the primary defence; the prompt's own
 * no-near-synonym rule and the `excludeTopics` list are what the model sees
 * first.
 */
export const TOPUP_SIMILARITY_THRESHOLD = 0.6;

export function planTopupTopicRows(
  globalNormalizedTexts: Iterable<string>,
  incomingTexts: string[],
  normalize: (s: string) => string,
  similarityThreshold = TOPUP_SIMILARITY_THRESHOLD,
): PlannedTopupRow[] {
  const seen = new Set<string>();
  const seenTokens: Set<string>[] = [];
  for (const n of globalNormalizedTexts) {
    seen.add(n);
    seenTokens.push(new Set(tokenize(n)));
  }

  const out: PlannedTopupRow[] = [];
  for (const raw of incomingTexts) {
    const text = raw.trim();
    if (!text) continue;
    const normalizedText = normalize(text);
    if (!normalizedText || seen.has(normalizedText)) continue;

    const tokens = new Set(tokenize(normalizedText));
    let tooSimilar = false;
    for (const prior of seenTokens) {
      if (jaccard(tokens, prior) >= similarityThreshold) {
        tooSimilar = true;
        break;
      }
    }
    if (tooSimilar) continue;

    seen.add(normalizedText);
    seenTokens.push(tokens);
    out.push({ text, normalizedText });
  }
  return out;
}
