// Topic Sanity Service — RN adapter for the LLM topic-sanity audit (r12 K-P3).
//
// Asks whether each already-minted topic genuinely belongs to the fact that owns
// it, so the combo-prompt contamination ("Amsterdam cricket festival music
// tech") is cleaned up and not merely prevented going forward. Verdicts become
// `incoherent_topics` hygiene proposals — one per FACT — which the user accepts
// or dismisses in the existing review sheet. Nothing here mutates a topic.
//
// All decidable logic (selection, batching, prompt rendering, verdict decoding)
// is pure and lives in lib/news-harness/persona-management/topic-sanity.ts. This
// file supplies live rows, applies the exclusions that need the database, issues
// the batch call, and advances the cursor.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type TopicModel from '../models/Topic';
import type TrackedStoryModel from '../models/TrackedStory';
import logger from '../../logger';
import { cloudBatchComplete } from '../../llm/cloudComplete';
import { isOnDeviceMode } from '../../llm/on-device-gate';
import { appHarnessLogger } from '@/lib/news-harness-app/logger-adapter';
import {
  planSanityBatches,
  decodeSanityVerdicts,
  type SanityTopicInput,
  type SanityFactInput,
} from '../../news-harness/persona-management/topic-sanity';
import type { HygieneIncoherentFactInput } from '../../news-harness/persona-management/fact-hygiene';
import { getSetting, setSetting } from './setting-service';

const topicsCollection = database.get<TopicModel>('topics');
const trackedStoriesCollection = database.get<TrackedStoryModel>('tracked_stories');

/** Monotonic audit cursor (epoch ms). A topic's `created_at` is stamped at mint
 *  and its text never changes, so nothing can appear BEHIND the cursor — this is
 *  equivalent to a per-row "audited" flag for every row not yet seen, with no
 *  schema change. Resetting it to 0 re-audits the whole corpus (K-P5). */
const CURSOR_KEY = 'sanity_audited_through_ms';

/** Consecutive runs that had a failed prompt and could not move the cursor.
 *  Stored beside the cursor; any forward move resets it. */
const STALL_KEY = 'sanity_cursor_stall_count';

/** A prompt the model refuses every time holds the cursor just below its
 *  topics. After this many stalled runs the audit gives up on those topics and
 *  moves past them, so one refusing prompt cannot pin the pass forever. */
const SANITY_STALL_LIMIT = 3;

/**
 * Provenances the audit will never judge.
 *  - `tracked`  — backs a followed story; Area I is about to make it
 *                 billing-relevant (quota-exempt hydration), so retiring one
 *                 would both break the follow and change how it is charged.
 *  - `user`     — the user typed it. Mera does not second-guess that.
 */
const EXCLUDED_PROVENANCE = new Set(['tracked', 'user']);

export interface SanityAuditResult {
  /** Per-fact verdicts, ready to hand to `analyzeHygiene`. */
  incoherentFacts: HygieneIncoherentFactInput[];
  /** Topics actually judged this run (for logging / tests). */
  audited: number;
  /**
   * The audit did not run because the device has no E2EE credential, NOT
   * because it ran and found nothing.
   *
   * The distinction is load-bearing and cannot be recovered from
   * `incoherentFacts.length === 0`: a clean corpus and an audit that never
   * happened look identical there, and the sweep uses this to decide whether
   * to stamp its cooldown. Stamping on a skip would cost the user a week of
   * hygiene for a transient local state.
   */
  skipped: boolean;
  /**
   * The plan had nothing left to audit: the cursor has reached the newest
   * topic. False for a run that failed or never happened, which also report
   * `audited: 0` — a caller deciding "the corpus is finished" must read this,
   * never `audited === 0`.
   */
  exhausted: boolean;
  /**
   * Where the audit cursor should move once the caller has PERSISTED this run's
   * verdicts (`commitSanityCursor`); null when it should stay. The audit never
   * writes the cursor itself: a cursor moved before the proposals are stored
   * loses the verdicts when that write fails.
   *
   * It is the newest topic of a prompt that decoded, but stops one
   * millisecond short of the oldest topic of a prompt that failed, so the
   * failed prompt's topics are judged again on the next run.
   */
  nextCursorMs: number | null;
  /** The stall counter to store with the cursor (`commitSanityCursor`); null
   *  when it stays as it is. */
  stallCount: number | null;
}

const EMPTY: SanityAuditResult = {
  incoherentFacts: [],
  audited: 0,
  skipped: false,
  exhausted: false,
  nextCursorMs: null,
  stallCount: null,
};

/** A run that never happened. Distinct from EMPTY — see `skipped`. */
const SKIPPED: SanityAuditResult = { ...EMPTY, skipped: true };

async function readCursor(): Promise<number> {
  const raw = Number(await getSetting(CURSOR_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Reset the audit cursor so the whole corpus is re-judged. Used by the
 *  one-time backfill after the generation prompt was fixed. */
export async function resetSanityCursor(): Promise<void> {
  await setSetting(CURSOR_KEY, '0');
  await setSetting(STALL_KEY, '0');
}

async function readStall(): Promise<number> {
  const raw = Number(await getSetting(STALL_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Move the audit cursor and store the stall counter. Called by the caller of
 *  `runSanityAudit` once the verdicts of that run are stored; a null field
 *  leaves its row alone. */
export async function commitSanityCursor(
  audit: Pick<SanityAuditResult, 'nextCursorMs' | 'stallCount'>,
): Promise<void> {
  if (audit.nextCursorMs !== null) await setSetting(CURSOR_KEY, String(audit.nextCursorMs));
  if (audit.stallCount !== null) await setSetting(STALL_KEY, String(audit.stallCount));
}

/**
 * Run one audit pass. Never throws — any failure yields zero verdicts, which the
 * sweep treats as "nothing to propose this week". The cursor is not moved here:
 * the caller commits `nextCursorMs` after it has stored the verdicts, so a
 * failed or raced-out run is retried intact.
 */
export async function runSanityAudit(opts?: {
  facts: SanityFactInput[];
  maxTopics?: number;
}): Promise<SanityAuditResult> {
  try {
    // On-device mode never calls the cloud AI. Reported as `skipped`, so the
    // sweep does not stamp its cooldown off a run that never happened.
    if (await isOnDeviceMode()) return SKIPPED;

    const facts = opts?.facts ?? [];
    if (facts.length === 0) return EMPTY;

    const cursorMs = await readCursor();

    // Candidate rows: active, fact-owned, auditable provenance.
    const rows = await topicsCollection
      .query(Q.where('status', 'active'), Q.where('fact_id', Q.notEq(null)))
      .fetch();

    // Story-bound topics are excluded even if their provenance drifted — a
    // followed story matches suggestions by topic_id, so retiring one silently
    // stops it finding new articles.
    const storyBound = new Set(
      (await trackedStoriesCollection.query().fetch())
        .map((s) => s.topicId)
        .filter((id): id is string => !!id),
    );

    const candidates: SanityTopicInput[] = rows
      .filter(
        (t) =>
          t.factId !== null &&
          !EXCLUDED_PROVENANCE.has(t.provenance) &&
          !storyBound.has(t.id),
      )
      .map((t) => ({
        id: t.id,
        factId: t.factId as string,
        text: t.text,
        createdAtMs: t.createdAt instanceof Date ? t.createdAt.getTime() : 0,
      }));

    const plan = planSanityBatches(candidates, facts, cursorMs, {
      maxTopics: opts?.maxTopics,
    });
    if (plan.calls.length === 0) return { ...EMPTY, exhausted: true };

    const results = await cloudBatchComplete(plan.calls);

    // Active-topic counts per fact — `fillTo` is the count BEFORE any retire, so
    // replacement generation restores the fact to its previous coverage.
    const activeByFact = new Map<string, number>();
    for (const t of rows) {
      if (!t.factId) continue;
      activeByFact.set(t.factId, (activeByFact.get(t.factId) ?? 0) + 1);
    }
    const factIdByTopicId = new Map(candidates.map((c) => [c.id, c.factId]));

    const createdAtById = new Map(candidates.map((c) => [c.id, c.createdAtMs]));
    const resultById = new Map(results.map((r) => [r.id, r]));

    const flaggedByFact = new Map<string, string[]>();
    let audited = 0;
    let decodedMaxMs = 0;
    let failedMinMs = Infinity;

    for (const [callId, topicIds] of plan.topicIdsByCallId) {
      const res = resultById.get(callId);
      if (!res || res.error) {
        logger.warn('[topic-sanity] batch half failed', {
          id: callId,
          error: res?.error ?? 'no result',
        });
        for (const topicId of topicIds) {
          failedMinMs = Math.min(failedMinMs, createdAtById.get(topicId) ?? 0);
        }
        continue;
      }
      audited += topicIds.length;
      for (const topicId of topicIds) {
        decodedMaxMs = Math.max(decodedMaxMs, createdAtById.get(topicId) ?? 0);
      }
      for (const topicId of decodeSanityVerdicts(
        res.output,
        topicIds,
        appHarnessLogger,
      )) {
        const factId = factIdByTopicId.get(topicId);
        if (!factId) continue;
        const list = flaggedByFact.get(factId) ?? [];
        list.push(topicId);
        flaggedByFact.set(factId, list);
      }
    }

    // Only move once something actually decoded, and never to or past a failed
    // prompt's oldest topic (a same-millisecond neighbour that did decode is
    // simply judged twice, which the proposal fingerprints absorb).
    const next = Math.min(decodedMaxMs, failedMinMs - 1);
    let nextCursorMs = audited > 0 && next > cursorMs ? next : null;

    // A prompt that fails on every attempt would hold the cursor here forever.
    // An outage throws inside cloudBatchComplete and never reaches here; any
    // failed prompt here was refused by the batch, so a run where the cursor
    // could not move counts as stalled.
    const stalled = await readStall();
    let stallCount: number | null = null;
    if (nextCursorMs !== null) {
      stallCount = stalled > 0 ? 0 : null;
    } else if (failedMinMs !== Infinity) {
      stallCount = stalled + 1;
      if (stallCount >= SANITY_STALL_LIMIT) {
        nextCursorMs = plan.maxCreatedAtMs > cursorMs ? plan.maxCreatedAtMs : null;
        stallCount = 0;
      }
    }

    const incoherentFacts: HygieneIncoherentFactInput[] = [...flaggedByFact.entries()]
      .map(([factId, topicIds]) => ({
        factId,
        topicIds: topicIds.sort(),
        fillTo: activeByFact.get(factId) ?? topicIds.length,
      }))
      .sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));

    return { incoherentFacts, audited, skipped: false, exhausted: false, nextCursorMs, stallCount };
  } catch (error) {
    // A missing E2EE keypair is a STATE, not a defect: the device has not
    // generated (or has cleared) its credential, so a billed batch could not
    // have been made. Duck-typed on the name, matching the suppression class in
    // lib/logger.ts, so this module does not import lib/e2ee either. Reported
    // as a breadcrumb and surfaced as `skipped` so the sweep withholds its
    // cooldown stamp instead of charging the user a week for it.
    if ((error as { name?: string } | null)?.name === 'NoCredentialError') {
      logger.addBreadcrumb(
        'sanity audit skipped — device has no E2EE credential',
        'topic-sanity-service',
        { method: 'runSanityAudit' },
        'info',
      );
      return SKIPPED;
    }
    logger.captureException(error, {
      tags: { service: 'topic-sanity-service', method: 'runSanityAudit' },
    });
    return EMPTY;
  }
}
