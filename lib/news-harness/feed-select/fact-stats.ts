// feed-select — persona hygiene stat cores (PURE, RN-free).
//
// Wave 8 plan A5. Deterministic O(pool) aggregations over plain snapshots that
// back the persona "hygiene" digest: which fact sections are starving, which
// topics are too-broad (huge yield, low avg score), and which normalized topic
// texts are duplicated across facts. No imports of lib/database, lib/stores,
// expo, react-native, or watermelondb — the RN adapter
// (lib/database/services/fact-stats-service.ts) maps WatermelonDB rows into
// these shapes and calls the cores. Compatible-by-construction with the
// projection shapes in sections.ts (redeclared here, not imported, to keep this
// module free of any cross-file coupling).

import {
  DEFAULT_HARNESS_CONFIG,
  type HarnessConfig,
} from '../core/config';

// ── Input projections (plain; no DB/RN) ────────────────────────────────────

/** One matched topic on a suggestion. `topicId` null = synthetic headline. */
export interface FactStatMatchedTopic {
  topicId: string | null;
}

/** The per-suggestion projection the stat cores read. `id` is the WMDB row id
 *  (== articleId == server _id), used to join against the impressions map. */
export interface FactStatSuggestion {
  id: string;
  /** article_id (== id in persona-v3; carried explicitly for the impressions join). */
  articleId: string;
  /** Final post-judge raw score. Null = unscored (excluded from avg/feed count). */
  rawScore: number | null;
  /** first_pub_date in epoch ms. */
  pubDateMs: number;
  matchedTopics: FactStatMatchedTopic[];
}

/** topicId → owning fact + weight/status/last-signal (the join + last-signal source). */
export interface FactStatTopicInfo {
  factId: string | null;
  weight: number;
  status: string; // 'active' | 'suppressed' | 'retired'
  lastSignalAtMs: number | null;
}

/** articleId → impression summary (opened flag). */
export interface FactStatImpression {
  opened: boolean;
}

/** One topic row for the per-fact active/negative counts. */
export interface FactStatTopic {
  id: string;
  factId: string | null;
  weight: number;
  status: string; // 'active' | 'suppressed' | 'retired'
}

export interface FactSectionStatsInput {
  suggestions: FactStatSuggestion[];
  /** topicId → info (join a suggestion → owning fact; last-signal source). */
  topics: Map<string, FactStatTopicInfo>;
  /** articleId → impression (opened). */
  impressions: Map<string, FactStatImpression>;
  /** All topic rows — the per-fact active/negative counts read from here. */
  topicList: FactStatTopic[];
  config?: HarnessConfig;
}

// ── Output ─────────────────────────────────────────────────────────────────

export interface FactSectionStats {
  /** Suggestions attributed to this fact (see join rule below). */
  articleCount: number;
  /** Attributed suggestions with rawScore ≥ discardFloor (0.40) — the FEED-worthy yield. */
  feedCount: number;
  /** Mean rawScore over attributed suggestions with a non-null rawScore (0 when none). */
  avgRawScore: number;
  /** Newest attributed suggestion pubDate (epoch ms; 0 when none). */
  lastArticleAtMs: number;
  /** Attributed suggestions that have an impression row. */
  impressions: number;
  /** Attributed suggestions whose impression was opened. */
  opens: number;
  /** Active topics (any weight) owned by this fact. */
  activeTopicCount: number;
  /** Active topics with weight < 0 owned by this fact (⊆ activeTopicCount). */
  negativeTopicCount: number;
  /** Newest lastSignalAt across this fact's topics (epoch ms; 0 when none). */
  lastSignalAtMs: number;
}

function emptyStats(): FactSectionStats {
  return {
    articleCount: 0,
    feedCount: 0,
    avgRawScore: 0,
    lastArticleAtMs: 0,
    impressions: 0,
    opens: 0,
    activeTopicCount: 0,
    negativeTopicCount: 0,
    lastSignalAtMs: 0,
  };
}

/**
 * Per-fact hygiene stats.
 *
 * JOIN RULE (documented, single, consistent): a suggestion is attributed to
 * EXACTLY ONE fact — the owning fact of its highest-weight matched ACTIVE
 * topic with weight > 0 (mirroring resolveOwningFact's "negative-only owns no
 * section" spirit). Ties on weight break to the lexicographically smallest
 * topicId for determinism. A suggestion with no positive active matched topic
 * (or whose winning topic has no owning fact) is attributed to no fact.
 *
 * Facts that own topics but zero articles still appear in the map (with their
 * active/negative topic counts + last-signal), so the digest can flag a
 * starving section.
 */
export function getFactSectionStats(
  input: FactSectionStatsInput,
): Map<string, FactSectionStats> {
  const config = input.config ?? DEFAULT_HARNESS_CONFIG;
  const floor = config.articlePipeline.discardFloor;

  const stats = new Map<string, FactSectionStats>();
  // Running rawScore accumulators (kept out of the public shape).
  const rawSum = new Map<string, number>();
  const rawCount = new Map<string, number>();

  const ensure = (factId: string): FactSectionStats => {
    let s = stats.get(factId);
    if (!s) {
      s = emptyStats();
      stats.set(factId, s);
    }
    return s;
  };

  // 1. Per-fact topic counts + last-signal — from the topic list / info map.
  for (const t of input.topicList) {
    if (!t.factId || t.status !== 'active') continue;
    const s = ensure(t.factId);
    s.activeTopicCount += 1;
    if (t.weight < 0) s.negativeTopicCount += 1;
  }
  for (const info of input.topics.values()) {
    if (!info.factId) continue;
    const s = ensure(info.factId);
    const sig = info.lastSignalAtMs ?? 0;
    if (sig > s.lastSignalAtMs) s.lastSignalAtMs = sig;
  }

  // 2. Attribute each suggestion to its owning fact + fold in article stats.
  for (const sug of input.suggestions) {
    const factId = resolveOwningFactForStats(sug, input.topics);
    if (factId == null) continue;
    const s = ensure(factId);
    s.articleCount += 1;
    if (sug.rawScore != null && sug.rawScore >= floor) s.feedCount += 1;
    if (sug.rawScore != null) {
      rawSum.set(factId, (rawSum.get(factId) ?? 0) + sug.rawScore);
      rawCount.set(factId, (rawCount.get(factId) ?? 0) + 1);
    }
    if (sug.pubDateMs > s.lastArticleAtMs) s.lastArticleAtMs = sug.pubDateMs;
    const imp = input.impressions.get(sug.articleId);
    if (imp) {
      s.impressions += 1;
      if (imp.opened) s.opens += 1;
    }
  }

  // 3. Finalize averages.
  for (const [factId, s] of stats) {
    const cnt = rawCount.get(factId) ?? 0;
    s.avgRawScore = cnt > 0 ? (rawSum.get(factId) ?? 0) / cnt : 0;
  }

  return stats;
}

/** Owning fact of a suggestion under the getFactSectionStats join rule. */
function resolveOwningFactForStats(
  sug: FactStatSuggestion,
  topics: Map<string, FactStatTopicInfo>,
): string | null {
  let winnerFactId: string | null = null;
  let winnerWeight = 0;
  let winnerTopicId: string | null = null;
  for (const mt of sug.matchedTopics) {
    if (!mt.topicId) continue;
    const info = topics.get(mt.topicId);
    if (!info || info.status !== 'active' || !info.factId) continue;
    if (info.weight <= 0) continue; // negative/zero-weight owns no attribution
    const better =
      info.weight > winnerWeight ||
      (info.weight === winnerWeight &&
        (winnerTopicId == null || mt.topicId < winnerTopicId));
    if (better) {
      winnerWeight = info.weight;
      winnerFactId = info.factId;
      winnerTopicId = mt.topicId;
    }
  }
  return winnerFactId;
}

// ── Topic yield (too-broad detector raw input) ─────────────────────────────

export interface TopicYieldStats {
  /** Suggestions matching this topic (a suggestion counts toward EVERY topic it matched). */
  articleCount: number;
  /** Mean rawScore over the matching suggestions with a non-null rawScore (0 when none). */
  avgRawScore: number;
}

/**
 * Per-topic yield. A huge `articleCount` with a low `avgRawScore` is the
 * signature of a too-broad topic (pulls a lot, none of it feed-worthy). Every
 * matched topic on a suggestion is credited (unlike the single-owner fact join).
 */
export function getTopicYieldStats(
  suggestions: FactStatSuggestion[],
): Map<string, TopicYieldStats> {
  const count = new Map<string, number>();
  const rawSum = new Map<string, number>();
  const rawCount = new Map<string, number>();

  for (const sug of suggestions) {
    const seen = new Set<string>();
    for (const mt of sug.matchedTopics) {
      if (!mt.topicId || seen.has(mt.topicId)) continue;
      seen.add(mt.topicId);
      count.set(mt.topicId, (count.get(mt.topicId) ?? 0) + 1);
      if (sug.rawScore != null) {
        rawSum.set(mt.topicId, (rawSum.get(mt.topicId) ?? 0) + sug.rawScore);
        rawCount.set(mt.topicId, (rawCount.get(mt.topicId) ?? 0) + 1);
      }
    }
  }

  const out = new Map<string, TopicYieldStats>();
  for (const [topicId, articleCount] of count) {
    const cnt = rawCount.get(topicId) ?? 0;
    out.set(topicId, {
      articleCount,
      avgRawScore: cnt > 0 ? (rawSum.get(topicId) ?? 0) / cnt : 0,
    });
  }
  return out;
}

// ── Cross-fact topic overlap (dupe detector raw input) ─────────────────────

export interface TopicOverlapGroup {
  normalizedText: string;
  topicIds: string[];
  factIds: string[];
}

/**
 * Groups topics by `normalizedText` where the SAME normalized text is owned by
 * ≥2 DISTINCT facts — the raw input for the cross-fact duplicate detector.
 * Topics with no owning fact (factId null) are ignored (they can't create a
 * cross-fact dupe). Single-fact duplicates (same text, one fact) are NOT
 * grouped. Output is deterministic: groups sorted by normalizedText, ids sorted.
 */
export function findTopicOverlapAcrossFacts(
  topics: { id: string; factId: string | null; normalizedText: string }[],
): TopicOverlapGroup[] {
  const byText = new Map<
    string,
    { topicIds: Set<string>; factIds: Set<string> }
  >();
  for (const t of topics) {
    if (!t.factId) continue;
    const key = t.normalizedText;
    let entry = byText.get(key);
    if (!entry) {
      entry = { topicIds: new Set(), factIds: new Set() };
      byText.set(key, entry);
    }
    entry.topicIds.add(t.id);
    entry.factIds.add(t.factId);
  }

  const groups: TopicOverlapGroup[] = [];
  for (const [normalizedText, entry] of byText) {
    if (entry.factIds.size < 2) continue;
    groups.push({
      normalizedText,
      topicIds: [...entry.topicIds].sort(),
      factIds: [...entry.factIds].sort(),
    });
  }
  groups.sort((a, b) =>
    a.normalizedText < b.normalizedText ? -1 : a.normalizedText > b.normalizedText ? 1 : 0,
  );
  return groups;
}
