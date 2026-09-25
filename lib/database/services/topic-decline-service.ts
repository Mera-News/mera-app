// Topic deletion with a short undo, and the declines it leaves behind.
//
// The delete is STAGED, not committed: `deleteTopicWithDecline` sets
// `topics.pending_delete_at` and writes the decline row, and the destroy
// happens later in `flushPendingDeletes`. Staging lives on a COLUMN rather
// than in a module Map because the flush has to run on app start — an
// in-memory registry has nothing to flush there, so a process death inside the
// undo window would silently resurrect a topic the user watched disappear.
//
// The timer below is a convenience, never the guarantee. Correctness comes
// from the column plus three flush entry points: this timer, app start, and
// every app foreground (both scheduled from the `inference-recover` task). If
// the timer never fires, the row is still staged on disk and the next launch
// commits it.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import logger from '../../logger';
import type TopicModel from '../models/Topic';
import type DeclinedTopicModel from '../models/DeclinedTopic';
import type FactModel from '../models/Fact';
import type TrackedStoryModel from '../models/TrackedStory';
import { normalizeTopicText } from './topic-service';

const topicsCollection = database.get<TopicModel>('topics');
const declinedCollection = database.get<DeclinedTopicModel>('declined_topics');

/** Default undo window. */
export const UNDO_WINDOW_MS = 5_000;
/** Accessibility affordance bounds. A value outside these is clamped and
 *  logged, never thrown — this runs in front of the user. The upper bound is
 *  not defensive noise: a staged row is invisible to every render but still
 *  counted by `getAllTopicIds()`, so an absurd window would pin it there. */
export const UNDO_WINDOW_MIN_MS = 1_000;
export const UNDO_WINDOW_MAX_MS = 60_000;

/** Default page size for the agent's prompt context. */
const DECLINED_TEXTS_LIMIT = 50;

export interface StageDeleteResult {
  /** Equals the topicId. Named so the original `{ undoToken }` contract holds;
   *  `undoPendingDelete` accepts either spelling. */
  undoToken: string;
}

/** Per-stage bookkeeping that only matters while this process is alive.
 *  In-memory is correct: if the process dies the undo is unreachable anyway
 *  and the decline is already committed, which is the right outcome. */
interface PendingEntry {
  topicId: string;
  declinedRowId: string;
  /** null ⇒ this stage CREATED the decline row, so undo destroys it.
   *  A number ⇒ the decline already existed and undo restores this timestamp,
   *  rather than deleting a decline the user made weeks ago. */
  previousCreatedAtMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const pending = new Map<string, PendingEntry>();

/** Serialises flushes so the timer and a foreground firing together cannot
 *  double-commit. */
let inFlightFlush: Promise<number> | null = null;

function clampWindow(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return UNDO_WINDOW_MS;
  const clamped = Math.min(UNDO_WINDOW_MAX_MS, Math.max(UNDO_WINDOW_MIN_MS, ms));
  if (clamped !== ms) {
    logger.warn('[topic-decline] undo window clamped', { requested: ms, applied: clamped });
  }
  return clamped;
}

/**
 * Record that the user declined a topic text, whether or not a row ever
 * existed for it.
 *
 * Exposed separately because the agent declines proposals that were never
 * minted. Upserts on `normalized_text`: a re-decline refreshes `created_at`
 * instead of adding a second row.
 *
 * Takes the DISPLAY text and normalises internally — the table stores both,
 * and a caller passing a pre-normalised string would put lowercased,
 * whitespace-collapsed text on the user's "Topics you removed" list.
 *
 * Returns the row id and the previous `created_at` (null when newly created),
 * which is what lets an undo put an older decline back exactly as it was.
 */
export async function recordDecline(
  text: string,
  factId: string | null,
): Promise<{ id: string; previousCreatedAtMs: number | null }> {
  const display = text.trim();
  const normalized = normalizeTopicText(display);
  if (!normalized) throw new Error('recordDecline: empty text');

  const existing = await declinedCollection
    .query(Q.where('normalized_text', normalized))
    .fetch();

  const now = new Date();
  if (existing.length > 0) {
    const row = existing[0];
    const previous = row.createdAt?.getTime() ?? null;
    await database.write(async () => {
      await database.batch([
        row.prepareUpdate((r) => {
          r.createdAt = now;
          if (factId) r.sourceFactId = factId;
        }),
      ]);
    });
    return { id: row.id, previousCreatedAtMs: previous };
  }

  const created = await database.write(async () =>
    declinedCollection.create((r) => {
      r.text = display;
      r.normalizedText = normalized;
      r.sourceFactId = factId;
      r.createdAt = now;
    }),
  );
  return { id: created.id, previousCreatedAtMs: null };
}

/**
 * Stage a topic for deletion and remember the decline.
 *
 * ONE write does both: the row is marked `pending_delete_at` and the decline
 * is recorded. The decline is written HERE, at stage time rather than at
 * commit, to close the re-mint race — without it, deleting a chip and tapping
 * "More topics" inside the undo window regenerates the same topic, because the
 * staged row is invisible to `createTopics`' dedup and a fresh row is minted.
 * With the decline already on disk, generation filters the text out before it
 * ever reaches `createTopics`.
 *
 * The row disappears from `observeByFact` and every other render/retrieve read
 * immediately; the caller holds the chip in its own state for the undo.
 */
export async function deleteTopicWithDecline(
  topicId: string,
  opts?: { undoWindowMs?: number },
): Promise<StageDeleteResult> {
  const topic = await topicsCollection.find(topicId);

  // Recorded before the stage write so an undo can restore an older decline
  // exactly, rather than destroying one the user made weeks ago.
  const decline = await recordDecline(topic.text, topic.factId ?? null);

  await database.write(async () => {
    await database.batch([
      topic.prepareUpdate((t) => {
        t.pendingDeleteAt = Date.now();
        t.updatedAt = new Date();
      }),
    ]);
  });

  const existing = pending.get(topicId);
  if (existing?.timer) clearTimeout(existing.timer);

  const entry: PendingEntry = {
    topicId,
    declinedRowId: decline.id,
    previousCreatedAtMs: existing?.previousCreatedAtMs ?? decline.previousCreatedAtMs,
    timer: null,
  };
  entry.timer = setTimeout(() => {
    void flushPendingDeletes().catch(() => {});
  }, clampWindow(opts?.undoWindowMs));
  pending.set(topicId, entry);

  return { undoToken: topicId };
}

/**
 * Cancel a staged delete: clear the marker and undo the decline.
 *
 * Returns false for an unknown token or one whose delete already committed.
 * Never throws — it is wired to a toast button.
 */
export async function undoPendingDelete(topicId: string): Promise<boolean> {
  try {
    const entry = pending.get(topicId);
    if (entry?.timer) clearTimeout(entry.timer);
    pending.delete(topicId);

    let topic: TopicModel;
    try {
      topic = await topicsCollection.find(topicId);
    } catch {
      return false; // already destroyed by a flush
    }
    if (topic.pendingDeleteAt == null) return false;

    const declineRow = entry
      ? await declinedCollection.find(entry.declinedRowId).catch(() => null)
      : null;

    await database.write(async () => {
      const ops: unknown[] = [
        topic.prepareUpdate((t) => {
          t.pendingDeleteAt = null;
          t.updatedAt = new Date();
        }),
      ];
      if (declineRow) {
        ops.push(
          entry!.previousCreatedAtMs == null
            ? declineRow.prepareDestroyPermanently()
            : declineRow.prepareUpdate((r) => {
                r.createdAt = new Date(entry!.previousCreatedAtMs as number);
              }),
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await database.batch(ops as any);
    });
    return true;
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'topic-decline', method: 'undoPendingDelete' },
      extra: { topicId },
    });
    return false;
  }
}

/**
 * Commit every staged delete. Runs from this module's timer, from app start
 * and from every app foreground — never from a component, so a delete cannot
 * outlive the card that started it.
 *
 * Returns the number of rows committed.
 */
export async function flushPendingDeletes(): Promise<number> {
  if (inFlightFlush) return inFlightFlush;
  inFlightFlush = doFlush().finally(() => {
    inFlightFlush = null;
  });
  return inFlightFlush;
}

async function doFlush(): Promise<number> {
  try {
    const staged = await topicsCollection
      .query(Q.where('pending_delete_at', Q.notEq(null)))
      .fetch();
    if (staged.length === 0) return 0;

    for (const t of staged) {
      const e = pending.get(t.id);
      if (e?.timer) clearTimeout(e.timer);
      pending.delete(t.id);
    }

    // TRACKED-STORY GUARD, applied at commit rather than at stage.
    // `tracked_stories.topic_id` is a real reference: destroying the topic
    // leaves it dangling and that followed story silently stops matching new
    // articles forever, with no error anywhere. Those rows are RETIRED
    // instead. The chip already vanished at stage time, so the user sees no
    // difference, and the decline stands either way.
    const trackedRows = await database
      .get<TrackedStoryModel>('tracked_stories')
      .query(Q.where('topic_id', Q.oneOf(staged.map((t) => t.id))))
      .fetch();
    const guarded = new Set(
      trackedRows.map((r) => (r as unknown as { topicId?: string | null }).topicId ?? '')
        .filter(Boolean),
    );

    const doomed = staged.filter((t) => !guarded.has(t.id));

    // Prune the committed texts from `fact.metadata.topics`, the SECOND topic
    // list the facts screen renders. Without this a deleted chip lives on
    // there forever.
    const prunePerFact = new Map<string, Set<string>>();
    for (const t of doomed) {
      const factId = t.factId ?? null;
      if (!factId) continue;
      const set = prunePerFact.get(factId) ?? new Set<string>();
      set.add(t.normalizedText);
      prunePerFact.set(factId, set);
    }
    const factRows: FactModel[] =
      prunePerFact.size > 0
        ? await database
            .get<FactModel>('facts')
            .query(Q.where('id', Q.oneOf([...prunePerFact.keys()])))
            .fetch()
        : [];

    await database.write(async () => {
      const now = new Date();
      const factUpdates = factRows
        .map((fact) => {
          const current = fact.metadata ?? {};
          const existingTexts = Array.isArray(current.topics) ? current.topics : [];
          const drop = prunePerFact.get(fact.id) ?? new Set<string>();
          const kept = existingTexts.filter((t) => !drop.has(normalizeTopicText(t)));
          if (kept.length === existingTexts.length) return null;
          return fact.prepareUpdate((f) => {
            // Spread `current`: assigning `{ topics }` alone would drop
            // topicGenError and topicsReviewedAt.
            f.metadata = { ...current, topics: kept };
            f.updatedAt = now;
          });
        })
        .filter((u): u is NonNullable<typeof u> => u !== null);

      await database.batch([
        ...doomed.map((t) => t.prepareDestroyPermanently()),
        ...staged
          .filter((t) => guarded.has(t.id))
          .map((t) =>
            t.prepareUpdate((row) => {
              row.pendingDeleteAt = null;
              row.status = 'retired';
              row.updatedAt = now;
            }),
          ),
        ...factUpdates,
      ]);
    });

    // A destroyed topic changes what `getAllTopicIds()` returns, which a
    // RETIRE never did — so suggestions whose only topic evidence was this
    // topic are now unrenderable dead weight. Mirrors what `deleteFact` does
    // after a cascade. Runs only at commit, which is what keeps an undo from
    // having to resurrect suggestions.
    if (doomed.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const topics = require('./topic-service') as typeof import('./topic-service');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const suggestions =
        require('./article-suggestion-service') as typeof import('./article-suggestion-service');
      const purged = await suggestions.purgeSuggestionsForDeadTopics(
        await topics.getAllTopicIds(),
      );
      if (purged > 0) {
        logger.warn('[topic-decline] Purged suggestions for deleted topics', { purged });
      }
    }

    return staged.length;
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'topic-decline', method: 'flushPendingDeletes' },
    });
    return 0;
  }
}

/** Declined topic texts, newest first — the agent's prompt context.
 *  Returns the NORMALISED form, which is what generation filters against. */
export async function getDeclinedTopicTexts(
  limit: number = DECLINED_TEXTS_LIMIT,
): Promise<string[]> {
  const rows = await declinedCollection
    .query(Q.sortBy('created_at', Q.desc), Q.take(limit))
    .fetch();
  return rows.map((r) => r.normalizedText);
}

/**
 * EVERY declined normalized text, with no page limit — the veto set for
 * anything that mints topics unattended (the combination pass, and isolated
 * generation's exclusions). `getDeclinedTopicTexts` is a 50-row PROMPT page;
 * vetoing against it lets the 51st-oldest decline come back.
 */
export async function getAllDeclinedNormalizedTexts(): Promise<Set<string>> {
  const rows = await declinedCollection.query().fetch();
  return new Set(rows.map((r) => r.normalizedText));
}

/** Live "Topics you removed" list, newest first. A plain `observe()` is right:
 *  rows are only created and destroyed, never edited in a way the list shows. */
export function listDeclinedTopics() {
  return declinedCollection.query(Q.sortBy('created_at', Q.desc)).observe();
}

/**
 * Forget one decline.
 *
 * This does NOT bring the topic back — that row was destroyed when the delete
 * committed. It stops the decline suppressing future proposals, so the agent
 * may offer the interest again. Callers wanting the chip back immediately
 * should mint it via `createTopics({ factId, text })`; the row carries both.
 */
export async function removeDecline(id: string): Promise<void> {
  let row: DeclinedTopicModel;
  try {
    row = await declinedCollection.find(id);
  } catch {
    return; // already gone — a double tap, not an error
  }
  await database.write(async () => {
    await database.batch([row.prepareDestroyPermanently()]);
  });
}

/** Test seam: drop in-memory undo bookkeeping without touching the database. */
export function __resetPendingForTests(): void {
  for (const e of pending.values()) if (e.timer) clearTimeout(e.timer);
  pending.clear();
  inFlightFlush = null;
}
