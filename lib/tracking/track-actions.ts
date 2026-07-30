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
  observeTrackedId,
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
 *  the subject's REAL pubDate when known so the timeline orders by publication
 *  time, not the track moment. The topic reconcile supplies richer snapshots for
 *  later members from local suggestion data.
 *
 *  UNKNOWN pubDate falls back to 0, NOT `Date.now()`. `Date.now()` was actively
 *  harmful: every timeline row renders publication age under the same clock
 *  chip, so a seed with no date claimed to be seconds old and sorted itself to
 *  the top — a 13h-old article displayed as "4m ago" above genuinely fresher
 *  coverage. 0 is the sentinel the rest of the service already reads as "old /
 *  unknown" (see the unseen-count watermark): it sorts last and the card simply
 *  renders no timestamp rather than a false one. Callers should still pass a
 *  real `pubDate` — every current one does. */
function snapshotFromSubject(subject: FeedbackSubject): TrackedStoryMemberSnapshot {
  const parsed = subject.pubDate ? Date.parse(subject.pubDate) : NaN;
  const pubDateMs = Number.isFinite(parsed) ? parsed : 0;
  return {
    articleId: subject.articleId,
    title: subject.title ?? '',
    pubDateMs,
    publicationName: subject.publicationName ?? undefined,
    // No language on the subject — the timeline resolves it from the local
    // suggestion row on first open (see `hydrateSource`).
    countryCode: subject.countryCode ?? undefined,
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

  // IDEMPOTENCE. This ran unconditionally, so every confirmed proposal minted a
  // fresh topic AND a fresh tracked_stories row — the duplicate followed stories
  // users hit. A stale button was one route in; it is not the only one, because
  // the floating chat outlives the screen and a second proposal can be confirmed
  // from anywhere. Guarding the WRITE is what actually makes duplicates
  // impossible, so the check belongs here rather than only in the button.
  const existing = await findActiveTrackedId({
    stableClusterId: subject.stableClusterId ?? null,
    articleId: subject.articleId,
  });
  if (existing) {
    logger.info('[track-actions] story already tracked — skipping duplicate mint', {
      id: existing,
    });
    return;
  }

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

/**
 * DELETE a followed story by id — the destructive path behind every "delete this
 * story" confirm (the story timeline's Delete button, the Stories list's trash).
 *
 * Retiring the minted TOPIC is the half that is easy to forget and expensive to
 * miss: the topic is what keeps pulling this story's articles every fetch cycle,
 * so deleting only the `tracked_stories` row leaves an invisible topic
 * retrieving coverage for a story the user believes they removed. Retire, not
 * hard-delete, mirrors how chat retires a topic (dedup/history preserved).
 *
 * Never throws — a failed topic retire must not block the row delete.
 */
export async function deleteTrackedStoryById(id: string): Promise<void> {
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

/** Unfollow the active story matching `subject` (no-op when none matches).
 *  Thin subject→id resolver over {@link deleteTrackedStoryById}. */
export async function untrackStoryFromSubject(subject: FeedbackSubject): Promise<void> {
  const id = await findActiveTrackedId({
    stableClusterId: subject.stableClusterId ?? null,
    articleId: subject.articleId,
  });
  if (!id) return;
  await deleteTrackedStoryById(id);
}

/** Is the story described by `subject` already followed (active only)? */
export async function isSubjectTracked(subject: FeedbackSubject): Promise<boolean> {
  return isTracked({
    stableClusterId: subject.stableClusterId ?? null,
    articleId: subject.articleId,
  });
}

/** Reactive id of the active story matching `subject` (null when untracked) —
 *  what the track BUTTON subscribes to. Reactive so it reflects a follow
 *  confirmed later inside the floating chat (which outlives the host screen)
 *  instead of staying stale until a remount; the ID rather than a flag so the
 *  "already following" dialog can navigate straight to that story. */
export function observeSubjectTrackedId(subject: FeedbackSubject) {
  return observeTrackedId({
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
