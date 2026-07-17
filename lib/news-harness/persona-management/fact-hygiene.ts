// news-harness — periodic persona fact-hygiene analyzer (PURE, RN-free).
//
// Wave 11 U-B3/N6. A deterministic O(facts² + topics) sweep over plain persona
// snapshots that proposes conservative cleanups for the weekly hygiene sweep:
//   • duplicate_facts — two facts with near-identical statements, OR sharing ≥2
//     of the SAME normalized topic texts (via the fact-stats cross-fact detector)
//   • too_broad_fact  — a fact fanning out to too many active topics, or whose
//     statement is a single generic word → downweight it
//   • stale_topic     — a low-weight active topic idle past the stale window
//   • stale_fact      — a fact whose owned topics are ALL retired/suppressed
//
// No imports of lib/database, lib/stores, expo, react-native, or watermelondb —
// the RN adapter (lib/database/services/hygiene-service.ts) maps live rows into
// these shapes, calls analyzeHygiene, and routes an accepted proposal's `ops`
// through the persona-action executor / fact-service.
//
// NOTE ON CONFIG PLACEMENT: the thresholds below live in THIS file (exported
// consts), NOT in core/config.ts — that harness-config module is owned by the
// concurrent chat-rail work this round, so hygiene knobs are colocated with the
// only code that reads them. If they ever need runtime tuning, promote them.

import { ACTION_NAMES, type ActionName } from './action-names';
import { findTopicOverlapAcrossFacts } from '../feed-select/fact-stats';

// ── Thresholds (conservative by design) ─────────────────────────────────────

export const HYGIENE_THRESHOLDS = {
  /** Active-topic fan-out STRICTLY above which a fact is "too broad". */
  tooBroadTopicFanout: 8,
  /** A fact statement with word-count ≤ this is "too generic" (single word). */
  genericStatementMaxWords: 1,
  /** A too-broad fact is only proposed while its effective weight is above this
   *  floor — so repeated accepts converge (each accept lowers the weight) rather
   *  than re-proposing forever. */
  tooBroadMinEffectiveWeight: 0,
  /** Weight delta applied to a too-broad fact on accept (downweight). */
  tooBroadDownweightDelta: -0.3,
  /** A topic idle for longer than this (ms) is a stale-topic candidate. 45d. */
  staleTopicIdleMs: 45 * 24 * 60 * 60 * 1000,
  /** …AND its weight is in [0, this) — low-value positive topics only. Negative
   *  topics are intentional signals and are left alone. */
  staleTopicMaxWeight: 0.3,
  /** Token Jaccard at/above which two fact statements are near-duplicates. */
  duplicateStatementJaccard: 0.8,
  /** Facts sharing at least this many normalized topic texts → duplicate. */
  duplicateSharedTopicTexts: 2,
} as const;

export type HygieneThresholds = typeof HYGIENE_THRESHOLDS;

// ── Input projections (plain; no DB/RN) ─────────────────────────────────────

export interface HygieneFactInput {
  id: string;
  statement: string;
  /** Persona-v3 fact-level weight (null ⇒ treated as the 1.0 baseline). */
  weight: number | null;
  /** Earliest-known creation time (epoch ms) — persona-age gating uses the min. */
  createdAtMs: number;
}

export interface HygieneTopicInput {
  id: string;
  factId: string | null;
  text: string;
  normalizedText: string;
  weight: number;
  status: 'active' | 'suppressed' | 'retired';
  lastSignalAtMs: number | null;
}

export interface HygieneAnalyzeInput {
  facts: HygieneFactInput[];
  topics: HygieneTopicInput[];
  now: number;
  /** Proposal fingerprints the user has already rejected — never re-proposed. */
  rejectedFingerprints?: string[];
  thresholds?: HygieneThresholds;
}

// ── Output ──────────────────────────────────────────────────────────────────

export type HygieneProposalKind =
  | 'duplicate_facts'
  | 'too_broad_fact'
  | 'stale_topic'
  | 'stale_fact';

/** A minimal PersonaAction shape, structurally compatible with the executor's
 *  richer `PersonaAction` — kept local so the pure module never imports RN. */
export interface HygienePersonaAction {
  action_type: ActionName;
  topicId?: string;
  factId?: string;
  delta?: number;
}

/** One concrete op an accept runs, in order. */
export type HygieneOp =
  | { type: 'persona_action'; action: HygienePersonaAction }
  | { type: 'delete_fact'; factId: string };

export interface HygieneProposal {
  /** Stable fingerprint (kind + sorted target ids). Dedup + rejected-memory key. */
  id: string;
  kind: HygieneProposalKind;
  /** Human summary (English; the UI may translate it). */
  summary: string;
  targetFactIds: string[];
  targetTopicIds: string[];
  /** Ops an accept applies, in order. */
  ops: HygieneOp[];
  /** True when accept is reversible via the change log (retire/downweight);
   *  false for destructive fact deletes. */
  invertible: boolean;
}

// ── Text helpers ─────────────────────────────────────────────────────────────

/** Lowercase, strip punctuation, collapse whitespace → word tokens. */
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

/** Effective weight for a fact (null ⇒ 1.0 baseline). */
function effWeight(f: HygieneFactInput): number {
  return f.weight ?? 1;
}

function shorten(s: string, max = 48): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ── Analyzer ─────────────────────────────────────────────────────────────────

export function analyzeHygiene(input: HygieneAnalyzeInput): HygieneProposal[] {
  const th = input.thresholds ?? HYGIENE_THRESHOLDS;
  const rejected = new Set(input.rejectedFingerprints ?? []);

  // Per-fact owned-topic buckets by status (single pass).
  const activeTopicsByFact = new Map<string, HygieneTopicInput[]>();
  const ownedTopicCount = new Map<string, number>(); // any status, factId != null
  for (const t of input.topics) {
    if (!t.factId) continue;
    ownedTopicCount.set(t.factId, (ownedTopicCount.get(t.factId) ?? 0) + 1);
    if (t.status === 'active') {
      const list = activeTopicsByFact.get(t.factId);
      if (list) list.push(t);
      else activeTopicsByFact.set(t.factId, [t]);
    }
  }

  const proposals: HygieneProposal[] = [];
  // Facts scheduled for deletion by an earlier (higher-priority) proposal — a
  // downweight/stale-topic op on a doomed fact would be redundant.
  const factsBeingDeleted = new Set<string>();

  // 1. duplicate_facts ------------------------------------------------------
  for (const p of detectDuplicateFacts(input.facts, input.topics, th)) {
    const loser = p.deleteFactId;
    const other = p.keepFactId;
    const id = `duplicate_facts:${pairKey(loser, other)}`;
    if (rejected.has(id)) continue;
    proposals.push({
      id,
      kind: 'duplicate_facts',
      summary: p.summary,
      targetFactIds: [loser, other].sort(),
      targetTopicIds: [],
      ops: [{ type: 'delete_fact', factId: loser }],
      invertible: false,
    });
    factsBeingDeleted.add(loser);
  }

  // 2. stale_fact (all owned topics retired/suppressed) ---------------------
  for (const f of input.facts) {
    const owned = ownedTopicCount.get(f.id) ?? 0;
    if (owned === 0) continue; // no topics ⇒ maybe still generating; leave alone
    const active = activeTopicsByFact.get(f.id)?.length ?? 0;
    if (active > 0) continue; // has at least one active topic ⇒ not stale
    if (factsBeingDeleted.has(f.id)) continue; // already a duplicate loser
    const id = `stale_fact:${f.id}`;
    if (rejected.has(id)) continue;
    proposals.push({
      id,
      kind: 'stale_fact',
      summary: `"${shorten(f.statement)}" has no active topics left — remove it?`,
      targetFactIds: [f.id],
      targetTopicIds: [],
      ops: [{ type: 'delete_fact', factId: f.id }],
      invertible: false,
    });
    factsBeingDeleted.add(f.id);
  }

  // 3. too_broad_fact (high active fan-out or generic statement) ------------
  for (const f of input.facts) {
    if (factsBeingDeleted.has(f.id)) continue;
    if (effWeight(f) <= th.tooBroadMinEffectiveWeight) continue; // converged
    const fanout = activeTopicsByFact.get(f.id)?.length ?? 0;
    const words = tokenize(f.statement).length;
    const tooBroad = fanout > th.tooBroadTopicFanout;
    const tooGeneric = words > 0 && words <= th.genericStatementMaxWords;
    if (!tooBroad && !tooGeneric) continue;
    const id = `too_broad_fact:${f.id}`;
    if (rejected.has(id)) continue;
    const reason = tooBroad
      ? `spans ${fanout} active topics`
      : `is very broad ("${shorten(f.statement)}")`;
    proposals.push({
      id,
      kind: 'too_broad_fact',
      summary: `"${shorten(f.statement)}" ${reason} — lower its weight so it pulls fewer off-topic stories?`,
      targetFactIds: [f.id],
      targetTopicIds: [],
      ops: [
        {
          type: 'persona_action',
          action: {
            action_type: ACTION_NAMES.SET_FACT_WEIGHT,
            factId: f.id,
            delta: th.tooBroadDownweightDelta,
          },
        },
      ],
      invertible: true,
    });
  }

  // 4. stale_topic (idle + low positive weight) -----------------------------
  for (const t of input.topics) {
    if (t.status !== 'active') continue;
    if (t.factId && factsBeingDeleted.has(t.factId)) continue;
    if (t.lastSignalAtMs == null) continue; // never signaled ⇒ maybe brand new
    if (input.now - t.lastSignalAtMs <= th.staleTopicIdleMs) continue;
    if (t.weight < 0 || t.weight >= th.staleTopicMaxWeight) continue;
    const id = `stale_topic:${t.id}`;
    if (rejected.has(id)) continue;
    proposals.push({
      id,
      kind: 'stale_topic',
      summary: `Topic "${shorten(t.text)}" has been quiet for weeks — retire it?`,
      targetFactIds: t.factId ? [t.factId] : [],
      targetTopicIds: [t.id],
      ops: [
        {
          type: 'persona_action',
          action: { action_type: ACTION_NAMES.RETIRE_TOPIC, topicId: t.id },
        },
      ],
      invertible: true,
    });
  }

  // Deterministic order: by kind, then fingerprint.
  const kindOrder: Record<HygieneProposalKind, number> = {
    duplicate_facts: 0,
    stale_fact: 1,
    too_broad_fact: 2,
    stale_topic: 3,
  };
  proposals.sort((a, b) => {
    const k = kindOrder[a.kind] - kindOrder[b.kind];
    return k !== 0 ? k : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return proposals;
}

// ── duplicate detector ───────────────────────────────────────────────────────

interface DuplicatePair {
  keepFactId: string;
  deleteFactId: string;
  summary: string;
}

/**
 * Flags fact PAIRS that are duplicates by EITHER signal:
 *   (a) near-identical statements (token Jaccard ≥ threshold), OR
 *   (b) sharing ≥ N of the SAME normalized topic texts (cross-fact overlap via
 *       the fact-stats detector).
 * The lower effective-weight fact is the delete target (tie → larger id).
 * One pair yields at most one proposal even when both signals fire.
 */
function detectDuplicateFacts(
  facts: HygieneFactInput[],
  topics: HygieneTopicInput[],
  th: HygieneThresholds,
): DuplicatePair[] {
  const factById = new Map(facts.map((f) => [f.id, f]));
  const flagged = new Map<string, { a: string; b: string; reason: string }>();

  // (a) statement near-dupes — O(facts²) over a small pool.
  const tokenSets = facts.map((f) => ({ id: f.id, set: new Set(tokenize(f.statement)) }));
  for (let i = 0; i < tokenSets.length; i += 1) {
    for (let j = i + 1; j < tokenSets.length; j += 1) {
      const sim = jaccard(tokenSets[i].set, tokenSets[j].set);
      if (sim >= th.duplicateStatementJaccard) {
        const key = pairKey(tokenSets[i].id, tokenSets[j].id);
        if (!flagged.has(key)) {
          flagged.set(key, { a: tokenSets[i].id, b: tokenSets[j].id, reason: 'similar wording' });
        }
      }
    }
  }

  // (b) shared normalized topic texts — reuse the fact-stats cross-fact detector.
  const overlapGroups = findTopicOverlapAcrossFacts(
    topics.map((t) => ({ id: t.id, factId: t.factId, normalizedText: t.normalizedText })),
  );
  const sharedCount = new Map<string, number>(); // pairKey → shared-text count
  for (const g of overlapGroups) {
    const fids = g.factIds;
    for (let i = 0; i < fids.length; i += 1) {
      for (let j = i + 1; j < fids.length; j += 1) {
        const key = pairKey(fids[i], fids[j]);
        sharedCount.set(key, (sharedCount.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [key, count] of sharedCount) {
    if (count < th.duplicateSharedTopicTexts) continue;
    if (flagged.has(key)) continue; // statement dupe already covers this pair
    const [a, b] = key.split('|');
    flagged.set(key, { a, b, reason: `${count} shared topics` });
  }

  const out: DuplicatePair[] = [];
  for (const { a, b, reason } of flagged.values()) {
    const fa = factById.get(a);
    const fb = factById.get(b);
    if (!fa || !fb) continue;
    // Keep the higher-weight fact; tie → keep the lexicographically smaller id.
    let keep = fa;
    let del = fb;
    const wa = effWeight(fa);
    const wb = effWeight(fb);
    if (wb > wa || (wb === wa && fb.id < fa.id)) {
      keep = fb;
      del = fa;
    }
    out.push({
      keepFactId: keep.id,
      deleteFactId: del.id,
      summary: `"${shorten(del.statement)}" duplicates "${shorten(keep.statement)}" (${reason}) — remove the duplicate?`,
    });
  }
  // Deterministic order by delete-target id.
  out.sort((x, y) => (x.deleteFactId < y.deleteFactId ? -1 : x.deleteFactId > y.deleteFactId ? 1 : 0));
  return out;
}
