// Fact Service — WatermelonDB replacement for factsDb.ts
// Same public API. Returns plain objects matching Fact/FactTopicLink interfaces.

import { Model, Q } from '@nozbe/watermelondb';
import database from '../index';
import type FactModel from '../models/Fact';
import type FactTopicLinkModel from '../models/FactTopicLink';
import type { Fact, FactTopicLink } from '../../mera-protocol-toolkit/types';
import { getSetting, setSetting } from './setting-service';

const factsCollection = database.get<FactModel>('facts');
const linksCollection = database.get<FactTopicLinkModel>('fact_topic_links');

// --- Helpers ---

function toFact(record: FactModel): Fact {
  return {
    id: record.id,
    statement: record.statement,
    metadata: record.metadata,
    questionnaireLevel: record.questionnaireLevel ?? undefined,
    questionnaireLevelCategory: record.questionnaireLevelCategory ?? undefined,
    questionnaireAttribute: record.questionnaireAttribute ?? undefined,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toFactTopicLink(record: FactTopicLinkModel): FactTopicLink {
  return {
    factId: record.factId,
    serverTopicId: record.serverTopicId,
    topicText: record.topicText,
  };
}

// --- Facts CRUD ---

export async function addFact(
  statement: string,
  metadata?: Record<string, string[]>,
  questionnaire?: {
    level?: number;
    levelCategory?: string;
    attribute?: string;
  },
): Promise<Fact> {
  const record = await database.write(async () => {
    return factsCollection.create((fact) => {
      fact.statement = statement;
      if (metadata) fact.metadata = metadata;
      if (questionnaire) {
        if (questionnaire.level !== undefined) fact.questionnaireLevel = questionnaire.level;
        if (questionnaire.levelCategory !== undefined) fact.questionnaireLevelCategory = questionnaire.levelCategory;
        if (questionnaire.attribute !== undefined) fact.questionnaireAttribute = questionnaire.attribute;
      }
    });
  });
  return toFact(record);
}

export async function updateFact(
  id: string,
  updates: Partial<Pick<Fact, 'statement' | 'metadata'>>,
): Promise<Fact> {
  const record = await factsCollection.find(id);
  await record.updateFact(
    updates.statement ?? record.statement,
    updates.metadata !== undefined ? updates.metadata : record.metadata,
  );
  return toFact(record);
}

export async function deleteFact(id: string): Promise<void> {
  const record = await factsCollection.find(id);
  await record.destroyCascade();
}

/**
 * Mark facts that have no topics, no error, and no active topic_gen job with
 * a `topicGenError`. Called on app startup to rescue facts whose in-flight
 * generation job died before completing (crash, max retries exhausted, etc.)
 * so the UI stops spinning on "Generating topics..." forever.
 */
export async function markOrphanedFactsAsFailed(
  activeFactIds: Set<string>,
  errorMessage: string,
): Promise<number> {
  const records = await factsCollection.query().fetch();
  const orphaned: FactModel[] = [];
  for (const record of records) {
    if (activeFactIds.has(record.id)) continue;
    const meta = record.metadata;
    const hasTopics = Array.isArray(meta?.topics) && meta!.topics.length > 0;
    const hasError = Array.isArray(meta?.topicGenError) && meta!.topicGenError.length > 0;
    if (hasTopics || hasError) continue;
    orphaned.push(record);
  }
  if (orphaned.length === 0) return 0;

  await database.write(async () => {
    const batch = orphaned.map((record) =>
      record.prepareUpdate((r) => {
        r.metadata = { ...(r.metadata ?? {}), topicGenError: [errorMessage] };
      }),
    );
    await database.batch(batch);
  });
  return orphaned.length;
}

export async function getFacts(): Promise<Fact[]> {
  const records = await factsCollection
    .query(Q.sortBy('created_at', Q.desc))
    .fetch();
  return records.map(toFact);
}

// --- Fact-Topic Links ---

export async function getFactTopicLinks(
  factId?: string,
): Promise<FactTopicLink[]> {
  const query = factId
    ? linksCollection.query(Q.where('fact_id', factId))
    : linksCollection.query();
  const records = await query.fetch();
  return records.map(toFactTopicLink);
}

export async function getFactsForTopicIds(
  topicIds: string[],
): Promise<Fact[]> {
  if (topicIds.length === 0) return [];

  const links = await linksCollection
    .query(Q.where('server_topic_id', Q.oneOf(topicIds)))
    .fetch();
  const factIds = [...new Set(links.map((l) => l.factId))];

  if (factIds.length === 0) return [];

  const records = await factsCollection
    .query(Q.where('id', Q.oneOf(factIds)), Q.sortBy('created_at', Q.desc))
    .fetch();
  return records.map(toFact);
}

/**
 * Replace all fact_topic_links for a given local fact with a fresh set. Used
 * by the topic-gen flow after the server returns the assigned topic ids.
 */
export async function replaceFactTopicLinks(
  factId: string,
  links: Array<{ serverTopicId: string; topicText: string }>,
): Promise<void> {
  const existing = await linksCollection
    .query(Q.where('fact_id', factId))
    .fetch();

  await database.write(async () => {
    const ops: Model[] = [
      ...existing.map((l) => l.prepareDestroyPermanently()),
      ...links.map((link) =>
        linksCollection.prepareCreate((r) => {
          r.factId = factId;
          r.serverTopicId = link.serverTopicId;
          r.topicText = link.topicText;
        }),
      ),
    ];
    if (ops.length > 0) await database.batch(ops);
  });
}

/**
 * Resolves server-side topic IDs associated with a fact.
 * Pure function — no DB access needed.
 */
export function resolveTopicIdsForFact(
  fact: Fact,
  links: FactTopicLink[],
  userTopics: { _id: string; news_topic_text: string }[],
): string[] {
  const fromLinks = links
    .filter((l) => l.factId === fact.id && l.serverTopicId)
    .map((l) => l.serverTopicId);
  if (fromLinks.length > 0) return fromLinks;

  const topics = fact.metadata?.topics ?? [];
  const topicsByText = new Map(
    userTopics.map((i) => [i.news_topic_text, i._id]),
  );
  return topics
    .map((t) => topicsByText.get(t))
    .filter((id): id is string => !!id);
}

// --- Questionnaire Coverage ---

/**
 * Returns the set of questionnaire attribute keys that are covered by existing facts.
 * Each fact stores the full attribute string (e.g., "location: neighborhood/area..."),
 * but we extract just the key (text before the colon) for matching.
 */
export async function getCoveredAttributeKeys(): Promise<Set<string>> {
  const records = await factsCollection
    .query(Q.where('questionnaire_attribute', Q.notEq(null)))
    .fetch();
  const keys = new Set<string>();
  for (const record of records) {
    if (record.questionnaireAttribute) {
      const colonIdx = record.questionnaireAttribute.indexOf(':');
      const key = colonIdx >= 0
        ? record.questionnaireAttribute.substring(0, colonIdx).trim()
        : record.questionnaireAttribute.trim();
      keys.add(key);
    }
  }
  return keys;
}

// --- Key-Value (questionnaire level) ---

export async function getQuestionnaireLevel(): Promise<number> {
  const value = await getSetting('questionnaire_level');
  return value ? parseInt(value, 10) : 1;
}

export async function setQuestionnaireLevel(level: number): Promise<void> {
  const clamped = Math.max(1, Math.min(10, level));
  await setSetting('questionnaire_level', String(clamped));
}
