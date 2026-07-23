// Track-flow helper — the single entry point card/detail surfaces call to
// follow (or unfollow) a story from a FeedbackSubject.
//
// A followed story is just a durable TOPIC. "Track" opens the floating Mera
// chat; the proposeTrack tool proposes 3–4 scope pills (a shown display label +
// a hidden search query); confirming lands here. We mint a `topics` row keyed on
// the SEARCH text (the durable link the persona query grows from each fetch
// cycle) plus a local `tracked_stories` row that shows the display LABEL as its
// headline and seeds the tapped article. The story then grows every fetch cycle
// via the topic reconcile, exactly like any other topic — there is no
// server-side stable-cluster archive and no relevance pipeline for it.

import {
  trackStory,
  untrackStory,
  isTracked,
  findActiveTrackedId,
  getTrackedStoryById,
  getLegacyTrackedForMigration,
  type TrackedStoryMemberSnapshot,
} from '../database/services/tracked-story-service';
import { createTopics, retire } from '../database/services/topic-service';
import { enqueueJob, hasPendingJob } from '../database/services/inference-job-service';
import {
  handleTrackedStoryMigrateJob,
  type TrackedStoryMigratePayload,
} from '../inference/handlers/tracked-story-migrate-handler';
import { inferenceQueue } from '../inference/InferenceQueue';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import { ProcessingMode } from '../generated/graphql-types';
import type { FeedbackSubject } from '../../components/custom/cards/feedback-subject';
import logger from '../logger';

/** Seed weight for a topic minted from "Track story" — high enough to retrieve
 *  strongly (see retrieval-profile), below a hand-pinned 1.0. */
const TRACKED_TOPIC_WEIGHT = 0.85;

/** The scope pill the user confirmed in the follow-a-story card: the shown
 *  display `label` and the hidden `searchText` retrieval query. `label` is what
 *  the tracked-story UI shows; `searchText` is minted as the tracked topic. */
export interface AcceptedTrackScope {
  label: string;
  searchText: string;
}

/** Build the lean member snapshot for the originating (tapped) article. We stamp
 *  the subject's REAL pubDate when known (Part E timeline fix) so the timeline
 *  orders by publication time, not the track moment; `now` is only a fallback
 *  for subjects that carry no pubDate. The topic reconcile supplies richer
 *  snapshots for later members from local suggestion data. */
function snapshotFromSubject(subject: FeedbackSubject): TrackedStoryMemberSnapshot {
  const parsed = subject.pubDate ? Date.parse(subject.pubDate) : NaN;
  const pubDateMs = Number.isFinite(parsed) ? parsed : Date.now();
  return {
    articleId: subject.articleId,
    title: subject.title ?? '',
    pubDateMs,
    publicationName: subject.publicationName ?? undefined,
  };
}

/**
 * Follow the story described by `subject` as a TOPIC, using the scope pill the
 * user accepted in the floating Mera chat (proposeTrack → ProposalCard Confirm →
 * executeProposalActions). Mints a `topics` row keyed on the accepted SEARCH
 * text (the durable link the persona query grows from), then creates the local
 * TrackedStory carrying that topic id, the display LABEL as its headline, and
 * the originating article as its first snapshot. Returns once the row exists;
 * subsequent members arrive via the topic reconcile on the next fetch cycle.
 */
export async function trackStoryWithProposal(
  subject: FeedbackSubject,
  scope: AcceptedTrackScope,
): Promise<void> {
  const label = (scope.label ?? '').trim();
  const searchText = (scope.searchText ?? '').trim();
  // The search text is what actually retrieves articles — without it there is
  // nothing to follow.
  if (!searchText) return;

  // 1. Mint the topic keyed on the SEARCH text. Continue even if this fails; the
  //    story still tracks locally against its origin article.
  let topicId: string | null = null;
  try {
    const [topic] = await createTopics([
      {
        text: searchText,
        weight: TRACKED_TOPIC_WEIGHT,
        status: 'active',
        provenance: 'tracked',
        highPriority: true,
      },
    ]);
    topicId = topic?.id ?? null;
  } catch (err) {
    logger.warn('[track-actions] topic mint failed', { error: String(err) });
  }

  // 2. Create the local story row: display LABEL as the headline, SEARCH text as
  //    the tracked topic, seeded with the tapped article snapshot.
  await trackStory({
    stableClusterId: subject.stableClusterId ?? null,
    articleId: subject.articleId,
    title: subject.title,
    originSurface: subject.surface,
    topicId,
    topicText: searchText,
    llmHeadline: label || searchText,
    initialSnapshot: snapshotFromSubject(subject),
  });
}

/** Unfollow the active story matching `subject` (no-op when none matches).
 *  Also retires the minted topic so it stops linking server-side (dedup/history
 *  only — mirrors how chat retires a topic; never a hard delete). */
export async function untrackStoryFromSubject(subject: FeedbackSubject): Promise<void> {
  const id = await findActiveTrackedId({
    stableClusterId: subject.stableClusterId ?? null,
    articleId: subject.articleId,
  });
  if (!id) return;
  try {
    const row = await getTrackedStoryById(id);
    const topicId = row?.topicId ?? null;
    if (topicId) await retire(topicId);
  } catch (err) {
    logger.warn('[track-actions] topic retire failed', { id, error: String(err) });
  }
  await untrackStory(id);
}

/** Is the story described by `subject` already followed (active only)? */
export async function isSubjectTracked(subject: FeedbackSubject): Promise<boolean> {
  return isTracked({
    stableClusterId: subject.stableClusterId ?? null,
    articleId: subject.articleId,
  });
}

/**
 * One-shot, idempotent upgrade of legacy stable-cluster follows to the topic
 * model. Before the redesign a follow tracked a server `stableClusterId` archive
 * (now removed). Convert every active story that still lacks a `topic_id` into a
 * tracked TOPIC by LLM-generating a `{label, search}` scope from the story's
 * known titles — the `search` query is minted as the tracked topic and the
 * `label` becomes the story's display headline — so it keeps updating via the
 * persona query like any other topic.
 *
 * Routes through the on-device InferenceQueue exactly like the story_headline
 * flow: in CLOUD processing mode the migrate handler runs inline per row; in
 * ON-DEVICE mode a deduped inference job is enqueued per row (the queue
 * serializes llama.rn access). Rows that already have a `topic_id` are skipped,
 * so this is safe to run on every sync — a cheap no-op once nothing legacy
 * remains. Returns the count migrated (cloud) or enqueued (on-device). Never
 * throws.
 */
export async function migrateLegacyTrackedStories(): Promise<number> {
  const legacy = await getLegacyTrackedForMigration();
  if (legacy.length === 0) return 0;

  const useCloud =
    useMeraProtocolStore.getState().processingMode === ProcessingMode.Cloud;

  let count = 0;
  let enqueued = 0;
  for (const row of legacy) {
    try {
      if (useCloud) {
        // Cloud: run the handler inline (one E2EE completion per story).
        const result = await handleTrackedStoryMigrateJob({
          trackedStoryId: row.id,
          titles: row.titles,
          useCloud: true,
        });
        if (result.ok) count++;
      } else {
        // On-device: enqueue a single deduped job (queue owns llama.rn access).
        if (await hasPendingJob('tracked_story_migrate', 'trackedStoryId', row.id)) {
          continue;
        }
        const payload: TrackedStoryMigratePayload = {
          trackedStoryId: row.id,
          titles: row.titles,
        };
        await enqueueJob('tracked_story_migrate', payload as unknown as Record<string, unknown>);
        enqueued++;
        count++;
      }
    } catch (err) {
      logger.warn('[track-actions] legacy tracked-story migrate failed', {
        id: row.id,
        error: String(err),
      });
    }
  }

  if (!useCloud && enqueued > 0) inferenceQueue.notify();
  return count;
}
