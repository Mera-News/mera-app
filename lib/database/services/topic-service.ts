// Topic Service — WatermelonDB adapter for persona-v3 `topics`.
//
// Thin RN-coupled surface: create/read/observe + status & weight mutations.
// All bounded-mutation / rails logic (per-day budgets, HP_MULT, etc.) lives in
// the news-harness (later wave) — these are just the DB writers it delegates to.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type TopicModel from '../models/Topic';
import type { TopicProvenance, TopicStatus } from '../models/Topic';

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
