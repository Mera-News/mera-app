// Persona-Summary Service — WatermelonDB adapter for `persona_summary_strings`.
//
// Long-lived, user-owned "About you" strings (schema v38). The generation
// pipeline (lib/inference/handlers/persona-summary-handler.ts) writes them via
// `replaceAllSummaryStrings`; the Profile tab reads/observes them and the
// per-string sheet deletes one via `deleteSummaryString`. English-canonical —
// rendered through TranslatableDynamic.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type PersonaSummaryStringModel from '../models/PersonaSummaryString';
import type { PersonaSummaryStringResult } from '../../news-harness/persona-summary';
import logger from '../../logger';

const collection = database.get<PersonaSummaryStringModel>('persona_summary_strings');

/** Plain read-model row for the UI (JSON columns parsed). */
export interface PersonaSummaryStringRow {
  id: string;
  text: string;
  linkedFactIds: string[];
  linkedTopicIds: string[];
  generatedAt: number;
  personaVersion: string | null;
  stale: boolean;
}

function parseIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function toRow(m: PersonaSummaryStringModel): PersonaSummaryStringRow {
  return {
    id: m.id,
    text: m.text,
    linkedFactIds: parseIds(m.linkedFactIdsJson),
    linkedTopicIds: parseIds(m.linkedTopicIdsJson),
    generatedAt: m.generatedAt instanceof Date ? m.generatedAt.getTime() : Number(m.generatedAt ?? 0),
    personaVersion: m.personaVersion ?? null,
    stale: m.stale ?? false,
  };
}

/** All strings, oldest-first (matches `observeSummaryStrings` order). */
export async function getAllSummaryStrings(): Promise<PersonaSummaryStringRow[]> {
  const rows = await collection.query(Q.sortBy('generated_at', Q.asc)).fetch();
  return rows.map(toRow);
}

/** Live query for the Profile screen — emits on every replaceAll/delete. */
export function observeSummaryStrings() {
  return collection.query(Q.sortBy('generated_at', Q.asc)).observe();
}

export async function countSummaryStrings(): Promise<number> {
  return collection.query().fetchCount();
}

/** The persona fingerprint the current strings were generated for (null when
 *  there are none). Used by the regeneration trigger to skip no-op runs. */
export async function getLatestPersonaVersion(): Promise<string | null> {
  const rows = await collection
    .query(Q.sortBy('generated_at', Q.desc), Q.take(1))
    .fetch();
  return rows[0]?.personaVersion ?? null;
}

/**
 * Atomically replace ALL strings with a freshly generated set, stamping the
 * persona fingerprint they were built from. Old strings render until this
 * commits — there is no intermediate empty state.
 */
export async function replaceAllSummaryStrings(
  results: PersonaSummaryStringResult[],
  personaVersion: string | null,
): Promise<void> {
  await database.write(async () => {
    const existing = await collection.query().fetch();
    const now = new Date();
    const deletes = existing.map((r) => r.prepareDestroyPermanently());
    const creates = results.map((res) =>
      collection.prepareCreate((m) => {
        m.text = res.text;
        m.linkedFactIdsJson = JSON.stringify(res.linkedFactIds);
        m.linkedTopicIdsJson = JSON.stringify(res.linkedTopicIds);
        m.generatedAt = now;
        m.personaVersion = personaVersion;
        m.stale = false;
      }),
    );
    await database.batch([...deletes, ...creates]);
  });
}

/** Mark every string stale (subtle "updating…" hint while a regen is queued). */
export async function markAllStale(): Promise<void> {
  await database.write(async () => {
    const existing = await collection.query(Q.where('stale', Q.notEq(true))).fetch();
    if (existing.length === 0) return;
    const batch = existing.map((r) => r.prepareUpdate((m) => { m.stale = true; }));
    await database.batch(batch);
  });
}

/**
 * Delete one string (its linked facts/topics are removed separately by the
 * caller) and mark the rest stale so the next focus regenerates a clean set.
 */
export async function deleteSummaryString(id: string): Promise<void> {
  try {
    const record = await collection.find(id);
    await database.write(async () => {
      const others = await collection
        .query(Q.where('id', Q.notEq(id)), Q.where('stale', Q.notEq(true)))
        .fetch();
      const batch = [
        record.prepareDestroyPermanently(),
        ...others.map((r) => r.prepareUpdate((m) => { m.stale = true; })),
      ];
      await database.batch(batch);
    });
  } catch (err) {
    logger.warn('[persona-summary] deleteSummaryString failed', { id, error: String(err) });
  }
}
