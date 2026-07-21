// fact-rows-selector — the pure selector behind the Round-3 fact-rows For-You
// view. Turns the render-gated 24h suggestion pool into per-fact horizontal rows
// (one row per owning fact + a trailing "Also for you" catch-all) plus the
// breaking strip pinned above them.
//
// PURE: RN-free. It consumes the store's `ForYouSuggestion` rows + the persona
// snapshots and returns plain data the screen renders verbatim; no DB / expo /
// react-native imports, so it unit-tests without a device.
//
// Pipeline (mirrors the proven Wave-7 selector, minus the sectioned/two-zone
// machinery): filter to visible → story-group → pick a representative per group
// → pull breaking out → assign each remaining group to its owning fact via
// `resolveOwnership` (negative → dropped; zero-signal orphan → "Also for you")
// → order cards newest-first within a row and rows by their newest "added" time.
//
// Visibility rule (user-specified, Round-3 C1): a card enters its row once its
// NOTE exists — i.e. the row reached `complete` (terminal: note text present OR
// deliberately skipped for a sub-threshold-reason row). `reason_pending` rows
// (scored, note still generating) stay hidden; the status accordion narrates the
// wait. Sub-render-gate (≤ 0.3) and out-of-window rows never render.

import {
  bucketOf,
  resolveOwnership,
  type FeedBucket,
  type ScoredSuggestionProjection,
  type TopicSnapshot,
  type FactSnapshot,
  type LocationSnapshot,
} from '@/lib/news-harness/feed-select';
import {
  buildStoryGroups,
  pickRepresentative,
  TITLE_JACCARD_DISPLAY_THRESHOLD,
  CLUSTER_CORE_CONFIDENCE_THRESHOLD,
  WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
  type GroupableItem,
} from '@/lib/feed-grouping/story-grouping';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfig } from '@/lib/news-harness/core/config';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { ForYouSuggestion } from './for-you-store';

/** Only stories from the last 24h are eligible (matches the legacy feed).
 *  Exported so the swipe-stack selector reuses the exact same window. */
export const FEED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The render gate — a scored row must clear this to be shown. Exported so the
 *  swipe-stack selector reuses the exact same threshold. */
export const RENDER_GATE = 0.3;

/** Sentinel factId for the trailing "Also for you" catch-all row. Real factIds
 *  are UUIDs, so this never collides. */
export const ALSO_ROW_ID = 'also';

const BREAKING_EVENT_TYPES = new Set(['disaster', 'weather', 'conflict']);

/** One breaking-strip entry (representative + collapsed members). Consumed by
 *  `BreakingStrip`. */
export interface BreakingCardData {
  data: ForYouSuggestion;
  members: ForYouSuggestion[];
}

/** One story-group card in a fact row (a collapsed multi-source story). */
export interface FactRowGroup {
  /** The fronting suggestion (newest member of the story). */
  data: ForYouSuggestion;
  /** The other collapsed members (group minus representative), input order. */
  members: ForYouSuggestion[];
  rawScore: number | null;
  bucket: FeedBucket;
  /** Newest member's pubDate (epoch ms) — the story's display timestamp. */
  pubDateMs: number;
  /** Newest member's `scoredAt ?? createdAt` (epoch ms) — the "added" time. */
  addedMs: number;
}

/** One fact row: a fact's stories laid out as a horizontal strip. */
export interface FactRow {
  /** Real factId, or `ALSO_ROW_ID` for the catch-all. */
  factId: string;
  kind: 'fact' | 'also';
  /** Display title (fact section-title for fact rows; unused for `also`, whose
   *  header renders a static i18n string). */
  statement: string;
  /** The underlying real fact statement (header reveal); null for `also`. */
  factStatement: string | null;
  /** Newest `addedMs` across the row's groups — the row-ordering key. */
  latestAddedMs: number;
  groups: FactRowGroup[];
}

export interface FactRowsResult {
  breaking: BreakingCardData[];
  rows: FactRow[];
}

export interface FactRowsSnapshots {
  topics: Map<string, TopicSnapshot>;
  facts: Map<string, FactSnapshot>;
  locations: Map<string, LocationSnapshot>;
  /** factId → real fact statement (for the header reveal). */
  factStatements: Map<string, string>;
}

// --- helpers --------------------------------------------------------------

function parseMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** A row is VISIBLE once its note exists (status `complete`) — see the module
 *  header. Must also clear the render gate and the 24h window. Exported so the
 *  swipe-stack selector applies the identical visibility gate. */
export function isVisible(s: ForYouSuggestion, cutoffMs: number): boolean {
  if (s.status !== ArticleSuggestionStatus.Complete) return false;
  if ((s.relevance ?? 0) <= RENDER_GATE) return false;
  const pub = parseMs(s.firstPubDate);
  return pub >= cutoffMs;
}

/** scoredAt ?? createdAt in epoch ms — the row's "added to feed" time. */
function addedMsOf(s: ForYouSuggestion): number {
  if (typeof s.scoredAt === 'number' && Number.isFinite(s.scoredAt)) return s.scoredAt;
  return parseMs(s.createdAt);
}

/** Breaking predicate (rawScore > 1.0, or ≥ 0.8 with a disaster/weather/conflict
 *  event type). Exported so the swipe-stack selector's deck ordering pins the
 *  same breaking stories first without duplicating the rule. */
export function isBreaking(s: ForYouSuggestion): boolean {
  const raw = s.rawScore;
  if (raw == null) return false;
  if (raw > 1.0) return true;
  return raw >= 0.8 && s.eventType != null && BREAKING_EVENT_TYPES.has(s.eventType);
}

/** Minimal ownership projection from a store row (only matchedTopics is read). */
function ownershipProjection(s: ForYouSuggestion): ScoredSuggestionProjection {
  return {
    id: s._id,
    rawScore: s.rawScore,
    relevance: s.relevance,
    pubDateMs: parseMs(s.firstPubDate),
    clusterMemberships: [],
    matchedTopics: (s.matchedTopics ?? []).map((m) => ({ topicId: m.topicId, text: m.text })),
  };
}

interface GroupItem extends GroupableItem {
  s: ForYouSuggestion;
}

/** Representative comparator: newest pubDate → higher rawScore → smaller id.
 *  (Standard sort order: negative ⇒ `a` preferred.) */
function repCompare(a: GroupItem, b: GroupItem): number {
  const pa = parseMs(a.s.firstPubDate);
  const pb = parseMs(b.s.firstPubDate);
  if (pa !== pb) return pb - pa;
  const ra = a.s.rawScore ?? Number.NEGATIVE_INFINITY;
  const rb = b.s.rawScore ?? Number.NEGATIVE_INFINITY;
  if (ra !== rb) return rb - ra;
  return a.s._id < b.s._id ? -1 : a.s._id > b.s._id ? 1 : 0;
}

/** Card (story-group) ordering within a row: newest pubDate first, then id. */
function cardCompare(a: FactRowGroup, b: FactRowGroup): number {
  if (a.pubDateMs !== b.pubDateMs) return b.pubDateMs - a.pubDateMs;
  return a.data._id < b.data._id ? -1 : a.data._id > b.data._id ? 1 : 0;
}

// --- public API -----------------------------------------------------------

/**
 * Build the fact-rows feed from the store rows + persona snapshots.
 *
 * @param suggestions the live `ForYouSuggestion` pool.
 * @param snapshots   topics/facts/locations + factStatements (from
 *                    `loadSectionSnapshots`).
 * @param nowMs       injected clock (deterministic testing).
 */
export function buildFactRows(
  suggestions: ForYouSuggestion[],
  snapshots: FactRowsSnapshots,
  nowMs: number = Date.now(),
  config: HarnessConfig = DEFAULT_HARNESS_CONFIG,
): FactRowsResult {
  const cutoffMs = nowMs - FEED_WINDOW_MS;
  const hpMult = config.scoringEngine.HP_MULT;

  // 1. Visible pool (note-gated + render gate + 24h window).
  const visible = suggestions.filter((s) => isVisible(s, cutoffMs));
  if (visible.length === 0) return { breaking: [], rows: [] };

  const byId = new Map<string, ForYouSuggestion>(visible.map((s) => [s._id, s]));

  // 2. Story-group the visible pool (display thresholds incl. the weighted edge).
  const items: GroupItem[] = visible.map((s) => ({
    id: s._id,
    title: s.title_en ?? s.title_original ?? null,
    clusters: s.clusters,
    s,
  }));
  const groups = buildStoryGroups(items, {
    titleJaccardThreshold: TITLE_JACCARD_DISPLAY_THRESHOLD,
    clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
    weightedJaccardThreshold: WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
  });

  // 3. Per group: pick a representative (newest member) + collapse members.
  const breaking: BreakingCardData[] = [];
  const assignable: { rep: ForYouSuggestion; group: FactRowGroup }[] = [];

  for (const g of groups) {
    const rep = pickRepresentative(g, repCompare).s;
    const members = g.map((it) => it.s).filter((m) => m._id !== rep._id);
    const all = [rep, ...members];
    const pubDateMs = all.reduce((mx, m) => Math.max(mx, parseMs(m.firstPubDate)), 0);
    const addedMs = all.reduce((mx, m) => Math.max(mx, addedMsOf(m)), 0);

    if (isBreaking(rep)) {
      breaking.push({ data: rep, members });
      continue;
    }
    assignable.push({
      rep,
      group: {
        data: rep,
        members,
        rawScore: rep.rawScore,
        bucket: bucketOf(rep.relevance, config),
        pubDateMs,
        addedMs,
      },
    });
  }

  breaking.sort((a, b) => {
    const ra = a.data.rawScore ?? Number.NEGATIVE_INFINITY;
    const rb = b.data.rawScore ?? Number.NEGATIVE_INFINITY;
    if (ra !== rb) return rb - ra;
    const pa = parseMs(a.data.firstPubDate);
    const pb = parseMs(b.data.firstPubDate);
    if (pa !== pb) return pb - pa;
    return a.data._id < b.data._id ? -1 : 1;
  });

  // 4. Assign each remaining group to its owning fact (owned) or the "also" row
  //    (zero-signal orphan). Negative matches drop.
  const factRows = new Map<string, FactRow>();
  const alsoGroups: FactRowGroup[] = [];

  for (const { rep, group } of assignable) {
    const ownership = resolveOwnership(ownershipProjection(rep), snapshots.topics, snapshots.facts, hpMult);
    if (ownership.kind === 'negative') continue; // suppression — dropped
    if (ownership.kind === 'owned') {
      const factId = ownership.factId;
      let row = factRows.get(factId);
      if (!row) {
        const fact = snapshots.facts.get(factId);
        row = {
          factId,
          kind: 'fact',
          statement: fact?.statement?.trim() || factId,
          factStatement: snapshots.factStatements.get(factId) ?? null,
          latestAddedMs: 0,
          groups: [],
        };
        factRows.set(factId, row);
      }
      row.groups.push(group);
      continue;
    }
    // orphan → "Also for you" (already past the render gate).
    alsoGroups.push(group);
  }

  // 5. Finalize each row: order cards newest-first, compute latestAddedMs.
  const rows: FactRow[] = [];
  for (const row of factRows.values()) {
    row.groups.sort(cardCompare);
    row.latestAddedMs = row.groups.reduce((mx, g) => Math.max(mx, g.addedMs), 0);
    rows.push(row);
  }

  // Rows sorted by their newest "added" time — a freshly-scored article bubbles
  // its fact row up. Ties broken by factId for determinism.
  rows.sort((a, b) => {
    if (a.latestAddedMs !== b.latestAddedMs) return b.latestAddedMs - a.latestAddedMs;
    return a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0;
  });

  // 6. Trailing "Also for you" row (always last).
  if (alsoGroups.length > 0) {
    alsoGroups.sort(cardCompare);
    rows.push({
      factId: ALSO_ROW_ID,
      kind: 'also',
      statement: ALSO_ROW_ID,
      factStatement: null,
      latestAddedMs: alsoGroups.reduce((mx, g) => Math.max(mx, g.addedMs), 0),
      groups: alsoGroups,
    });
  }

  return { breaking, rows };
}

/** True when a suggestion's article_id OR top stable cluster id is in the opened
 *  set — the card-dimming predicate. Ported from the deleted feed-sections
 *  selector. */
export function isSuggestionOpened(s: ForYouSuggestion, openedSet: Set<string>): boolean {
  if (openedSet.size === 0) return false;
  if (s.articleId && openedSet.has(s.articleId)) return true;
  const topStable = s.clusters?.find((c) => c.stableClusterId)?.stableClusterId;
  if (topStable && openedSet.has(topStable)) return true;
  return false;
}
