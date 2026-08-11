// Fact Service — WatermelonDB CRUD for facts.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import logger from '../../logger';
import type FactModel from '../models/Fact';
import type { Fact } from '../../mera-protocol-toolkit/types';

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

/**
 * APPEND topic texts onto a fact's `metadata.topics`, preserving what is there.
 *
 * `Fact.updateFact` assigns `fact.metadata = metadata` — a WHOLESALE REPLACE.
 * That is tolerable for first generation (which owns the whole list), but for an
 * append it is data loss: writing `{ topics: newOnes }` would drop the fact's
 * existing metadata.topics, which the legacy retrieval path still reads on
 * devices that have not run the persona-v3 migration, and would drop any other
 * metadata key (e.g. topicGenError) with it.
 *
 * Reads the current metadata, merges case-insensitively (existing order kept,
 * new texts appended), and writes the whole object back.
 */
export async function appendFactMetadataTopics(
  id: string,
  newTopics: string[],
): Promise<void> {
  if (newTopics.length === 0) return;
  const record = await factsCollection.find(id);
  const current = record.metadata ?? {};
  const existing = Array.isArray(current.topics) ? current.topics : [];

  const seen = new Set(existing.map((t) => t.toLowerCase().trim()));
  const merged = [...existing];
  for (const t of newTopics) {
    const key = t.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(t);
  }
  if (merged.length === existing.length) return; // nothing new

  await record.updateFact(record.statement, { ...current, topics: merged });
}

/**
 * r14 — stamp `metadata.topicsReviewedAt` so the fact's in-chat topic-plan card
 * stays resolved across relaunches (the chat/onboarding gate reads this; the
 * store's settled map is in-memory only). Additive on the existing metadata
 * JSON, so no schema migration is involved.
 *
 * Merges rather than assigns for exactly the reason `appendFactMetadataTopics`
 * documents above: `Fact.updateFact` REPLACES the whole metadata object, so
 * writing `{ topicsReviewedAt: [...] }` alone would drop `topics` (the legacy
 * retrieval path still reads it) and `topicGenError`.
 *
 * Idempotent: re-stamping an already-reviewed fact refreshes the timestamp and
 * is harmless. A missing fact is a no-op, never a throw — the caller is a UI
 * button and the fact may have been deleted from another surface.
 */
export async function markTopicsReviewed(id: string, at: Date = new Date()): Promise<void> {
  let record: FactModel;
  try {
    record = await factsCollection.find(id);
  } catch {
    return;
  }
  const current = record.metadata ?? {};
  await record.updateFact(record.statement, {
    ...current,
    topicsReviewedAt: [at.toISOString()],
  });
}

export async function deleteFact(id: string): Promise<void> {
  const record = await factsCollection.find(id);
  await record.destroyCascade();
  // The cascade takes the fact's topics; the suggestions those topics
  // retrieved must go with them. Without this they linger for the full 48h
  // window as content for a deleted interest — unable to render a Dashboard
  // section (ownership needs the fact) while still counting as "analysed for
  // you". Lazy require: article-suggestion-service imports this module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const topics = require('./topic-service') as typeof import('./topic-service');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const suggestions =
    require('./article-suggestion-service') as typeof import('./article-suggestion-service');
  const purged = await suggestions.purgeSuggestionsForDeadTopics(await topics.getAllTopicIds());
  if (purged > 0) {
    logger.warn('[fact-service] Purged suggestions for deleted fact', { factId: id, purged });
  }
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

/** True when this device holds at least one fact.
 *
 *  This is the onboarding gate. Facts are what the app actually needs to
 *  function (topics, scoring and the whole feed derive from them), whereas the
 *  server's `onboardingStage` lies: the wizard's Next button writes FINISHED
 *  even when the persona chat captured nothing. Counting in SQL via
 *  `fetchCount()` never materialises rows, and it needs no network — the gate
 *  works offline.
 *
 *  Note `facts` is device-global (no user column); callers that may be running
 *  for a freshly signed-in user must run `clearPreviousUserData(userId)` first.
 */
export async function hasAnyFacts(): Promise<boolean> {
  const count = await factsCollection.query().fetchCount();
  return count > 0;
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

