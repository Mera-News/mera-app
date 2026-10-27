// Fact Service — WatermelonDB CRUD for facts.

import { Q } from '@nozbe/watermelondb';
import type { Observable } from 'rxjs';
import { map, distinctUntilChanged } from 'rxjs/operators';
import database from '../index';
import logger from '../../logger';
import type FactModel from '../models/Fact';
import type { FactTopicsStatus } from '../models/Fact';
import type TopicModel from '../models/Topic';
import type { Fact } from '../../mera-protocol-toolkit/types';
import { ACTION_NAMES } from '../../news-harness/persona-management/action-names';
import {
  RESIDENCE_ROLES,
  factPlaces,
  factPlacesBy,
  normalizePlaces,
  parsePlace,
  placesSourceHash,
  type PlacesBy,
} from '../../news-harness/persona-management/fact-places';

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
    topicsStatus: record.topicsStatus ?? null,
    topicsUpdatedAt: record.topicsUpdatedAt?.toISOString() ?? null,
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
  /** `topicsStatus` defaults to leaving the column NULL, NOT to 'pending'. A
   *  fact created without an enqueue would otherwise sit at pending until the
   *  rescue sweep turned it into a visible error the user never caused. Pass
   *  `{ topicsStatus: 'pending' }` from a path that IS enqueuing generation. */
  opts?: { topicsStatus?: FactTopicsStatus },
): Promise<Fact> {
  const record = await database.write(async () => {
    return factsCollection.create((fact) => {
      fact.statement = statement;
      if (opts?.topicsStatus) {
        fact.topicsStatus = opts.topicsStatus;
        fact.topicsUpdatedAt = new Date();
      }
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
 * Reads the current metadata, merges on normalizeTopicText (existing order kept,
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

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { normalizeTopicText } = require('./topic-service') as typeof import('./topic-service');
  const seen = new Set(existing.map(normalizeTopicText));
  const merged = [...existing];
  for (const t of newTopics) {
    const key = normalizeTopicText(t);
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
  // you". Lazy require: article-suggestion-lifecycle imports this module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const topics = require('./topic-service') as typeof import('./topic-service');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const suggestions =
    require('./article-suggestion-lifecycle') as typeof import('./article-suggestion-lifecycle');
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
  const now = Date.now();
  const orphaned: FactModel[] = [];
  /** Stale 'pending' that DOES own topics: `completeTopicGeneration` minted
   *  and died before it stamped. Heal to 'done' rather than escalating a
   *  cosmetic spinner into a user-visible error. */
  const healed: FactModel[] = [];

  for (const record of records) {
    // A QUEUED job counts as active (inference-job-service matches
    // ['pending','running']), so a fact waiting behind the queue is never
    // stamped. Note the two vocabularies: a JOB's 'pending' means "queued,
    // not started"; a FACT's topics_status 'pending' means "a run was
    // enqueued for me". They are unrelated.
    if (activeFactIds.has(record.id)) continue;

    const meta = record.metadata;
    const hasTopics = Array.isArray(meta?.topics) && meta!.topics.length > 0;
    const hasError = Array.isArray(meta?.topicGenError) && meta!.topicGenError.length > 0;

    if (record.topicsStatus === 'pending') {
      // A floor is required: without it a fact enqueued milliseconds before a
      // foreground loses the race between the enqueue write and this read.
      const stampedMs = record.topicsUpdatedAt?.getTime() ?? 0;
      if (now - stampedMs <= PENDING_TOPICS_STALE_MS) continue;
      if (hasTopics) healed.push(record);
      else orphaned.push(record);
      continue;
    }

    // Legacy predicate, for rows written before v55 and for the metadata-only
    // path: no topics, no error marker, no live job.
    if (hasTopics || hasError) continue;
    orphaned.push(record);
  }

  if (orphaned.length === 0 && healed.length === 0) return 0;

  await database.write(async () => {
    const stamp = new Date();
    await database.batch([
      ...orphaned.map((record) =>
        record.prepareUpdate((r) => {
          // Both the new column AND the legacy marker: TopicPlanCard and
          // tool-handlers still read `metadata.topicGenError` and are not
          // this area's to change.
          r.topicsStatus = 'error';
          r.topicsUpdatedAt = stamp;
          r.metadata = { ...(r.metadata ?? {}), topicGenError: [errorMessage] };
        }),
      ),
      ...healed.map((record) =>
        record.prepareUpdate((r) => {
          r.topicsStatus = 'done';
          r.topicsUpdatedAt = stamp;
        }),
      ),
    ]);
  });
  return orphaned.length + healed.length;
}

/**
 * How long a fact may sit at 'pending' with no live job before the sweep
 * calls it dead.
 */
export const PENDING_TOPICS_STALE_MS = 10 * 60 * 1000;

/**
 * Rescue facts stuck at 'pending' whose generation job is gone.
 *
 * Runs from the `inference-recover` scheduler task, which is db-ready gated
 * and fires on every app foreground. That matters because the other caller of
 * `markOrphanedFactsAsFailed` — `InferenceQueue.start()` — is NOT a reliable
 * cold-start hook: it is reached from useModelLifecycle, and in on-device mode
 * it waits for `modelState === 'ready'`, so a device whose model never loads
 * would never sweep. (Cloud mode is fine: `shouldRun` is unconditionally true
 * there.) Going through the scheduler covers both.
 */
export async function rescueStalePendingTopicFacts(): Promise<number> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jobs = require('./inference-job-service') as typeof import('./inference-job-service');
    const activeFactIds = await jobs.getActiveTopicGenFactIds();
    return await markOrphanedFactsAsFailed(
      activeFactIds,
      'Topic generation failed — please delete and retry.',
    );
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'fact-service', method: 'rescueStalePendingTopicFacts' },
    });
    return 0;
  }
}

/** Facts stamped 'pending', oldest stamp first. */
export async function getPendingTopicFactIds(): Promise<string[]> {
  const rows = await factsCollection
    .query(Q.where('topics_status', 'pending'), Q.sortBy('topics_updated_at', Q.asc))
    .fetch();
  return rows.map((r) => r.id);
}

/**
 * Facts the v55 migration left with no status — generation was never asked
 * for. Offered so topic generation can opt them in at runtime, which is where
 * the decision about billing and cadence belongs; the migration deliberately
 * does not make it.
 */
export async function getFactIdsWithoutTopicStatus(): Promise<string[]> {
  const rows = await factsCollection.query(Q.where('topics_status', null)).fetch();
  return rows.map((r) => r.id);
}

/** One fact's stored status, or null when it has none / does not exist. */
export async function getTopicsStatus(id: string): Promise<FactTopicsStatus | null> {
  try {
    const record = await factsCollection.find(id);
    return record.topicsStatus ?? null;
  } catch {
    return null;
  }
}

/** Columns the `Fact` DTO is built from. `topics_status` is named EXPLICITLY
 *  rather than leaning on `updated_at` as a catch-all: a status-only write
 *  re-emitting is the entire point of these observables. */
const DTO_COLUMNS = [
  'statement',
  'metadata_json',
  'weight',
  'questionnaire_level',
  'questionnaire_level_category',
  'questionnaire_attribute',
  'topics_status',
  'topics_updated_at',
  'updated_at',
];

/**
 * Every fact, live, newest first.
 *
 * Replaces the one-shot `getFacts()` the facts list re-ran off a mutation
 * counter. `observeWithColumns`, not a bare `observe()`: the latter emits only
 * when query MEMBERSHIP changes, so an in-place status write would be silent
 * and the card would look dead.
 */
export function observeFacts(): Observable<Fact[]> {
  return factsCollection
    .query(Q.sortBy('created_at', Q.desc))
    .observeWithColumns(DTO_COLUMNS)
    .pipe(map((records) => records.map(toFact)));
}

/** One fact, live. Emits null once the fact is gone — query-based rather than
 *  `findAndObserve`, which ERRORS the subscription on a destroyed record. */
export function observeFact(id: string): Observable<Fact | null> {
  return factsCollection
    .query(Q.where('id', id))
    .observeWithColumns(DTO_COLUMNS)
    .pipe(map((records) => (records.length > 0 ? toFact(records[0]) : null)));
}

/**
 * Topic-generation progress for one fact, as a VIEW state.
 *
 * `'gone'` is not a stored value: it is emitted when the fact row no longer
 * exists, which a scrolled-back accordion can outlive after a discard
 * cascade. The stream NEVER completes on a missing fact — a completing
 * observable leaves the card frozen on its last frame, which is exactly the
 * stale spinner this column exists to kill.
 *
 * A NULL status on a LIVE fact emits 'done', the documented fallback for
 * "generation was never asked for", so callers never branch on null.
 */
export function observeTopicsStatus(
  factId: string,
): Observable<'pending' | 'done' | 'error' | 'gone'> {
  return factsCollection
    .query(Q.where('id', factId))
    .observeWithColumns(['topics_status', 'topics_updated_at'])
    .pipe(
      map((records) => {
        if (records.length === 0) return 'gone' as const;
        return records[0].topicsStatus ?? ('done' as const);
      }),
      distinctUntilChanged(),
    );
}

export interface NewFactInput {
  statement: string;
  metadata?: Record<string, string[]>;
  questionnaire?: { level?: number; levelCategory?: string; attribute?: string };
  /** Defaults to 'pending' here, unlike `addFact`: a replacement fact needs
   *  new topics by construction, since the old fact's are destroyed in the
   *  same batch. */
  topicsStatus?: FactTopicsStatus;
}

/**
 * Accept a proposal carrying `replaces: factId`.
 *
 * ONE WatermelonDB write: the old fact and every topic it owned are destroyed
 * and the new fact is created in a single atomic batch, so a kill mid-write
 * yields both or neither — never a user left with the old fact gone and
 * nothing in its place.
 *
 * Does NOT call `Fact.destroyCascade()`: that is a @writer and opens its own
 * transaction, which cannot nest inside this one. The cascade's semantics are
 * reproduced inline instead; `destroyCascade` is unchanged and stays the path
 * for a plain delete.
 *
 * A missing `oldId` is not a throw — the caller is an LLM-driven path and a
 * stale `replaces` id is a realistic input, so the new fact is created anyway
 * and the miss is logged.
 */
export async function replaceFact(oldId: string, input: NewFactInput): Promise<Fact> {
  let oldRecord: FactModel | null = null;
  try {
    oldRecord = await factsCollection.find(oldId);
  } catch {
    logger.warn('[fact-service] replaceFact: old fact missing, creating anyway', { oldId });
  }

  const oldTopics = oldRecord
    ? await database.get<TopicModel>('topics').query(Q.where('fact_id', oldId)).fetch()
    : [];

  const created = await database.write(async () => {
    const now = new Date();
    const fresh = factsCollection.prepareCreate((fact) => {
      fact.statement = input.statement;
      if (input.metadata) fact.metadata = input.metadata;
      if (input.questionnaire) {
        if (input.questionnaire.level !== undefined)
          fact.questionnaireLevel = input.questionnaire.level;
        if (input.questionnaire.levelCategory !== undefined)
          fact.questionnaireLevelCategory = input.questionnaire.levelCategory;
        if (input.questionnaire.attribute !== undefined)
          fact.questionnaireAttribute = input.questionnaire.attribute;
      }
      fact.topicsStatus = input.topicsStatus ?? 'pending';
      fact.topicsUpdatedAt = now;
    });

    await database.batch([
      ...(oldRecord ? [oldRecord.prepareDestroyPermanently()] : []),
      ...oldTopics.map((t) => t.prepareDestroyPermanently()),
      fresh,
    ]);
    return fresh;
  });

  // Same ordering as deleteFact: the cascade takes the old fact's topics, so
  // the suggestions those topics retrieved must go with them, or they linger
  // for the full 48h window as content for an interest that no longer exists.
  // Lazy require — article-suggestion-lifecycle imports this module.
  if (oldTopics.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const topics = require('./topic-service') as typeof import('./topic-service');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const suggestions =
      require('./article-suggestion-lifecycle') as typeof import('./article-suggestion-lifecycle');
    const purged = await suggestions.purgeSuggestionsForDeadTopics(await topics.getAllTopicIds());
    if (purged > 0) {
      logger.warn('[fact-service] Purged suggestions for replaced fact', { oldId, purged });
    }
  }

  return toFact(created);
}

/**
 * REMOVE topic texts from a fact's `metadata.topics` — the mirror of
 * `appendFactMetadataTopics`, and the prune half of the two-reader pairing
 * (`FactAccordion` renders this list, the chat card renders the `topics`
 * table).
 *
 * Merges and rewrites the whole metadata object for the reason the append
 * documents: `Fact.updateFact` REPLACES `metadata` wholesale, so writing
 * `{ topics: kept }` alone would drop `topicGenError` and `topicsReviewedAt`.
 *
 * Matches on `normalizeTopicText`, the key the topics table dedups on, so the
 * two halves of the pairing decide with the same key.
 */
export async function removeFactMetadataTopics(
  id: string,
  normalizedTexts: Iterable<string>,
): Promise<void> {
  const drop = new Set(normalizedTexts);
  if (drop.size === 0) return;
  let record: FactModel;
  try {
    record = await factsCollection.find(id);
  } catch {
    return;
  }
  const current = record.metadata ?? {};
  const existing = Array.isArray(current.topics) ? current.topics : [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { normalizeTopicText } = require('./topic-service') as typeof import('./topic-service');
  const kept = existing.filter((t) => !drop.has(normalizeTopicText(t)));
  if (kept.length === existing.length) return;
  await record.updateFact(record.statement, { ...current, topics: kept });
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


// --- Fact places (fbx P1) ---
//
// All metadata writes below read and merge INSIDE one database.write: `updateFact`
// replaces `metadata` wholesale and would drop `topics`.

type LooseMetadata = Record<string, unknown>;

/** Merge into one fact's metadata in a single write; `undefined` deletes a key. Returns the metadata BEFORE. */
async function patchMetadata(factId: string, patch: LooseMetadata): Promise<LooseMetadata | null> {
  return database.write(async () => {
    let record: FactModel;
    try {
      record = await factsCollection.find(factId);
    } catch {
      return null;
    }
    const before = { ...((record.metadata ?? {}) as LooseMetadata) };
    const next: LooseMetadata = { ...before, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    await record.update((f) => {
      f.metadata = next as Record<string, string[]>;
      f.updatedAt = new Date();
    });
    return before;
  });
}

/** A place's coverage key: the country (any depth), the bloc, or GLOBAL. */
function coverageKeys(places: readonly string[]): string {
  // shortcut: a bloc is its own key, not expanded to member countries; upgrade if bloc to country moves must not regenerate.
  const keys = places.map((p) => {
    const parsed = parsePlace(p);
    return parsed?.country ?? parsed?.bloc ?? 'GLOBAL';
  });
  return [...new Set(keys)].sort().join(',');
}

async function residenceReaderPlaces() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAll } = require('./location-service') as typeof import('./location-service');
  const rows = await getAll();
  return rows
    .filter((l) => RESIDENCE_ROLES.has(l.role))
    .map((l) => ({ countryCode: l.countryCode, region: l.region, city: l.city, role: l.role as string }));
}

let warnedNoRescore = false;
async function rescoreLocationCaught(factId: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@/lib/mera-protocol/stage-scoring') as { rescoreLocationCaught?: (id: string) => Promise<unknown> };
    if (typeof mod.rescoreLocationCaught === 'function') await mod.rescoreLocationCaught(factId);
    else if (!warnedNoRescore) {
      warnedNoRescore = true;
      logger.warn('[fact-places] rescoreLocationCaught is not exported yet; skipping');
    }
  } catch (error) {
    logger.warn('[fact-places] rescoreLocationCaught failed', { factId, error: String(error) });
  }
}

async function regenerate(factId: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { regenerateTopicsForFact } = require('./topic-replacement-service') as typeof import('./topic-replacement-service');
    await regenerateTopicsForFact(factId);
  } catch (error) {
    logger.warn('[fact-places] topic regeneration failed', { factId, error: String(error) });
  }
}

const LOG_SOURCE = { sweep: 'llm', user: 'user', chat: 'chat' } as const;

/**
 * Set where a fact's news comes from. Always refreshes `places_source`; an equal
 * place set writes nothing else. A sweep never overwrites a user's choice.
 */
export async function setFactPlaces(
  factId: string,
  places: readonly string[],
  by: PlacesBy,
  opts?: { regenerate?: boolean },
): Promise<{ applied: boolean; changeLogId?: string }> {
  const next = normalizePlaces(places);
  let record: FactModel;
  try {
    record = await factsCollection.find(factId);
  } catch {
    return { applied: false };
  }
  const source = placesSourceHash(record.statement, await residenceReaderPlaces());
  const current = { metadata: record.metadata as LooseMetadata | undefined, statement: record.statement };
  const prevPlaces = factPlaces(current);
  const prevBy = factPlacesBy(current);
  if (by === 'sweep' && prevBy === 'user') return { applied: false };

  const same = prevPlaces.length === next.length && prevPlaces.every((p) => next.includes(p));
  if (same) {
    if (current.metadata?.places_source !== source) await patchMetadata(factId, { places_source: source });
    return { applied: false };
  }

  const before = await patchMetadata(factId, {
    places: next,
    places_by: by,
    places_source: source,
    places_wrong: undefined,
  });
  if (!before) return { applied: false };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const changeLog = require('./persona-change-log-service') as typeof import('./persona-change-log-service');
  const row = await changeLog.append({
    actionType: ACTION_NAMES.SET_FACT_PLACES,
    action: {
      targetId: factId,
      before: { places: prevPlaces, by: prevBy, source: (before.places_source as string | undefined) ?? null },
      after: { places: next, by },
    },
    source: LOG_SOURCE[by],
    summary: 'Set where a fact\'s news comes from',
  });

  await rescoreLocationCaught(factId);
  if (opts?.regenerate !== false && coverageKeys(prevPlaces) !== coverageKeys(next)) await regenerate(factId);
  return { applied: true, changeLogId: row.id };
}

/** Undo of set_fact_places: put places, places_by and places_source back, then regenerate. */
export async function restoreFactPlaces(
  factId: string,
  before: { places: string[]; by: PlacesBy | null; source: string | null },
  expectedNow: readonly string[],
): Promise<boolean> {
  const record = await factsCollection.find(factId);
  const now = factPlaces({ statement: record.statement, metadata: record.metadata as LooseMetadata });
  // Compare-and-set: a newer places write owns the value.
  if (now.length !== expectedNow.length || !now.every((p) => expectedNow.includes(p))) return false;
  await patchMetadata(factId, {
    places: before.places.length > 0 ? before.places : undefined,
    places_by: before.by ?? undefined,
    places_source: before.source ?? undefined,
    places_wrong: undefined,
  });
  await rescoreLocationCaught(factId);
  await regenerate(factId);
  return true;
}

/** The sweep's answer was wrong for this fact: flag it and force a re-decide. A user's choice stays. */
export async function markFactPlacesWrong(factId: string): Promise<boolean> {
  let record: FactModel;
  try {
    record = await factsCollection.find(factId);
  } catch {
    return false;
  }
  if (factPlacesBy({ statement: record.statement, metadata: record.metadata as LooseMetadata }) === 'user') return false;
  await patchMetadata(factId, { places_wrong: true, places_source: undefined });
  return true;
}

/** Stamp the places the fact's current topics were generated for. */
export async function stampPlacesTopicsFor(factId: string, places: readonly string[]): Promise<void> {
  await patchMetadata(factId, { places_topics_for: [...places] });
}

export async function setFactNewsStopped(factId: string, stopped: boolean): Promise<void> {
  await patchMetadata(factId, { news_stopped: stopped ? true : undefined });
}

export function isNewsStopped(fact: { metadata?: Record<string, unknown> | null }): boolean {
  return fact.metadata?.news_stopped === true;
}

/** Retire the fact's active non-tracked topics (one logged, undoable retire_topic row each), then flag the fact. */
export async function stopNewsForFact(factId: string): Promise<{ changeLogIds: string[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const topicService = require('./topic-service') as typeof import('./topic-service');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const changeLog = require('./persona-change-log-service') as typeof import('./persona-change-log-service');
  const changeLogIds: string[] = [];
  const topics = (await topicService.getByFact(factId)).filter((t) => t.status === 'active' && t.provenance !== 'tracked');
  for (const t of topics) {
    await topicService.retire(t.id);
    const row = await changeLog.append({
      actionType: ACTION_NAMES.RETIRE_TOPIC,
      action: { targetId: t.id },
      source: 'user',
      summary: 'Retired topic',
    });
    changeLogIds.push(row.id);
  }
  await setFactNewsStopped(factId, true);
  const row = await changeLog.append({
    actionType: ACTION_NAMES.SET_FACT_NEWS_STOPPED,
    action: { targetId: factId, before: false, after: true },
    source: 'user',
    summary: 'Stopped news for a fact',
  });
  changeLogIds.push(row.id);
  return { changeLogIds };
}
