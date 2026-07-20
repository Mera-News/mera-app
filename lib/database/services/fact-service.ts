// Fact Service — WatermelonDB CRUD for facts.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type FactModel from '../models/Fact';
import type { Fact } from '../../mera-protocol-toolkit/types';
import { getSetting, setSetting } from './setting-service';

const factsCollection = database.get<FactModel>('facts');

// --- Helpers ---

function toFact(record: FactModel): Fact {
  return {
    id: record.id,
    statement: record.statement,
    weight: record.weight ?? null,
    metadata: record.metadata,
    questionnaireLevel: record.questionnaireLevel ?? undefined,
    questionnaireLevelCategory: record.questionnaireLevelCategory ?? undefined,
    questionnaireAttribute: record.questionnaireAttribute ?? undefined,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
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

/** Persona-v3 fact snapshot for the fact-sectioned feed selector: carries the
 *  fact-level `weight` and `metadata_json.section_title` that the public `Fact`
 *  DTO drops. `sectionTitle` is null until the (deferred) title-generation
 *  piggyback lands — callers fall back to the statement. */
export interface FactSectionSnapshot {
  id: string;
  weight: number | null;
  createdAtMs: number;
  statement: string;
  sectionTitle: string | null;
}

export async function getFactSectionSnapshots(): Promise<FactSectionSnapshot[]> {
  const records = await factsCollection.query().fetch();
  return records.map((r) => {
    // metadata is Record<string, string[]>; section_title (when generated) is a
    // single-element string list. Defensive extraction — absent today.
    const rawTitle = (r.metadata as Record<string, unknown> | undefined)?.section_title;
    let sectionTitle: string | null = null;
    if (Array.isArray(rawTitle) && typeof rawTitle[0] === 'string' && rawTitle[0].trim()) {
      sectionTitle = rawTitle[0].trim();
    } else if (typeof rawTitle === 'string' && rawTitle.trim()) {
      sectionTitle = rawTitle.trim();
    }
    return {
      id: r.id,
      weight: r.weight ?? null,
      createdAtMs: r.createdAt?.getTime?.() ?? 0,
      statement: r.statement,
      sectionTitle,
    };
  });
}

export async function getFacts(): Promise<Fact[]> {
  const records = await factsCollection
    .query(Q.sortBy('created_at', Q.desc))
    .fetch();
  return records.map(toFact);
}

/** Returns facts that have at least one of the given topic texts in their metadata.topics. */
export async function getFactsForTopicTexts(topicTexts: string[]): Promise<Fact[]> {
  if (topicTexts.length === 0) return [];
  const topicSet = new Set(topicTexts);
  const facts = await getFacts();
  return facts.filter((f) =>
    f.metadata?.topics?.some((t) => topicSet.has(t)) ?? false,
  );
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
