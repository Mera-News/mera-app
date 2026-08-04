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
}

const EMPTY: SanityAuditResult = { incoherentFacts: [], audited: 0 };

async function readCursor(): Promise<number> {
  const raw = Number(await getSetting(CURSOR_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Reset the audit cursor so the whole corpus is re-judged. Used by the
 *  one-time backfill after the generation prompt was fixed. */
export async function resetSanityCursor(): Promise<void> {
  await setSetting(CURSOR_KEY, '0');
}

/**
 * Run one audit pass. Never throws — any failure yields zero verdicts, which the
 * sweep treats as "nothing to propose this week". The cursor advances ONLY when
 * verdicts actually came back, so a failed or raced-out run is retried intact.
 */
export async function runSanityAudit(opts?: {
  facts: SanityFactInput[];
  maxTopics?: number;
}): Promise<SanityAuditResult> {
  try {
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
    if (plan.calls.length === 0) return EMPTY;

    const results = await cloudBatchComplete(plan.calls);

    // Active-topic counts per fact — `fillTo` is the count BEFORE any retire, so
    // replacement generation restores the fact to its previous coverage.
    const activeByFact = new Map<string, number>();
    for (const t of rows) {
      if (!t.factId) continue;
      activeByFact.set(t.factId, (activeByFact.get(t.factId) ?? 0) + 1);
    }
    const factIdByTopicId = new Map(candidates.map((c) => [c.id, c.factId]));

    const flaggedByFact = new Map<string, string[]>();
    let decodedAny = false;

    for (const res of results) {
      const topicIds = plan.topicIdsByCallId.get(res.id);
      if (!topicIds) continue;
      if (res.error) {
        logger.warn('[topic-sanity] batch half failed', {
          id: res.id,
          error: res.error,
        });
        continue;
      }
      decodedAny = true;
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

    // Only advance once something actually came back; a wholly failed run must
    // be retried against the same topics next week.
    if (decodedAny && plan.maxCreatedAtMs > 0) {
      await setSetting(CURSOR_KEY, String(plan.maxCreatedAtMs));
    }

    const incoherentFacts: HygieneIncoherentFactInput[] = [...flaggedByFact.entries()]
      .map(([factId, topicIds]) => ({
        factId,
        topicIds: topicIds.sort(),
        fillTo: activeByFact.get(factId) ?? topicIds.length,
      }))
      .sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));

    const audited = [...plan.topicIdsByCallId.values()].reduce(
      (n, ids) => n + ids.length,
      0,
    );
    return { incoherentFacts, audited };
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'topic-sanity-service', method: 'runSanityAudit' },
    });
    return EMPTY;
  }
}
