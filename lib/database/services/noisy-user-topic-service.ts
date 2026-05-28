// Noisy User Topic Service — local-only registry of decoy topic server-ids.
// Used by `persistAndLinkNewSuggestions` to drop article_suggestions whose
// userTopicIds match ONLY noise (mixed real+noise clusters are kept).

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type NoisyUserTopicModel from '../models/NoisyUserTopic';

const noisyUserTopicsCol = database.get<NoisyUserTopicModel>('noisy_user_topics');

export interface NoisyTopicInsert {
  serverTopicId: string;
  newsTopicText: string;
  /** Local fact id that spawned this decoy. Required for lifecycle cascade. */
  factId: string;
  parentTopicText?: string | null;
}

/** Returns the set of every noisy server topic id currently on-device. */
export async function getNoisyTopicIds(): Promise<Set<string>> {
  const rows = await noisyUserTopicsCol.query().fetch();
  return new Set(rows.map((r) => r.serverId));
}

/** Returns the noisy server topic ids spawned by a single fact. Used by the
 *  Persona-tab "Noise" switch to merge noisy rows into the fact dropdown, and
 *  by the fact-delete flow to compute exclusive withdrawal ids. */
export async function getNoisyTopicIdsForFact(factId: string): Promise<string[]> {
  const rows = await noisyUserTopicsCol
    .query(Q.where('fact_id', factId))
    .fetch();
  return rows.map((r) => r.serverId);
}

/** Returns all (factId, serverTopicId) pairs — used by the Persona-tab
 *  selector to render noisy topics under each fact in one O(N) pass. */
export async function getAllNoisyLinks(): Promise<
  { factId: string; serverTopicId: string; newsTopicText: string }[]
> {
  const rows = await noisyUserTopicsCol.query().fetch();
  return rows
    .filter((r) => r.factId)
    .map((r) => ({
      factId: r.factId as string,
      serverTopicId: r.serverId,
      newsTopicText: r.newsTopicText,
    }));
}

/**
 * Random sample of decoy topic texts on-device, deduped (case-insensitive).
 * Fed into the noise prompt as "Prior decoy topics" — a small varying set so
 * each noise call sees a different cross-section of the fake persona's
 * topic surface and doesn't pattern-match the same anchors every time.
 */
export async function getRandomNoisyTopicTexts(count: number): Promise<string[]> {
  if (count <= 0) return [];
  const rows = await noisyUserTopicsCol.query().fetch();
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const r of rows) {
    const key = r.newsTopicText.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pool.push(r.newsTopicText);
  }
  // Fisher-Yates shuffle, take the first `count`.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/**
 * Distinct decoy persona-facts currently on-device, newest-first, optional cap.
 * Read from each noisy row's `parent_topic_text`. Currently unused by the
 * noise prompt (we now feed a random topic sample instead) but kept for
 * future persona-coherence experiments.
 */
export async function getAllNoisyDecoyFacts(limit?: number): Promise<string[]> {
  const rows = await noisyUserTopicsCol
    .query(Q.sortBy('created_at', Q.desc))
    .fetch();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const text = r.parentTopicText;
    if (!text) continue;
    const trimmed = text.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (limit && out.length >= limit) break;
  }
  return out;
}

/**
 * Load every decoy-topic text on-device, optionally capped. Used by the
 * persona-tab debug surface — NOT by the noise prompt anymore (we now carry
 * prior decoy *facts* instead, see `getAllNoisyDecoyFacts`).
 */
export async function getAllNoisyTopicTexts(limit?: number): Promise<string[]> {
  const rows = await noisyUserTopicsCol
    .query(Q.sortBy('created_at', Q.desc), ...(limit ? [Q.take(limit)] : []))
    .fetch();
  // De-dupe (case-insensitive) — the same decoy text may appear under
  // multiple facts.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const key = r.newsTopicText.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r.newsTopicText);
  }
  return out;
}

/** Insert a batch of (serverTopicId, factId, text) tuples, deduping against
 *  existing rows. */
export async function insertNoisyTopics(
  userPersonaId: string,
  entries: NoisyTopicInsert[],
): Promise<number> {
  if (entries.length === 0) return 0;

  const incomingIds = entries.map((e) => e.serverTopicId);
  const existing = await noisyUserTopicsCol
    .query(Q.where('server_id', Q.oneOf(incomingIds)))
    .fetch();
  const existingIds = new Set(existing.map((r) => r.serverId));
  const toInsert = entries.filter((e) => !existingIds.has(e.serverTopicId));
  if (toInsert.length === 0) return 0;

  const now = new Date();
  await database.write(async () => {
    const ops = toInsert.map((e) =>
      noisyUserTopicsCol.prepareCreate((r) => {
        r.serverId = e.serverTopicId;
        r.userPersonaId = userPersonaId;
        r.factId = e.factId;
        r.newsTopicText = e.newsTopicText;
        r.parentTopicText = e.parentTopicText ?? null;
        r.createdAt = now;
      }),
    );
    await database.batch(...ops);
  });
  return toInsert.length;
}

/** Clear every noisy topic row for a persona (used on logout / persona reset). */
export async function clearNoisyTopicsForPersona(
  userPersonaId: string,
): Promise<number> {
  const rows = await noisyUserTopicsCol
    .query(Q.where('user_persona_id', userPersonaId))
    .fetch();
  if (rows.length === 0) return 0;
  await database.write(async () => {
    await database.batch(...rows.map((r) => r.prepareDestroyPermanently()));
  });
  return rows.length;
}
