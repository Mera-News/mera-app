// feed-sections-selector — the thin RN adapter between the WatermelonDB feed
// rows (for-you-store `ForYouSuggestion` + the persona-v3 topics/facts/locations
// tables) and the pure, RN-free `selectSections` selector in
// `lib/news-harness/feed-select/sections.ts` (Wave 7c N2).
//
// Responsibilities:
//  1. `loadSectionSnapshots()` — read the small persona tables into the plain
//     Map snapshots `selectSections` consumes (async, RN-coupled).
//  2. `buildSelectSectionsInput()` — project the store's suggestion rows into
//     the selector's `ScoredSuggestionProjection` shape (pure).
//  3. `buildSectionedListData()` — flatten the selector's ordered sections into
//     the FlatList item stream the For You screen renders (pure).
//
// Everything below the snapshot loader is PURE (no DB/RN) so it unit-tests
// without a device.

import {
  selectSections,
  type ScoredSuggestionProjection,
  type SelectSectionsInput,
  type SelectSectionsResult,
  type FeedSection,
  type SectionGroup,
  type SectionKind,
  type TopicSnapshot,
  type FactSnapshot,
  type LocationSnapshot,
} from '@/lib/news-harness/feed-select';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { getActiveTopicSnapshots, countAllTopics } from '@/lib/database/services/topic-service';
import { getFactSectionSnapshots } from '@/lib/database/services/fact-service';
import { getAll as getAllLocations } from '@/lib/database/services/location-service';
import type { ForYouSuggestion } from './for-you-store';

/** Number of story groups rendered per section before the "Show N more" row. */
export const SECTION_TOP_N = 5;

/** Only stories from the last 24h are eligible (matches the legacy feed). */
const FEED_WINDOW_MS = 24 * 60 * 60 * 1000;

// --- Snapshots ------------------------------------------------------------

export interface SectionSnapshots {
  topics: Map<string, TopicSnapshot>;
  facts: Map<string, FactSnapshot>;
  locations: Map<string, LocationSnapshot>;
  /** factId → the REAL fact statement (for the section-header reveal). The
   *  `facts` snapshot's `statement` is the *section title* (section_title when
   *  generated, else the statement) — kept separate so the reveal always shows
   *  the underlying fact even once titles diverge. */
  factStatements: Map<string, string>;
  /** True when the persona-v3 `topics` table has any rows. False ⇒ pre-migration
   *  → the screen renders the legacy priority-bucket layout. */
  hasTopics: boolean;
}

/**
 * Read the persona-v3 tables into the plain Map snapshots `selectSections`
 * consumes. Small tables (topics/facts/locations) — one shot per rebuild.
 */
export async function loadSectionSnapshots(): Promise<SectionSnapshots> {
  const [topicRows, factRows, locationRows, topicCount] = await Promise.all([
    getActiveTopicSnapshots(),
    getFactSectionSnapshots(),
    getAllLocations(),
    countAllTopics(),
  ]);

  const topics = new Map<string, TopicSnapshot>();
  for (const t of topicRows) {
    topics.set(t.id, {
      factId: t.factId,
      weight: t.weight,
      highPriority: t.highPriority,
      status: 'active',
    });
  }

  const facts = new Map<string, FactSnapshot>();
  const factStatements = new Map<string, string>();
  for (const f of factRows) {
    facts.set(f.id, {
      weight: f.weight,
      createdAtMs: f.createdAtMs,
      // Section title = generated section_title when present, else the statement.
      statement: f.sectionTitle ?? f.statement,
    });
    factStatements.set(f.id, f.statement);
  }

  const locations = new Map<string, LocationSnapshot>();
  for (const l of locationRows) {
    locations.set(l.id, {
      city: l.city,
      region: l.region,
      countryCode: l.countryCode,
      country: null,
      weight: l.weight,
    });
  }

  return { topics, facts, locations, factStatements, hasTopics: topicCount > 0 };
}

// --- Projection (pure) ----------------------------------------------------

function pubDateMsOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Project the store's suggestion rows into the selector input. Rows are
 * pre-filtered to the 24h window; scored rows at/below the 0.3 render gate are
 * dropped (unscored rows are kept so they render progressively). `nowMs` is
 * injected for deterministic testing.
 */
export function buildSelectSectionsInput(
  suggestions: ForYouSuggestion[],
  snapshots: Pick<SectionSnapshots, 'topics' | 'facts' | 'locations'>,
  nowMs: number = Date.now(),
): SelectSectionsInput {
  const cutoff = nowMs - FEED_WINDOW_MS;
  const projections: ScoredSuggestionProjection[] = [];

  for (const s of suggestions) {
    const scored = s.status !== ArticleSuggestionStatus.Unscored;
    const pubMs = pubDateMsOf(s.firstPubDate);
    if (pubMs < cutoff) continue;
    // Scored-but-below-gate rows never render.
    if (scored && s.relevance <= 0.3) continue;

    // rawScore drives within-section ordering + breaking extraction. Fall back
    // to the bucketed `relevance` when the finer audit score wasn't written.
    const rawScore = s.rawScore ?? (scored ? s.relevance : null);
    const topStable = s.clusters.find((c) => c.stableClusterId)?.stableClusterId ?? null;

    projections.push({
      id: s._id,
      rawScore,
      relevance: scored ? s.relevance : null,
      status: s.status,
      pubDateMs: pubMs,
      title: s.title_en ?? s.title_original ?? null,
      clusterMemberships: s.clusters.map((c) => ({
        clusterId: c.clusterId,
        confidence: c.confidence,
        stableClusterId: c.stableClusterId ?? null,
      })),
      stableClusterId: topStable,
      eventType: s.eventType,
      headlineScope: s.headlineScope,
      // headlineLocationId is not persisted on the row (headline injection lands
      // in Wave 8); until then CITY/COUNTRY headline sections use their generic
      // titles. Absent → undefined.
      headlineLocationId: undefined,
      matchedTopics: s.matchedTopics.map((m) => ({ topicId: m.topicId, text: m.text })),
    });
  }

  return {
    suggestions: projections,
    topics: snapshots.topics,
    facts: snapshots.facts,
    locations: snapshots.locations,
  };
}

// --- Sectioned list data (pure) -------------------------------------------

/** One breaking-strip entry (representative + collapsed members). */
export interface BreakingCardData {
  data: ForYouSuggestion;
  members: ForYouSuggestion[];
}

export type SectionedListItem =
  | { type: 'breaking-strip'; key: string; items: BreakingCardData[] }
  | {
      type: 'fact-header';
      key: string;
      section: FeedSection;
      /** event_type of the section's top item (icon prefix), or null. */
      eventType: string | null;
      /** The owning fact's real statement (why-this-section reveal), or null. */
      factStatement: string | null;
    }
  | {
      type: 'suggestion-card';
      key: string;
      /** The section this card belongs to (for keying/expansion). */
      sectionKey: string;
      data: ForYouSuggestion;
      members: ForYouSuggestion[];
    }
  | { type: 'show-more'; key: string; sectionKey: string; remaining: number }
  // ── Two-zone feed variants (buildTwoZoneListData) ──────────────────────
  /** Boundary between the "new" zone (above) and the "Earlier" zone (below).
   *  `variant: 'empty-new'` when the new zone has NO section cards (breaking is
   *  independent and does not affect the variant); `'normal'` otherwise. Omitted
   *  entirely when the Earlier zone is empty. */
  | {
      type: 'caught-up-divider';
      key: string;
      variant: 'normal' | 'empty-new';
      /** Total previously-presented groups below the divider. */
      earlierCount: number;
    }
  /** One previously-presented (Earlier-zone) story row. `opened` is true when the
   *  representative's article_id OR top stable cluster id is in the opened set. */
  | { type: 'earlier-card'; key: string; data: ForYouSuggestion; opened: boolean }
  /** Reveals the rest of the Earlier zone (expansion key `EARLIER_EXPANSION_KEY`). */
  | { type: 'earlier-show-more'; key: string; count: number };

/**
 * Flatten `selectSections` output into the FlatList item stream. Top-N groups
 * per section are rendered; the rest hide behind a "Show N more" row until the
 * section key is in `expandedKeys`.
 */
export function buildSectionedListData(
  result: SelectSectionsResult,
  expandedKeys: Set<string>,
  byId: Map<string, ForYouSuggestion>,
  factStatements: Map<string, string> = new Map(),
  topN: number = SECTION_TOP_N,
): SectionedListItem[] {
  const items: SectionedListItem[] = [];

  // Breaking strip — one horizontal row above everything.
  const breakingCards: BreakingCardData[] = [];
  for (const b of result.breaking) {
    const rep = byId.get(b.representativeId);
    if (!rep) continue;
    breakingCards.push({ data: rep, members: resolveMembers(b.memberIds, b.representativeId, byId) });
  }
  if (breakingCards.length > 0) {
    items.push({ type: 'breaking-strip', key: 'breaking-strip', items: breakingCards });
  }

  for (const section of result.sections) {
    const topRep = byId.get(section.groups[0]?.representativeId ?? '');
    items.push({
      type: 'fact-header',
      key: `header:${section.key}`,
      section,
      eventType: topRep?.eventType ?? null,
      factStatement: section.factId ? factStatements.get(section.factId) ?? null : null,
    });

    const expanded = expandedKeys.has(section.key);
    const visibleGroups = expanded ? section.groups : section.groups.slice(0, topN);
    for (const g of visibleGroups) {
      const rep = byId.get(g.representativeId);
      if (!rep) continue;
      items.push({
        type: 'suggestion-card',
        key: g.representativeId,
        sectionKey: section.key,
        data: rep,
        members: resolveMembers(g.memberIds, g.representativeId, byId),
      });
    }

    const remaining = section.groups.length - topN;
    if (!expanded && remaining > 0) {
      items.push({
        type: 'show-more',
        key: `more:${section.key}`,
        sectionKey: section.key,
        remaining,
      });
    }
  }

  return items;
}

function resolveMembers(
  memberIds: string[],
  representativeId: string,
  byId: Map<string, ForYouSuggestion>,
): ForYouSuggestion[] {
  const out: ForYouSuggestion[] = [];
  for (const id of memberIds) {
    if (id === representativeId) continue;
    const m = byId.get(id);
    if (m) out.push(m);
  }
  return out;
}

/** Convenience: snapshots + rows → sectioned list items in one call (screen use).
 *  Returns the raw selector result too (for the SectionNavigator chips). */
export function buildSectionedFeed(
  suggestions: ForYouSuggestion[],
  snapshots: SectionSnapshots,
  expandedKeys: Set<string>,
  nowMs: number = Date.now(),
): { result: SelectSectionsResult; items: SectionedListItem[] } {
  const input = buildSelectSectionsInput(suggestions, snapshots, nowMs);
  const result = selectSections(input);
  const byId = new Map(suggestions.map((s) => [s._id, s]));
  const items = buildSectionedListData(result, expandedKeys, byId, snapshots.factStatements);
  return { result, items };
}

// --- Two-zone list data (pure) --------------------------------------------
//
// The two-zone feed splits the sectioned output around the presentation
// watermark: groups that are entirely newer than the watermark render in the
// top ("new") zone with their normal section chrome; every previously-presented
// group collapses into a single flat "Earlier" zone below a caught-up divider.

/** Groups shown in the Earlier zone before the "Show N more" row. */
export const EARLIER_TOP_N = 10;

/** Expansion key (in `expandedKeys`) that reveals the full Earlier zone. */
export const EARLIER_EXPANSION_KEY = '__earlier__';

/** Earliest member `createdAt` (epoch ms) of a group — the whole group is "new"
 *  only when this (its OLDEST member) is still newer than the watermark, so a
 *  fresh sibling of an already-presented story keeps the group in Earlier. */
function groupEarliestCreatedMs(
  memberIds: string[],
  byId: Map<string, ForYouSuggestion>,
): number {
  let min = Number.POSITIVE_INFINITY;
  for (const id of memberIds) {
    const s = byId.get(id);
    if (!s) continue;
    const t = Date.parse(s.createdAt);
    if (Number.isFinite(t) && t < min) min = t;
  }
  return min === Number.POSITIVE_INFINITY ? 0 : min;
}

/** True when a representative's article_id OR top stable cluster id is opened. */
function isOpened(rep: ForYouSuggestion, openedSet: Set<string>): boolean {
  if (openedSet.size === 0) return false;
  if (rep.articleId && openedSet.has(rep.articleId)) return true;
  const topStable = rep.clusters.find((c) => c.stableClusterId)?.stableClusterId;
  if (topStable && openedSet.has(topStable)) return true;
  return false;
}

/**
 * Flatten `selectSections` output into the two-zone FlatList item stream.
 *
 *  Zone 1 (new): a leading breaking-strip (ALWAYS, full set — breaking ignores
 *  the watermark), then each section rebuilt with only its groups whose earliest
 *  member is newer than `watermarkMs`. Sections left with zero new groups are
 *  dropped. Top-N + show-more within a section are unchanged.
 *
 *  Divider: a `caught-up-divider` (omitted when Zone 2 is empty).
 *
 *  Zone 2 (Earlier): every previously-presented group, flattened across
 *  sections and globally re-ordered rawScore desc → pubDate desc, each an
 *  `earlier-card` carrying an `opened` flag. Top-N (`EARLIER_TOP_N`) with an
 *  `earlier-show-more` unless `EARLIER_EXPANSION_KEY` is expanded.
 */
export function buildTwoZoneListData(
  result: SelectSectionsResult,
  expandedKeys: Set<string>,
  byId: Map<string, ForYouSuggestion>,
  factStatements: Map<string, string> = new Map(),
  watermarkMs: number = 0,
  openedSet: Set<string> = new Set(),
  topN: number = SECTION_TOP_N,
): SectionedListItem[] {
  const items: SectionedListItem[] = [];

  // Breaking strip — always the full set, independent of the watermark.
  const breakingCards: BreakingCardData[] = [];
  for (const b of result.breaking) {
    const rep = byId.get(b.representativeId);
    if (!rep) continue;
    breakingCards.push({ data: rep, members: resolveMembers(b.memberIds, b.representativeId, byId) });
  }
  if (breakingCards.length > 0) {
    items.push({ type: 'breaking-strip', key: 'breaking-strip', items: breakingCards });
  }

  // Partition each section's groups into NEW (zone 1) and EARLIER (zone 2).
  const earlier: { group: SectionGroup; rep: ForYouSuggestion }[] = [];
  let zone1HasNew = false;

  for (const section of result.sections) {
    const newGroups: SectionGroup[] = [];
    for (const g of section.groups) {
      if (groupEarliestCreatedMs(g.memberIds, byId) > watermarkMs) {
        newGroups.push(g);
      } else {
        const rep = byId.get(g.representativeId);
        if (rep) earlier.push({ group: g, rep });
      }
    }
    if (newGroups.length === 0) continue; // no new content → section dropped from zone 1
    zone1HasNew = true;

    const topRep = byId.get(newGroups[0]?.representativeId ?? '');
    items.push({
      type: 'fact-header',
      key: `header:${section.key}`,
      // Re-scoped section: only its new groups (keeps count/expansion honest).
      section: { ...section, groups: newGroups },
      eventType: topRep?.eventType ?? null,
      factStatement: section.factId ? factStatements.get(section.factId) ?? null : null,
    });

    const expanded = expandedKeys.has(section.key);
    const visibleGroups = expanded ? newGroups : newGroups.slice(0, topN);
    for (const g of visibleGroups) {
      const rep = byId.get(g.representativeId);
      if (!rep) continue;
      items.push({
        type: 'suggestion-card',
        key: g.representativeId,
        sectionKey: section.key,
        data: rep,
        members: resolveMembers(g.memberIds, g.representativeId, byId),
      });
    }
    const remaining = newGroups.length - topN;
    if (!expanded && remaining > 0) {
      items.push({ type: 'show-more', key: `more:${section.key}`, sectionKey: section.key, remaining });
    }
  }

  // Zone 2 — no earlier groups ⇒ no divider, no zone.
  if (earlier.length === 0) return items;

  earlier.sort((a, b) => {
    const sa = a.group.rawScore == null ? Number.NEGATIVE_INFINITY : a.group.rawScore;
    const sb = b.group.rawScore == null ? Number.NEGATIVE_INFINITY : b.group.rawScore;
    if (sa !== sb) return sb - sa; // rawScore desc
    const pa = pubDateMsOf(a.rep.firstPubDate);
    const pb = pubDateMsOf(b.rep.firstPubDate);
    if (pa !== pb) return pb - pa; // pubDate desc
    return a.rep._id < b.rep._id ? -1 : a.rep._id > b.rep._id ? 1 : 0;
  });

  items.push({
    type: 'caught-up-divider',
    key: 'caught-up',
    variant: zone1HasNew ? 'normal' : 'empty-new',
    earlierCount: earlier.length,
  });

  const earlierExpanded = expandedKeys.has(EARLIER_EXPANSION_KEY);
  const visibleEarlier = earlierExpanded ? earlier : earlier.slice(0, EARLIER_TOP_N);
  for (const e of visibleEarlier) {
    items.push({
      type: 'earlier-card',
      key: `earlier:${e.rep._id}`,
      data: e.rep,
      opened: isOpened(e.rep, openedSet),
    });
  }
  const earlierRemaining = earlier.length - EARLIER_TOP_N;
  if (!earlierExpanded && earlierRemaining > 0) {
    items.push({ type: 'earlier-show-more', key: 'earlier-more', count: earlierRemaining });
  }

  return items;
}

/** True when a suggestion's article_id OR top stable cluster id is in the opened
 *  set — the dimming predicate for zone-1 cards. Mirrors the internal Earlier
 *  rule so both zones dim consistently. */
export function isSuggestionOpened(s: ForYouSuggestion, openedSet: Set<string>): boolean {
  return isOpened(s, openedSet);
}

/** Convenience: snapshots + rows → two-zone list items in one call (screen use).
 *  Returns the raw selector result too (for the SectionNavigator descriptors). */
export function buildTwoZoneFeed(
  suggestions: ForYouSuggestion[],
  snapshots: SectionSnapshots,
  expandedKeys: Set<string>,
  watermarkMs: number,
  openedSet: Set<string>,
  nowMs: number = Date.now(),
): { result: SelectSectionsResult; items: SectionedListItem[] } {
  const input = buildSelectSectionsInput(suggestions, snapshots, nowMs);
  const result = selectSections(input);
  const byId = new Map(suggestions.map((s) => [s._id, s]));
  const items = buildTwoZoneListData(
    result,
    expandedKeys,
    byId,
    snapshots.factStatements,
    watermarkMs,
    openedSet,
  );
  return { result, items };
}

/** A zone-1 section as the SectionNavigator chips need it (post-watermark). */
export interface ZoneSectionDescriptor {
  key: string;
  title: string;
  kind: SectionKind;
  /** New (post-watermark) group count in this section. */
  count: number;
}

/**
 * Zone-1 section descriptors (for the SectionNavigator), in the SAME order and
 * with the SAME watermark rule `buildTwoZoneListData` uses — only sections with
 * at least one new group are returned.
 */
export function zoneOneSectionDescriptors(
  result: SelectSectionsResult,
  byId: Map<string, ForYouSuggestion>,
  watermarkMs: number = 0,
): ZoneSectionDescriptor[] {
  const out: ZoneSectionDescriptor[] = [];
  for (const section of result.sections) {
    let count = 0;
    for (const g of section.groups) {
      if (groupEarliestCreatedMs(g.memberIds, byId) > watermarkMs) count += 1;
    }
    if (count > 0) out.push({ key: section.key, title: section.title, kind: section.kind, count });
  }
  return out;
}
