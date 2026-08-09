// news-harness — daily feedback-digest analyzer (PURE, RN-free).
//
// Round-4 C5. A deterministic sweep over the STORED feed verdicts (article_feedback
// rows: like/dislike + an optional inline feedback-tree path) that produces the
// concrete persona-tuning candidates the daily Optimisation Plan is built from.
// NOTHING here mutates the persona — the RN adapter
// (lib/database/services/optimisation-plan-service.ts) maps live rows into these
// shapes, lets an LLM ORGANIZE the candidates into an auto/review plan, and only
// then routes an ACCEPTED candidate's `ops` through the persona-action executor.
//
// Two signal sources feed one candidate set:
//   • path-mapped   — the leaf the user tapped in the inline feedback-tree
//     (interpreted from the bundled v2 tree's node ids) maps DIRECTLY to an op;
//   • verdict-only  — accumulated bare like/dislike verdicts on the same matched
//     topic / event-type aggregate into a nudge / retire / suppression candidate.
//
// For every removal / suppression candidate we also surface the liked stories it
// would collaterally affect (conflictsWith) so the plan can ask before applying.
//
// No imports of lib/database, lib/stores, expo, react-native, or watermelondb.
// Config lives HERE (colocated with the only reader) — promote to core/config if
// it ever needs runtime tuning (mirrors fact-hygiene's HYGIENE_THRESHOLDS).

import { ACTION_NAMES, type ActionName } from './action-names';
import type { SuppressionKindName } from '../core/types';
// The digest's `pathCandidates` already interprets feedback-tree node ids, so
// it is coupled to that module by design; the category gate is shared with
// resolve-leaf-actions so the tree and the digest can never disagree about
// which categories are safe to structure.
import { isDiscriminatingCategory } from '../feedback-tree/category-specificity';

// ── Constants (conservative by design) ───────────────────────────────────────

export const DIGEST_CONSTANTS = {
  /** like → "a lot more about this topic" weight delta (tree `a_lot_more`). */
  pathBoostStrong: 0.3,
  /** like → "a bit more about this topic" weight delta (tree `a_bit_more`). */
  pathBoostMild: 0.15,
  /** dislike → "wrong topic" weight delta (tree `wrong_topic`). */
  pathLowerTopic: -0.2,
  /** dislike → "not that important" weight delta (tree `not_important`). */
  pathLowerMild: -0.15,
  /** dislike → "I'm seeing too much of this" weight delta (tree `too_many`).
   *  A FREQUENCY complaint: the user still wants the subject, just less of it,
   *  so it lowers the topic weight (which drives both the score and the
   *  per-topic retrieval limit) instead of minting a filter. -0.3 is the strong
   *  step of the same pair as `pathLowerMild`, mirroring `pathBoostStrong` /
   *  `pathBoostMild` on the like side. */
  pathLowerStrong: -0.3,
  /** Verdict-aggregate delta when a topic accrues repeated dislikes. */
  aggregateDislikeDelta: -0.2,
  /** Verdict-aggregate delta when a topic accrues repeated likes. */
  aggregateLikeDelta: 0.2,
  /** ≥ this many dislikes on one matched topic → a down-weight candidate. */
  minDislikesForLower: 2,
  /** ≥ this many dislikes on one matched topic, ALL low-relevance → retire. */
  minDislikesForRetire: 3,
  /** "Low relevance" ceiling for the retire aggregate. */
  retireRelevanceMax: 0.6,
  /** ≥ this many likes on one matched topic → an up-weight candidate. */
  minLikesForBoost: 2,
  /** ≥ this many dislikes sharing an event-type → a suppression candidate. */
  minDislikesForSuppress: 2,
  /** Default strength for a minted suppression. */
  suppressionStrength: 0.5,
  /** Plan caps — at most this many auto changes + this many review items. */
  maxAutoCandidates: 8,
  maxReviewCandidates: 5,
} as const;

export type DigestConstants = typeof DIGEST_CONSTANTS;

// ── Input projections (plain; no DB/RN) ──────────────────────────────────────

/** One matched-topic reference off a feedback row's context snapshot. */
export interface DigestMatchedTopic {
  topicId?: string | null;
  text: string;
  weight?: number;
}

/** The persisted `context_json` extras a feedback row carries (see
 *  cards/feedback-subject.buildContextJson). All optional — an older / partial
 *  row degrades gracefully to a verdict-only signal. */
export interface DigestSignalContext {
  matchedTopics?: DigestMatchedTopic[];
  relevance?: number;
  eventType?: string;
  category?: string;
  /** Publication id — only present when a surface persisted it. */
  publication?: string;
  stableClusterId?: string;
  /** Server-tagged named entities on the article the user acted on (≤8).
   *  CONTEXT ONLY — never matched, never turned into an op. See
   *  `DigestCandidate.entityContext`. */
  entities?: string[];
}

/** One stored verdict the digest reasons over. */
export interface DigestSignal {
  /** article_feedback row id (the processed-marker target). */
  id: string;
  sentiment: 'like' | 'dislike';
  title: string;
  createdAtMs: number;
  context: DigestSignalContext;
  /** Inline feedback-tree node-id breadcrumb, when the user drilled in. */
  treePath?: string[];
}

/** Narrow persona-topic snapshot — enough to resolve a matched-topic text to a
 *  live topic id and skip already-removed topics. */
export interface DigestTopicInput {
  id: string;
  text: string;
  normalizedText?: string;
  weight: number;
  status: 'active' | 'suppressed' | 'retired';
  highPriority: boolean;
}

export interface DigestAnalyzeInput {
  signals: DigestSignal[];
  topics: DigestTopicInput[];
  now: number;
  /** Candidate fingerprints the user already declined — never re-proposed. */
  rejectedFingerprints?: string[];
  constants?: DigestConstants;
}

// ── Output ────────────────────────────────────────────────────────────────────

export type DigestCandidateKind =
  | 'topic_up'
  | 'topic_down'
  | 'retire_topic'
  | 'suppress'
  | 'publication_up'
  | 'publication_down';

/** A minimal PersonaAction shape, structurally compatible with the executor's
 *  richer `PersonaAction` — kept local so the pure module never imports RN.
 *  `topicText` rides along so the RN adapter can resolve a topic id at apply
 *  time when the matched-topic reference lacked one. */
export interface DigestPersonaAction {
  action_type: ActionName;
  topicId?: string;
  topicText?: string;
  delta?: number;
  weight?: number;
  publicationId?: string;
  publicationPref?: 'boost' | 'deprioritize' | 'mute';
  suppressionPattern?: string;
  suppressionKeywords?: string[];
  suppressionStrength?: number;
  /** D9 — a STRUCTURED filter: exact normalized equality on ONE article field
   *  instead of a substring scan. Only ever set when `suppressionValue` is the
   *  article's own snapshotted field value, copied verbatim; a value we
   *  paraphrased would match nothing while looking active. Absent ⇒ keyword. */
  suppressionKind?: SuppressionKindName;
  suppressionValue?: string;
}

/** A liked story a removal/suppression candidate would collaterally hit. */
export interface DigestConflict {
  title: string;
  reason: string;
}

export interface DigestCandidate {
  /** Stable fingerprint `kind:targetKey`. Dedup + rejected-memory key. */
  fingerprint: string;
  kind: DigestCandidateKind;
  /** Short English summary (the plan LLM may rewrite the question around it). */
  summary: string;
  /** Ops an accept applies, in order. */
  ops: DigestPersonaAction[];
  /** article_feedback row ids that contributed — marked processed on accept. */
  sourceRowIds: string[];
  confidence: 'auto' | 'review';
  conflictsWith: DigestConflict[];
  /**
   * What the articles behind this candidate were ABOUT, split by direction.
   *
   * Purely context for the daily optimisation prompt, which ORGANISES and words
   * the deterministic candidates rather than inventing ops. "Show less about
   * cycling" reads very differently when the disliked stories were all about one
   * race series, and this is the only thing in the payload that can say so.
   *
   * DIRECTION IS PRESERVED, not collapsed: "more of this" and "less of this" are
   * different signals, and a candidate can aggregate rows of both sentiments
   * (a topic the user liked twice and disliked five times). Merging them would
   * hand the model a bag of nouns with no sign.
   *
   * NOT A FILTER, and this is load-bearing given 68.8% entity accuracy: nothing
   * here produces a `DigestPersonaAction`, and Task A made an entity suppression
   * unable to exclude a row even if one existed. Derived at finalize time from
   * the candidate's own `sourceRowIds`, so it is bounded by the candidate cap
   * (≤8 auto + ≤5 review) rather than by any cap of its own.
   */
  entityContext?: { liked: string[]; disliked: string[] };
}

// ── Text helpers ──────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

// `titleKeywords` (lowercase content tokens off a headline) lived here for the
// one caller that built a suppression out of an article's title — `too_many`,
// which now downweights the topic instead. Nothing else ever tokenized a title:
// a headline is not a matchable article field, so no structured filter can be
// built from one, and the keyword scan it fell back to is exactly the
// eliminate-the-subject behaviour that leaf must not have. Deleted with it.

function shorten(s: string, max = 42): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

// ── Topic index (matched-topic ref → live persona topic) ──────────────────────

interface TopicIndex {
  byId: Map<string, DigestTopicInput>;
  byNorm: Map<string, DigestTopicInput>;
}

function buildTopicIndex(topics: DigestTopicInput[]): TopicIndex {
  const byId = new Map<string, DigestTopicInput>();
  const byNorm = new Map<string, DigestTopicInput>();
  for (const t of topics) {
    byId.set(t.id, t);
    const norm = t.normalizedText ?? normalize(t.text);
    // First writer wins — a stable, deterministic pick when texts collide.
    if (!byNorm.has(norm)) byNorm.set(norm, t);
  }
  return { byId, byNorm };
}

interface ResolvedTopic {
  key: string; // topicId when live, else normalized text
  topicId?: string;
  text: string;
  status: 'active' | 'suppressed' | 'retired' | 'unknown';
}

function resolveTopic(ref: DigestMatchedTopic, index: TopicIndex): ResolvedTopic {
  const norm = normalize(ref.text);
  const live =
    (ref.topicId ? index.byId.get(ref.topicId) : undefined) ?? index.byNorm.get(norm);
  if (live) {
    return { key: live.id, topicId: live.id, text: live.text, status: live.status };
  }
  // No live snapshot row: still key by the referenced topic id when we have one
  // (more stable than text — survives a topic rename), else the normalized text.
  const topicId = ref.topicId ?? undefined;
  return { key: topicId ?? norm, topicId, text: ref.text, status: 'unknown' };
}

// ── Mutable accumulator ───────────────────────────────────────────────────────

interface MutableCandidate {
  fingerprint: string;
  kind: DigestCandidateKind;
  summary: string;
  op: DigestPersonaAction;
  sourceRowIds: Set<string>;
  /** Conflict-scan descriptor (removal/suppression kinds only). */
  conflictTopicKey?: string;
  conflictEventType?: string;
  conflictCategory?: string;
  conflictPublication?: string;
}

/** Merge a freshly-built candidate into the map: union source rows, and for
 *  weight ops keep the strongest-magnitude delta so a "+0.15" never downgrades a
 *  co-located "+0.3". First summary/op direction wins otherwise. */
function mergeCandidate(map: Map<string, MutableCandidate>, next: MutableCandidate): void {
  const existing = map.get(next.fingerprint);
  if (!existing) {
    map.set(next.fingerprint, next);
    return;
  }
  for (const id of next.sourceRowIds) existing.sourceRowIds.add(id);
  const a = existing.op.delta;
  const b = next.op.delta;
  if (typeof a === 'number' && typeof b === 'number' && Math.abs(b) > Math.abs(a)) {
    existing.op.delta = b;
    existing.summary = next.summary;
  }
}

// ── Path-mapped candidates ────────────────────────────────────────────────────

/** The final tapped leaf drives the op; earlier breadcrumb nodes are context. */
function leafOf(path: string[] | undefined): string | null {
  if (!path || path.length === 0) return null;
  return path[path.length - 1];
}

function topicWeightCandidate(
  topic: ResolvedTopic,
  delta: number,
  rowId: string,
): MutableCandidate | null {
  // A topic already retired/suppressed can't be nudged meaningfully.
  if (topic.status === 'retired' || topic.status === 'suppressed') return null;
  const up = delta > 0;
  return {
    fingerprint: `${up ? 'topic_up' : 'topic_down'}:${topic.key}`,
    kind: up ? 'topic_up' : 'topic_down',
    summary: `${up ? 'Show more about' : 'Show less about'} "${shorten(topic.text)}"`,
    op: {
      action_type: ACTION_NAMES.SET_TOPIC_WEIGHT,
      ...(topic.topicId ? { topicId: topic.topicId } : {}),
      topicText: topic.text,
      delta,
    },
    sourceRowIds: new Set([rowId]),
  };
}

/**
 * Build one suppression candidate.
 *
 * `structured` promotes the filter from a keyword substring scan to an exact
 * match on one article field (D9). It is only safe when the value is the
 * article's OWN snapshotted field, verbatim — which is why both callers read
 * straight from `signal.context.category` / `.eventType`. Since `too_many`
 * stopped minting a title-keyword filter there is no caller that omits it: every
 * suppression this digest mints is now a structured, single-field one.
 */
function suppressionCandidate(
  targetKey: string,
  pattern: string,
  keywords: string[],
  summary: string,
  rowId: string,
  c: DigestConstants,
  conflict: { eventType?: string; category?: string },
  structured?: { kind: SuppressionKindName; value: string },
): MutableCandidate {
  return {
    fingerprint: `suppress:${targetKey}`,
    kind: 'suppress',
    summary,
    op: {
      action_type: ACTION_NAMES.ADD_SUPPRESSION,
      suppressionPattern: pattern,
      suppressionKeywords: keywords,
      suppressionStrength: c.suppressionStrength,
      ...(structured
        ? { suppressionKind: structured.kind, suppressionValue: structured.value }
        : {}),
    },
    sourceRowIds: new Set([rowId]),
    conflictEventType: conflict.eventType,
    conflictCategory: conflict.category,
  };
}

function publicationCandidate(
  publicationId: string,
  pref: 'boost' | 'deprioritize' | 'mute',
  rowId: string,
): MutableCandidate {
  const up = pref === 'boost';
  const verb = pref === 'boost' ? 'More from' : pref === 'mute' ? 'Mute' : 'Less from';
  return {
    fingerprint: `${up ? 'publication_up' : 'publication_down'}:${publicationId}`,
    kind: up ? 'publication_up' : 'publication_down',
    summary: `${verb} "${shorten(publicationId)}"`,
    op: {
      action_type: ACTION_NAMES.SET_PUBLICATION_PREF,
      publicationId,
      publicationPref: pref,
    },
    sourceRowIds: new Set([rowId]),
    ...(up ? {} : { conflictPublication: publicationId }),
  };
}

/** Interpret ONE signal's tapped feedback-tree leaf into candidate(s). Unknown /
 *  unmappable leaves (openChat, seenOnly, geo without geo text, nudges) yield
 *  none — those signals fall through to verdict aggregation. */
function pathCandidates(
  signal: DigestSignal,
  index: TopicIndex,
  c: DigestConstants,
): MutableCandidate[] {
  const leaf = leafOf(signal.treePath);
  if (!leaf) return [];
  const matched = signal.context.matchedTopics ?? [];
  const out: MutableCandidate[] = [];

  const forEachTopic = (delta: number) => {
    for (const ref of matched) {
      const cand = topicWeightCandidate(resolveTopic(ref, index), delta, signal.id);
      if (cand) out.push(cand);
    }
  };

  switch (leaf) {
    // -- LIKE side --------------------------------------------------------------
    case 'a_lot_more':
      forEachTopic(c.pathBoostStrong);
      break;
    case 'a_bit_more':
      forEachTopic(c.pathBoostMild);
      break;
    case 'more_from_publication':
      if (signal.context.publication) {
        out.push(publicationCandidate(signal.context.publication, 'boost', signal.id));
      }
      break;

    // -- DISLIKE side -----------------------------------------------------------
    case 'wrong_topic':
      forEachTopic(c.pathLowerTopic);
      break;
    case 'not_important':
      forEachTopic(c.pathLowerMild);
      break;
    // "I'm seeing too much of this" is a complaint about VOLUME, not relevance.
    // It used to mint a keyword suppression built from the headline's tokens,
    // which is the wrong action family twice over: a filter ELIMINATES the
    // subject the user just said they still wanted, and it did so through the
    // back door — this path runs precisely when the tree's own downweight did
    // NOT land (a `nudgeTopic` budget exhaustion leaves the row unstamped, so
    // the digest picks it up later). Now it mirrors the tree leaf exactly, which
    // is what every other constant in DIGEST_CONSTANTS documents itself as.
    case 'too_many':
      forEachTopic(c.pathLowerStrong);
      break;
    case 'this_kind_of_event':
      if (signal.context.eventType) {
        const evt = signal.context.eventType;
        out.push(
          suppressionCandidate(
            `evt:${normalize(evt)}`,
            evt,
            [evt],
            `Fewer "${shorten(evt)}" stories`,
            signal.id,
            c,
            { eventType: evt },
            { kind: 'event_type', value: evt },
          ),
        );
      }
      break;
    case 'this_category':
      // A generic category mints NOTHING — not a keyword fallback. Same defect
      // the tree resolver had: `keyword` is a substring scan, so falling back
      // to it on "News" demotes a large slice of everything, which is worse
      // than the exact-field filter the genericness gate is refusing.
      if (signal.context.category && isDiscriminatingCategory(signal.context.category)) {
        const cat = signal.context.category;
        out.push(
          suppressionCandidate(
            `cat:${normalize(cat)}`,
            cat,
            [cat],
            `Fewer "${shorten(cat)}" stories`,
            signal.id,
            c,
            { category: cat },
            { kind: 'category', value: cat },
          ),
        );
      }
      break;
    case 'show_less':
    case 'too_slow':
    case 'too_cluttered':
      if (signal.context.publication) {
        out.push(publicationCandidate(signal.context.publication, 'deprioritize', signal.id));
      }
      break;
    case 'never_show':
      if (signal.context.publication) {
        out.push(publicationCandidate(signal.context.publication, 'mute', signal.id));
      }
      break;
    default:
      break; // openChat / seenOnly / geo / nudge leaves → verdict aggregation
  }
  return out;
}

// ── Verdict-only aggregation ──────────────────────────────────────────────────

interface TopicTally {
  topic: ResolvedTopic;
  likeRows: string[];
  dislikeRows: string[];
  dislikeRelevances: number[];
}

function aggregateCandidates(
  signals: DigestSignal[],
  index: TopicIndex,
  c: DigestConstants,
): MutableCandidate[] {
  const tallies = new Map<string, TopicTally>();
  const evtDislikes = new Map<string, { rows: string[]; label: string }>();
  const catDislikes = new Map<string, { rows: string[]; label: string }>();

  for (const s of signals) {
    for (const ref of s.context.matchedTopics ?? []) {
      const topic = resolveTopic(ref, index);
      if (topic.status === 'retired' || topic.status === 'suppressed') continue;
      let tally = tallies.get(topic.key);
      if (!tally) {
        tally = { topic, likeRows: [], dislikeRows: [], dislikeRelevances: [] };
        tallies.set(topic.key, tally);
      }
      if (s.sentiment === 'like') tally.likeRows.push(s.id);
      else {
        tally.dislikeRows.push(s.id);
        tally.dislikeRelevances.push(
          typeof s.context.relevance === 'number' ? s.context.relevance : 1,
        );
      }
    }
    // Event-type / category dislike buckets (shared-attribute suppression).
    if (s.sentiment === 'dislike') {
      if (s.context.eventType) {
        const k = normalize(s.context.eventType);
        const b = evtDislikes.get(k) ?? { rows: [], label: s.context.eventType };
        b.rows.push(s.id);
        evtDislikes.set(k, b);
      }
      if (s.context.category) {
        const k = normalize(s.context.category);
        const b = catDislikes.get(k) ?? { rows: [], label: s.context.category };
        b.rows.push(s.id);
        catDislikes.set(k, b);
      }
    }
  }

  const out: MutableCandidate[] = [];

  for (const tally of tallies.values()) {
    const { topic } = tally;
    // ≥3 dislikes, all low relevance → retire candidate (strongest signal wins).
    if (
      tally.dislikeRows.length >= c.minDislikesForRetire &&
      tally.dislikeRelevances.every((r) => r < c.retireRelevanceMax)
    ) {
      out.push({
        fingerprint: `retire_topic:${topic.key}`,
        kind: 'retire_topic',
        summary: `Retire the topic "${shorten(topic.text)}"`,
        op: {
          action_type: ACTION_NAMES.RETIRE_TOPIC,
          ...(topic.topicId ? { topicId: topic.topicId } : {}),
          topicText: topic.text,
        },
        sourceRowIds: new Set(tally.dislikeRows),
        conflictTopicKey: topic.key,
      });
    } else if (tally.dislikeRows.length >= c.minDislikesForLower) {
      const cand = topicWeightCandidate(topic, c.aggregateDislikeDelta, tally.dislikeRows[0]);
      if (cand) {
        for (const id of tally.dislikeRows) cand.sourceRowIds.add(id);
        out.push(cand);
      }
    }
    if (tally.likeRows.length >= c.minLikesForBoost) {
      const cand = topicWeightCandidate(topic, c.aggregateLikeDelta, tally.likeRows[0]);
      if (cand) {
        for (const id of tally.likeRows) cand.sourceRowIds.add(id);
        out.push(cand);
      }
    }
  }

  for (const [k, b] of evtDislikes) {
    if (b.rows.length < c.minDislikesForSuppress) continue;
    const cand = suppressionCandidate(
      `evt:${k}`,
      b.label,
      [b.label],
      `Fewer "${shorten(b.label)}" stories`,
      b.rows[0],
      c,
      { eventType: b.label },
      { kind: 'event_type', value: b.label },
    );
    for (const id of b.rows) cand.sourceRowIds.add(id);
    out.push(cand);
  }
  for (const [k, b] of catDislikes) {
    if (b.rows.length < c.minDislikesForSuppress) continue;
    // Generic source category → no candidate at all (see pathCandidates).
    if (!isDiscriminatingCategory(b.label)) continue;
    const cand = suppressionCandidate(
      `cat:${k}`,
      b.label,
      [b.label],
      `Fewer "${shorten(b.label)}" stories`,
      b.rows[0],
      c,
      { category: b.label },
      { kind: 'category', value: b.label },
    );
    for (const id of b.rows) cand.sourceRowIds.add(id);
    out.push(cand);
  }

  return out;
}

// ── Conflict detection ────────────────────────────────────────────────────────

/** For a removal/suppression candidate, list the liked stories it would also
 *  affect (shared matched-topic / event-type / category / publication). */
function conflictsFor(cand: MutableCandidate, signals: DigestSignal[]): DigestConflict[] {
  const out: DigestConflict[] = [];
  const seen = new Set<string>();
  for (const s of signals) {
    if (s.sentiment !== 'like') continue;
    let hit = false;
    if (cand.conflictTopicKey) {
      for (const ref of s.context.matchedTopics ?? []) {
        if (ref.topicId === cand.conflictTopicKey || normalize(ref.text) === cand.conflictTopicKey) {
          hit = true;
          break;
        }
      }
    }
    if (!hit && cand.conflictEventType && s.context.eventType) {
      hit = normalize(s.context.eventType) === normalize(cand.conflictEventType);
    }
    if (!hit && cand.conflictCategory && s.context.category) {
      hit = normalize(s.context.category) === normalize(cand.conflictCategory);
    }
    if (!hit && cand.conflictPublication && s.context.publication) {
      hit = s.context.publication === cand.conflictPublication;
    }
    if (hit && !seen.has(s.title)) {
      seen.add(s.title);
      out.push({ title: shorten(s.title, 60), reason: 'You liked this story' });
    }
  }
  return out;
}

// ── Analyzer ──────────────────────────────────────────────────────────────────

const REMOVAL_KINDS: ReadonlySet<DigestCandidateKind> = new Set([
  'retire_topic',
  'suppress',
  'publication_down',
]);

export function analyzeFeedback(input: DigestAnalyzeInput): DigestCandidate[] {
  const c = input.constants ?? DIGEST_CONSTANTS;
  const rejected = new Set(input.rejectedFingerprints ?? []);
  const index = buildTopicIndex(input.topics);

  const byFingerprint = new Map<string, MutableCandidate>();
  // Path-mapped first — they carry the user's explicit intent, so they win any
  // fingerprint collision with a verdict aggregate on the same target.
  for (const signal of input.signals) {
    for (const cand of pathCandidates(signal, index, c)) mergeCandidate(byFingerprint, cand);
  }
  for (const cand of aggregateCandidates(input.signals, index, c)) {
    mergeCandidate(byFingerprint, cand);
  }

  // Entities are attached to the candidate they came from, at finalize time
  // rather than in each of the ~8 candidate builders: every builder already
  // records `sourceRowIds`, so one lookup here covers all of them and cannot
  // drift between kinds.
  const signalById = new Map(input.signals.map((sig) => [sig.id, sig]));
  const entityContextFor = (
    rowIds: Iterable<string>,
  ): { liked: string[]; disliked: string[] } | undefined => {
    const liked = new Set<string>();
    const disliked = new Set<string>();
    for (const rowId of rowIds) {
      const sig = signalById.get(rowId);
      if (!sig) continue;
      const bucket = sig.sentiment === 'like' ? liked : disliked;
      for (const e of sig.context.entities ?? []) {
        const t = e.trim();
        if (t.length > 0) bucket.add(t);
      }
    }
    if (liked.size === 0 && disliked.size === 0) return undefined;
    // Deduped and sorted — deduped because the same entity across five rows is
    // one fact about the candidate, not five; sorted so the prompt is stable
    // across runs (an unstable payload defeats prompt caching and makes two
    // runs impossible to diff). Deliberately NOT capped or ranked: the
    // candidate cap already bounds this, and a frequency/recency ranking would
    // be a knob with no measurement behind it.
    return { liked: [...liked].sort(), disliked: [...disliked].sort() };
  };

  // Finalize: conflicts, confidence, rejected filter.
  const finalized: DigestCandidate[] = [];
  for (const m of byFingerprint.values()) {
    if (rejected.has(m.fingerprint)) continue;
    const conflictsWith = REMOVAL_KINDS.has(m.kind) ? conflictsFor(m, input.signals) : [];
    const entityContext = entityContextFor(m.sourceRowIds);
    const confidence: 'auto' | 'review' =
      REMOVAL_KINDS.has(m.kind) || conflictsWith.length > 0 ? 'review' : 'auto';
    finalized.push({
      fingerprint: m.fingerprint,
      kind: m.kind,
      summary: m.summary,
      ops: [m.op],
      sourceRowIds: Array.from(m.sourceRowIds).sort(),
      confidence,
      conflictsWith,
      ...(entityContext ? { entityContext } : {}),
    });
  }

  // Deterministic order: most-supported first, then fingerprint.
  finalized.sort((a, b) => {
    const s = b.sourceRowIds.length - a.sourceRowIds.length;
    return s !== 0 ? s : a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0;
  });

  // Cap each bucket independently (≤8 auto + ≤5 review).
  const auto: DigestCandidate[] = [];
  const review: DigestCandidate[] = [];
  for (const cand of finalized) {
    if (cand.confidence === 'auto') {
      if (auto.length < c.maxAutoCandidates) auto.push(cand);
    } else if (review.length < c.maxReviewCandidates) {
      review.push(cand);
    }
  }
  return [...auto, ...review];
}
