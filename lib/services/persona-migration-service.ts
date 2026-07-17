// Persona v3 silent migration — RN runner (Wave 6, M-P2).
//
// Executes the pure plan from lib/news-harness/persona-management/
// persona-migration.ts against WatermelonDB. Silent: no UI, no LLM calls —
// deterministic-only this wave (the LLM location-refinement pass is later).
//
// Guarantees:
//  - RUN-ONCE guard: settings KV `persona_v3_migrated` ('pending' | 'done').
//    Set to 'pending' when a run starts; only flipped to 'done' after every
//    eligible fact has been migrated. A crash mid-run leaves 'pending' and the
//    next run RESUMES.
//  - IDEMPOTENT / RESUMABLE: a fact is skipped when it already has `topics`
//    rows OR its `weight` is already set (each chunk writes topics + weight +
//    change-log in ONE transaction, so either marker proves completion; the
//    weight marker also covers facts with zero metadata topics). Location
//    upserts dedupe on (city, country, role) inside location-service.
//  - `fact.metadata.topics` is NEVER modified.
//  - Nothing in the sync/scoring path reads the new tables yet — this only
//    POPULATES them; the feed keeps running on `fact.metadata.topics` until
//    the M-P4 cutover wave.

import { Q, type Model } from '@nozbe/watermelondb';
import database from '@/lib/database';
import logger from '@/lib/logger';
import type FactModel from '@/lib/database/models/Fact';
import type TopicModel from '@/lib/database/models/Topic';
import type PersonaChangeLogModel from '@/lib/database/models/PersonaChangeLog';
import { upsertLocation } from '@/lib/database/services/location-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  buildPersonaMigrationPlan,
  type FactSnapshot,
} from '@/lib/news-harness/persona-management/persona-migration';

export const PERSONA_V3_MIGRATION_KEY = 'persona_v3_migrated';

/** Facts written per transaction — keeps individual writes small while a
 *  crash between chunks stays resumable. */
const MIGRATION_CHUNK_SIZE = 50;

export interface PersonaMigrationResult {
  ran: boolean;
  factsMigrated: number;
  topicsCreated: number;
  locationsUpserted: number;
}

const factsCollection = database.get<FactModel>('facts');
const topicsCollection = database.get<TopicModel>('topics');
const changeLogCollection = database.get<PersonaChangeLogModel>('persona_change_log');

function toSnapshot(fact: FactModel): FactSnapshot {
  const topics = fact.metadata?.topics;
  return {
    id: fact.id,
    statement: fact.statement,
    topics: Array.isArray(topics) ? topics : [],
    questionnaireAttribute: fact.questionnaireAttribute ?? null,
  };
}

/**
 * Runs the one-time silent persona migration if it has not completed yet.
 * Safe to call repeatedly (app-init / scheduler): once the guard reads
 * 'done' the cost is a single settings read.
 */
export async function runPersonaMigrationIfNeeded(): Promise<PersonaMigrationResult> {
  const status = await getSetting(PERSONA_V3_MIGRATION_KEY);
  if (status === 'done') {
    return { ran: false, factsMigrated: 0, topicsCreated: 0, locationsUpserted: 0 };
  }
  if (status !== 'pending') {
    await setSetting(PERSONA_V3_MIGRATION_KEY, 'pending');
  }

  // Resume filter: skip facts that already have topics rows or a weight.
  const allFacts = await factsCollection.query().fetch();
  const migratedFactIds = new Set<string>();
  const existingTopics = await topicsCollection
    .query(Q.where('fact_id', Q.notEq(null)))
    .fetch();
  for (const t of existingTopics) {
    if (t.factId) migratedFactIds.add(t.factId);
  }
  const eligible = allFacts.filter(
    (f) => !migratedFactIds.has(f.id) && f.weight == null,
  );

  let factsMigrated = 0;
  let topicsCreated = 0;
  let locationsUpserted = 0;

  try {
    for (let i = 0; i < eligible.length; i += MIGRATION_CHUNK_SIZE) {
      const chunk = eligible.slice(i, i + MIGRATION_CHUNK_SIZE);
      const plan = buildPersonaMigrationPlan(chunk.map(toSnapshot));

      // 1. Locations first (idempotent upserts, own transactions) so the
      //    topic rows created below can link `location_id` atomically.
      const locationByFactId = new Map<string, { id: string; city: string | null }>();
      for (const candidate of plan.locationCandidates) {
        const record = await upsertLocation({
          city: candidate.city,
          region: candidate.region,
          countryCode: candidate.countryCode,
          role: candidate.role,
          weight: candidate.weight,
          validUntil: candidate.validUntil,
          provenance: 'migration',
          sourceFactId: candidate.sourceFactId,
        });
        locationByFactId.set(candidate.sourceFactId, {
          id: record.id,
          city: candidate.city,
        });
        locationsUpserted += 1;
      }

      // 2. Topics + fact weights + change log in ONE transaction — the
      //    completion marker for every fact in the chunk.
      const factById = new Map(chunk.map((f) => [f.id, f]));
      await database.write(async () => {
        const now = new Date();
        const batch: Model[] = [];

        for (const row of plan.topicRows) {
          const loc = locationByFactId.get(row.factId);
          const locationId =
            loc && loc.city && row.normalizedText.includes(loc.city.toLowerCase())
              ? loc.id
              : null;
          batch.push(
            topicsCollection.prepareCreate((t) => {
              t.factId = row.factId;
              t.text = row.text;
              t.normalizedText = row.normalizedText;
              t.weight = row.weight;
              t.status = row.status;
              t.provenance = row.provenance;
              t.highPriority = row.highPriority;
              t.locationId = locationId;
              t.lastSignalAt = null;
              t.createdAt = now;
              t.updatedAt = now;
            }),
          );
        }

        for (const update of plan.factWeightUpdates) {
          const fact = factById.get(update.factId);
          if (!fact) continue;
          batch.push(
            fact.prepareUpdate((f) => {
              f.weight = update.weight;
            }),
          );
        }

        for (const entry of plan.changeLogEntries) {
          batch.push(
            changeLogCollection.prepareCreate((row) => {
              row.actionType = entry.actionType;
              row.actionJson = JSON.stringify(entry.action);
              row.source = entry.source;
              row.summary = entry.summary;
              row.reverted = false;
              row.createdAt = now;
            }),
          );
        }

        await database.batch(batch);
      });

      factsMigrated += chunk.length;
      topicsCreated += plan.topicRows.length;
    }

    await setSetting(PERSONA_V3_MIGRATION_KEY, 'done');
    return { ran: true, factsMigrated, topicsCreated, locationsUpserted };
  } catch (error) {
    // Leave the guard at 'pending' — the next run resumes from the last
    // fully-written chunk.
    logger.captureException(error, {
      tags: { service: 'persona-migration', method: 'runPersonaMigrationIfNeeded' },
    });
    throw error;
  }
}
