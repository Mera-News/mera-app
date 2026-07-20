// fact-batching — PURE, RN-free grouping of scoring candidates into per-fact
// batches for the Round-3 per-fact pipelined scoring flow.
//
// Each candidate is assigned its PRIMARY (strongest owning) fact by reusing the
// exact ownership semantics + deterministic tie-breaks the feed selector uses
// (resolveOwningFact / resolveOwnership in feed-select/sections.ts). Candidates
// whose owning fact has fewer than MIN_FACT_GROUP candidates — plus genuine
// orphans (no positive owning fact) — collapse into a single `factId: null`
// tail so a slow trickle of one-off facts never spawns a swarm of tiny gateway
// jobs. Real fact groups are ordered by fact weight (desc), then id (asc), so
// the strongest-interest facts populate the feed first.
//
// The pipeline loads the DB-backed inputs (candidate metadata + topic/fact
// snapshots) and calls groupCandidatesByPrimaryFact; everything here is a pure
// function of its arguments, unit-tested without a device.

import {
  resolveOwningFact,
  type ScoredSuggestionProjection,
  type MatchedTopicProjection,
  type TopicSnapshot,
  type FactSnapshot,
} from '@/lib/news-harness/feed-select';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';

/** Facts owning fewer than this many candidates merge into the `null` tail. */
export const MIN_FACT_GROUP = 3;

/** The minimal per-candidate view the grouper needs. */
export interface FactGroupingCandidate {
  id: string;
  /** Parsed `matched_topics_json` — [{ topicId, text }]. */
  matchedTopics: MatchedTopicProjection[];
  /** Facts linked to this suggestion (from `article_suggestion_facts`) — the
   *  source of the human statement for the owning fact. */
  relatedFacts: { id: string; statement: string }[];
}

/** One planned batch: a contiguous slice of ids sharing a primary fact. */
export interface FactBatchSpec {
  factId: string | null;
  factStatement: string | null;
  ids: string[];
}

function primaryFactOf(
  cand: FactGroupingCandidate | undefined,
  topics: Map<string, TopicSnapshot>,
  facts: Map<string, FactSnapshot>,
  hpMult: number,
): string | null {
  if (!cand || cand.matchedTopics.length === 0) return null;
  // resolveOwningFact only reads rep.matchedTopics — build a minimal projection.
  const rep = { matchedTopics: cand.matchedTopics } as ScoredSuggestionProjection;
  return resolveOwningFact(rep, topics, facts, hpMult);
}

function statementFor(
  factId: string,
  candidates: FactGroupingCandidate[],
  facts: Map<string, FactSnapshot>,
): string | null {
  for (const c of candidates) {
    const hit = c.relatedFacts.find((f) => f.id === factId);
    if (hit && hit.statement) return hit.statement;
  }
  return facts.get(factId)?.statement ?? null;
}

/**
 * Group `orderedIds` into per-fact batch specs.
 *
 * @param orderedIds     the fresh candidate ids to schedule, in enqueue order.
 * @param metaById       id → its grouping metadata (missing ⇒ treated as orphan).
 * @param topics         topicId → snapshot (weight/highPriority/factId/status).
 * @param facts          factId → snapshot (weight/createdAtMs/statement).
 * @param batchSize      max ids per emitted batch.
 * @param hpMult         high-priority multiplier (defaults to the harness value).
 *
 * Ordering: real fact groups first (fact weight desc, factId asc), each chunked
 * at `batchSize`; then the merged `factId: null` tail (orphans + sub-MIN_FACT_GROUP
 * facts, in original `orderedIds` order), chunked at `batchSize`. When the
 * snapshots are empty (no persona metadata) every id resolves to the tail, so
 * the output degrades to plain sequential chunks — identical to the pre-Round-3
 * behaviour.
 */
export function groupCandidatesByPrimaryFact(
  orderedIds: string[],
  metaById: Map<string, FactGroupingCandidate>,
  topics: Map<string, TopicSnapshot>,
  facts: Map<string, FactSnapshot>,
  batchSize: number,
  hpMult: number = DEFAULT_HARNESS_CONFIG.scoringEngine.HP_MULT,
): FactBatchSpec[] {
  // 1. Resolve each id's primary fact (null ⇒ orphan/tail).
  const factOf = new Map<string, string | null>();
  const groupIds = new Map<string, string[]>(); // factId → ids (first-seen order)
  for (const id of orderedIds) {
    const factId = primaryFactOf(metaById.get(id), topics, facts, hpMult);
    factOf.set(id, factId);
    if (factId != null) {
      const bucket = groupIds.get(factId) ?? [];
      bucket.push(id);
      groupIds.set(factId, bucket);
    }
  }

  // 2. Facts below MIN_FACT_GROUP collapse into the tail.
  const survivingFacts = new Set<string>();
  for (const [factId, list] of groupIds) {
    if (list.length >= MIN_FACT_GROUP) survivingFacts.add(factId);
  }

  // 3. Order surviving fact groups: weight desc, then factId asc.
  const orderedFacts = [...survivingFacts].sort((a, b) => {
    const wa = facts.get(a)?.weight ?? 1;
    const wb = facts.get(b)?.weight ?? 1;
    if (wa !== wb) return wb - wa;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const specs: FactBatchSpec[] = [];
  const chunk = (ids: string[], factId: string | null, statement: string | null) => {
    for (let i = 0; i < ids.length; i += batchSize) {
      specs.push({ factId, factStatement: statement, ids: ids.slice(i, i + batchSize) });
    }
  };

  const candidatesByFact = new Map<string, FactGroupingCandidate[]>();
  for (const id of orderedIds) {
    const factId = factOf.get(id);
    if (factId == null || !survivingFacts.has(factId)) continue;
    const meta = metaById.get(id);
    if (!meta) continue;
    const bucket = candidatesByFact.get(factId) ?? [];
    bucket.push(meta);
    candidatesByFact.set(factId, bucket);
  }

  for (const factId of orderedFacts) {
    const statement = statementFor(factId, candidatesByFact.get(factId) ?? [], facts);
    chunk(groupIds.get(factId)!, factId, statement);
  }

  // 4. Tail: everything whose final owning fact didn't survive, in enqueue order.
  const tail = orderedIds.filter((id) => {
    const factId = factOf.get(id);
    return factId == null || !survivingFacts.has(factId);
  });
  chunk(tail, null, null);

  return specs;
}
