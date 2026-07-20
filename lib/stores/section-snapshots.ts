// section-snapshots — the small RN-coupled loader that reads the persona-v3
// tables (topics / facts / locations) into the plain Map snapshots the pure
// fact-ownership cores consume (`resolveOwnership` in feed-select/ownership,
// the fact-rows feed selector, and the per-fact scoring batcher).
//
// Moved here in Round-3 C3 when the Wave-7 `feed-sections-selector` was deleted;
// this is the one piece that genuinely needed a home (it touches the DB, so it
// can't live in a pure selector module).

import type {
  TopicSnapshot,
  FactSnapshot,
  LocationSnapshot,
} from '@/lib/news-harness/feed-select';
import { getActiveTopicSnapshots, countAllTopics } from '@/lib/database/services/topic-service';
import { getFactSectionSnapshots } from '@/lib/database/services/fact-service';
import { getAll as getAllLocations } from '@/lib/database/services/location-service';

export interface SectionSnapshots {
  topics: Map<string, TopicSnapshot>;
  facts: Map<string, FactSnapshot>;
  locations: Map<string, LocationSnapshot>;
  /** factId → the REAL fact statement (for the fact-row header reveal / fact
   *  feed title). The `facts` snapshot's `statement` is the *display title*
   *  (section_title when generated, else the statement) — kept separate so the
   *  underlying fact is always available even once titles diverge. */
  factStatements: Map<string, string>;
  /** True when the persona-v3 `topics` table has any rows. */
  hasTopics: boolean;
}

/**
 * Read the persona-v3 tables into the plain Map snapshots the ownership cores
 * consume. Small tables (topics/facts/locations) — one shot per rebuild.
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
      // Display title = generated section_title when present, else the statement.
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
