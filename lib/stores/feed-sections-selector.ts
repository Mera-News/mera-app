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
  | { type: 'show-more'; key: string; sectionKey: string; remaining: number };

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
