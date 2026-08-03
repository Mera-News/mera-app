// news-harness — topic-sanity planning + verdict decoding (PURE, RN-free).
//
// r12 K-P3. The weekly hygiene sweep asks an LLM whether each already-minted
// topic genuinely belongs to the fact that owns it, so the combo-prompt
// contamination ("Amsterdam cricket festival music tech") can be cleaned up
// rather than only prevented. Everything that can be decided without a database
// or a network call lives here: which topics to audit, how to batch them, how to
// render the prompt, and how to decode the verdicts.
//
// The RN adapter (lib/database/services/topic-sanity-service.ts) supplies live
// rows, issues the batch call, and turns the verdicts into hygiene proposals.

import { TOPIC_SANITY_SYSTEM_PROMPT } from '../prompts/prompts';
import { NOOP_LOGGER, type HarnessLogger } from '../core/ports';
import type { BatchCall } from '../core/types';

/** Topics per BatchCall. 15 keeps the reasoning trace comfortably inside
 *  SANITY_MAX_TOKENS while amortising the system prompt across enough items. */
export const SANITY_BATCH_SIZE = 15;

/** Per-sweep audit ceiling. Doing double duty: it bounds cost AND keeps the
 *  whole audit inside the sweep's race window (4 batches, one HTTP round trip).
 *  Raising it means revisiting both. */
export const SANITY_MAX_TOPICS_PER_SWEEP = 60;

/** Output budget per sanity BatchCall. Thinking is ON, so the reasoning trace
 *  shares this with the answer: ~15 verdicts ≈ 210 tokens, leaving ~2.8k for the
 *  trace. Sized deliberately rather than reusing the topic-gen budget. */
export const SANITY_MAX_TOKENS = 3072;

/** A topic the sweep may audit, projected free of WatermelonDB. */
export interface SanityTopicInput {
  id: string;
  factId: string;
  text: string;
  /** Epoch ms — audit order is oldest-first so the contaminated backlog drains
   *  before newly minted topics. */
  createdAtMs: number;
}

export interface SanityFactInput {
  id: string;
  statement: string;
}

export interface SanityBatchPlan {
  /** The calls to issue (already capped + batched). */
  calls: BatchCall[];
  /** Topic ids per call id, positionally aligned with the prompt's numbering,
   *  so a verdict index maps back to a topic without trusting the model to
   *  echo ids. */
  topicIdsByCallId: Map<string, string[]>;
  /** The newest createdAtMs among audited topics — the cursor advances here
   *  ONLY once verdicts come back. 0 when nothing was planned. */
  maxCreatedAtMs: number;
}

/**
 * Choose which topics to audit this sweep and shape them into batch calls.
 *
 * Selection is `createdAtMs > cursor`, oldest-first, capped. Sound because a
 * topic's createdAt is set at mint and its text never changes afterwards, so
 * nothing can appear BEHIND the cursor — a monotonic cursor is equivalent to a
 * per-row "audited" flag for every row not yet seen, without a schema change.
 *
 * Topics whose owning fact is missing are skipped (nothing to judge them
 * against). Exclusions that depend on provenance or tracked-story binding are
 * applied by the caller before this point.
 */
export function planSanityBatches(
  topics: SanityTopicInput[],
  facts: SanityFactInput[],
  cursorMs: number,
  opts: { batchSize?: number; maxTopics?: number } = {},
): SanityBatchPlan {
  const batchSize = opts.batchSize ?? SANITY_BATCH_SIZE;
  const maxTopics = opts.maxTopics ?? SANITY_MAX_TOPICS_PER_SWEEP;

  const statementById = new Map(facts.map((f) => [f.id, f.statement]));

  const eligible = topics
    .filter((t) => t.createdAtMs > cursorMs && statementById.has(t.factId))
    .sort((a, b) =>
      a.createdAtMs !== b.createdAtMs
        ? a.createdAtMs - b.createdAtMs
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    )
    .slice(0, maxTopics);

  const calls: BatchCall[] = [];
  const topicIdsByCallId = new Map<string, string[]>();
  let maxCreatedAtMs = 0;

  for (let i = 0; i < eligible.length; i += batchSize) {
    const chunk = eligible.slice(i, i + batchSize);
    const id = `sanity:${i / batchSize}`;
    calls.push({
      id,
      system: TOPIC_SANITY_SYSTEM_PROMPT,
      prompt: renderSanityPrompt(chunk, statementById),
      temperature: 0.1,
      maxTokens: SANITY_MAX_TOKENS,
      enableThinking: true,
    });
    topicIdsByCallId.set(
      id,
      chunk.map((t) => t.id),
    );
    for (const t of chunk) {
      if (t.createdAtMs > maxCreatedAtMs) maxCreatedAtMs = t.createdAtMs;
    }
  }

  return { calls, topicIdsByCallId, maxCreatedAtMs };
}

/** Group topics under their fact so the model sees each verdict in the only
 *  context that makes it judgeable, while keeping ONE flat 1-based numbering. */
export function renderSanityPrompt(
  chunk: SanityTopicInput[],
  statementById: Map<string, string>,
): string {
  const byFact = new Map<string, { text: string; n: number }[]>();
  chunk.forEach((t, idx) => {
    const list = byFact.get(t.factId) ?? [];
    list.push({ text: t.text, n: idx + 1 });
    byFact.set(t.factId, list);
  });

  const blocks: string[] = [];
  for (const [factId, items] of byFact) {
    blocks.push(`Fact: "${statementById.get(factId) ?? ''}"`);
    for (const it of items) blocks.push(`${it.n}. "${it.text}"`);
  }
  blocks.push('', `Return exactly ${chunk.length} verdicts.`);
  return blocks.join('\n');
}

/**
 * Decode one call's verdict array into the topic ids judged INCOHERENT.
 *
 * Fail-safe by construction: anything unparseable, out of range, or simply
 * missing leaves its topic untouched (treated as ok). A malformed response can
 * therefore never cause a retire proposal — only a missed one, which the next
 * sweep can still catch.
 */
export function decodeSanityVerdicts(
  output: string,
  topicIds: string[],
  logger: HarnessLogger = NOOP_LOGGER,
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    const m = output.match(/\[[\s\S]*\]/);
    if (!m) {
      logger.warn('[topic-sanity] unparseable verdict output', { output });
      return [];
    }
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      logger.warn('[topic-sanity] unparseable verdict array', { output });
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    logger.warn('[topic-sanity] verdicts were not an array', { output });
    return [];
  }

  const flagged: string[] = [];
  const seen = new Set<number>();
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const { i, ok } = item as { i?: unknown; ok?: unknown };
    if (typeof i !== 'number' || !Number.isInteger(i)) continue;
    if (ok !== false) continue; // only an explicit false flags anything
    const idx = i - 1; // prompt numbering is 1-based
    if (idx < 0 || idx >= topicIds.length) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    flagged.push(topicIds[idx]);
  }
  return flagged;
}
