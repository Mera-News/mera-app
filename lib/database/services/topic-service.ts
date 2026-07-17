// Topic Service — WatermelonDB adapter for persona-v3 `topics`.
//
// Thin RN-coupled surface: create/read/observe + status & weight mutations.
// All bounded-mutation / rails logic (per-day budgets, HP_MULT, etc.) lives in
// the news-harness (later wave) — these are just the DB writers it delegates to.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type TopicModel from '../models/Topic';
import type { TopicProvenance, TopicStatus } from '../models/Topic';
import { planLlmTopicRows } from '../../news-harness/persona-management/topic-generation';
import { DEFAULT_HARNESS_CONFIG } from '../../news-harness/core/config';

const topicsCollection = database.get<TopicModel>('topics');

/** Lowercase + trim + collapse whitespace — the dedup + article-match key. */
export function normalizeTopicText(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

export interface CreateTopicInput {
  factId?: string | null;
  text: string;
  normalizedText?: string;
  weight?: number;
  status?: TopicStatus;
  provenance?: TopicProvenance;
  highPriority?: boolean;
  locationId?: string | null;
  lastSignalAt?: number | null;
}

/** Batch-creates topic rows in a single write. Returns the created records. */
export async function createTopics(inputs: CreateTopicInput[]): Promise<TopicModel[]> {
  if (inputs.length === 0) return [];
  return database.write(async () => {
    const now = new Date();
    const prepared = inputs.map((input) =>
      topicsCollection.prepareCreate((t) => {
        t.factId = input.factId ?? null;
        t.text = input.text;
        t.normalizedText = input.normalizedText ?? normalizeTopicText(input.text);
        t.weight = input.weight ?? 0;
        t.status = input.status ?? 'active';
        t.provenance = input.provenance ?? 'user';
        t.highPriority = input.highPriority ?? false;
        t.locationId = input.locationId ?? null;
        t.lastSignalAt = input.lastSignalAt ?? null;
        t.createdAt = now;
        t.updatedAt = now;
      }),
    );
    await database.batch(prepared);
    return prepared;
  });
}

/** Returns all topic rows owned by a fact (any status). */
export async function getByFact(factId: string): Promise<TopicModel[]> {
  return topicsCollection.query(Q.where('fact_id', factId)).fetch();
}

/** Reactive query of a fact's topics — for the in-chat topic-review widget. */
export function observeByFact(factId: string) {
  return topicsCollection.query(Q.where('fact_id', factId)).observe();
}

/** Active topics (any weight). */
export async function getActive(): Promise<TopicModel[]> {
  return topicsCollection.query(Q.where('status', 'active')).fetch();
}

/** Persona-v3 active-topic snapshot for the fact-sectioned feed selector:
 *  the fields `resolveOwningFact` reads (topic → owning fact + effective
 *  weight). Only `active` topics own sections, so this loads just those. */
export interface ActiveTopicSnapshot {
  id: string;
  factId: string | null;
  weight: number;
  highPriority: boolean;
}

export async function getActiveTopicSnapshots(): Promise<ActiveTopicSnapshot[]> {
  const rows = await getActive();
  return rows.map((t) => ({
    id: t.id,
    factId: t.factId ?? null,
    weight: t.weight,
    highPriority: t.highPriority,
  }));
}

/** Persona-hygiene snapshot for one topic row (ALL statuses). Carries the
 *  fields the fact-hygiene analyzer reads: owning fact, normalized text (dupe
 *  key), weight, status, and last-signal (stale detector). Kept RN-free-shaped
 *  so the pure analyzer never touches a WatermelonDB model. */
export interface TopicHygieneSnapshot {
  id: string;
  factId: string | null;
  text: string;
  normalizedText: string;
  weight: number;
  status: TopicStatus;
  lastSignalAtMs: number | null;
}

/** All topic rows (any status) projected to the hygiene snapshot shape. */
export async function getAllTopicSnapshots(): Promise<TopicHygieneSnapshot[]> {
  const rows = await topicsCollection.query().fetch();
  return rows.map((t) => ({
    id: t.id,
    factId: t.factId ?? null,
    text: t.text,
    normalizedText: t.normalizedText,
    weight: t.weight,
    status: t.status,
    lastSignalAtMs: t.lastSignalAt ?? null,
  }));
}

/** Count of all topic rows (any status) — the gate for the sectioned feed:
 *  an empty topics table means the persona-v3 migration hasn't run yet, so the
 *  screen renders the legacy priority-bucket layout. */
export async function countAllTopics(): Promise<number> {
  return topicsCollection.query().fetchCount();
}

/** All topics sharing a normalized text (dedup + cross-fact overlap detection). */
export async function getAllByNormalizedText(normalizedText: string): Promise<TopicModel[]> {
  return topicsCollection
    .query(Q.where('normalized_text', normalizeTopicText(normalizedText)))
    .fetch();
}

export async function setWeight(topicId: string, weight: number): Promise<void> {
  const clamped = Math.max(-1, Math.min(1, weight));
  const record = await topicsCollection.find(topicId);
  await database.write(async () => {
    await record.update((t) => {
      t.weight = clamped;
      t.updatedAt = new Date();
    });
  });
}

export async function setHighPriority(topicId: string, highPriority: boolean): Promise<void> {
  const record = await topicsCollection.find(topicId);
  await database.write(async () => {
    await record.update((t) => {
      t.highPriority = highPriority;
      t.updatedAt = new Date();
    });
  });
}

async function setStatus(topicId: string, status: TopicStatus): Promise<void> {
  const record = await topicsCollection.find(topicId);
  await database.write(async () => {
    await record.update((t) => {
      t.status = status;
      t.updatedAt = new Date();
    });
  });
}

/** Retire a topic (dedup/history only — never retrieved or scored). */
export async function retire(topicId: string): Promise<void> {
  await setStatus(topicId, 'retired');
}

/** Suppress a topic (hard filter). */
export async function suppress(topicId: string): Promise<void> {
  await setStatus(topicId, 'suppressed');
}

/** Reactivate a suppressed/retired topic. */
export async function reactivate(topicId: string): Promise<void> {
  await setStatus(topicId, 'active');
}

/**
 * Wave 11 — mint `topics` rows for the texts an LLM topic-generation run produced
 * for a fact. This is the gap-fix: live fact-saves used to land topics only in
 * `fact.metadata.topics`, so they never reached the wave-7 feed retrieval (which
 * reads the `topics` TABLE). Deduped per fact against the fact's existing rows by
 * normalized text (so re-generation / "generate more" never duplicates). Rows are
 * `active`, provenance `llm`, seed weight from config, not high-priority.
 *
 * NOTE: intentionally does NOT append a persona_change_log row. Bulk LLM minting
 * is not a user mutation (mirrors the migration precedent, which logged only
 * because it seeded a brand-new persona). User-facing topic edits DO log — those
 * route through mutation-rails / persona-action-executor.
 */
export async function syncLlmTopicsForFact(
  factId: string,
  topicTexts: string[],
): Promise<TopicModel[]> {
  if (topicTexts.length === 0) return [];
  const existing = await getByFact(factId);
  const planned = planLlmTopicRows(
    existing.map((t) => t.normalizedText),
    topicTexts,
    normalizeTopicText,
  );
  if (planned.length === 0) return [];
  return createTopics(
    planned.map((p) => ({
      factId,
      text: p.text,
      normalizedText: p.normalizedText,
      weight: DEFAULT_HARNESS_CONFIG.topicGen.llmTopicWeight,
      status: 'active' as const,
      provenance: 'llm' as const,
      highPriority: false,
    })),
  );
}

/**
 * Re-parent every topic row owned by `fromFactId` onto `toFactId`. Used by the
 * conflict-resolution "merge" flow (the old fact is deleted; its topics follow
 * the surviving fact). Single write. NOT invertible — no change-log row is
 * appended (there is no reassign_topic inverse yet).
 */
export async function reassignTopics(
  fromFactId: string,
  toFactId: string,
): Promise<number> {
  const rows = await getByFact(fromFactId);
  if (rows.length === 0) return 0;
  await database.write(async () => {
    const now = new Date();
    const batch = rows.map((r) =>
      r.prepareUpdate((t) => {
        t.factId = toFactId;
        t.updatedAt = now;
      }),
    );
    await database.batch(batch);
  });
  return rows.length;
}
