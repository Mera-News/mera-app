// Track-flow helper — the single entry point card/detail surfaces call to
// follow (or unfollow) a story from a FeedbackSubject.
//
// The follow is designed to feel instant: `trackStoryFromSubject` writes the
// local `tracked_stories` row synchronously (from the subject's fallback title)
// and returns, then enriches in the background — resolving the server stable
// cluster id, seeding sibling members, and (re)generating the LLM headline.
// Enrichment failures never surface to the user; the fallback title always
// renders until a headline lands (see tracked-story-service).

import { ArticleService } from '../article-service';
import {
  trackStory,
  untrackStory,
  isTracked,
  resolveStableId,
  seedMembers,
  findActiveTrackedId,
  getTrackedStoryById,
  type TrackedStoryMemberSnapshot,
} from '../database/services/tracked-story-service';
import { createTopics, retire } from '../database/services/topic-service';
import { enqueueJob, hasPendingJob } from '../database/services/inference-job-service';
import {
  handleStoryHeadlineJob,
  type StoryHeadlinePayload,
} from '../inference/handlers/story-headline-handler';
import { inferenceQueue } from '../inference/InferenceQueue';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import { ProcessingMode } from '../generated/graphql-types';
import type { FeedbackSubject } from '../../components/custom/cards/feedback-subject';
import logger from '../logger';

/** Newest-first cap on the titles we hand the headline LLM (keeps the prompt small). */
const MAX_HEADLINE_TITLES = 12;

/** Seed weight for a topic minted from "Track story" — high enough to retrieve
 *  strongly (see retrieval-profile), below a hand-pinned 1.0. */
const TRACKED_TOPIC_WEIGHT = 0.85;

/** Build the lean member snapshot for the originating (tapped) article. The
 *  subject carries no pub date/image, so we stamp "now" and let the reconcile /
 *  server archive supply richer fields for the same id later. */
function snapshotFromSubject(subject: FeedbackSubject): TrackedStoryMemberSnapshot {
  return {
    articleId: subject.articleId,
    title: subject.title ?? '',
    pubDateMs: Date.now(),
    publicationName: subject.publicationName ?? undefined,
  };
}

interface SeededCoverage {
  /** The stable cluster id, if the archive/cluster resolved one. */
  stableClusterId: string | null;
  /** Member article ids discovered server-side (newest-first). */
  memberIds: string[];
  /** English titles for those members — the headline LLM's input. */
  titles: string[];
  /** The freshest member for the "latest" pointer. */
  latest: { latestArticleId?: string | null; latestTitle?: string | null } | null;
}

const EMPTY_COVERAGE: SeededCoverage = {
  stableClusterId: null,
  memberIds: [],
  titles: [],
  latest: null,
};

/** Flatten a server archive into the seed shape (ids + english titles). */
function coverageFromArchive(
  archive: Awaited<ReturnType<typeof ArticleService.trackStory>>,
): SeededCoverage {
  if (!archive) return EMPTY_COVERAGE;
  const rows = archive.articles ?? [];
  const memberIds = rows.map((a) => a.articleId).filter((x): x is string => !!x);
  const titles = rows
    .map((a) => a.title_en)
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  const first = rows[0];
  return {
    stableClusterId: archive.stableClusterId ?? null,
    memberIds,
    titles,
    latest: first
      ? { latestArticleId: first.articleId, latestTitle: first.title_en }
      : null,
  };
}

/** Flatten a live cluster into the seed shape (ids + english titles). */
function coverageFromCluster(
  cluster: Awaited<ReturnType<typeof ArticleService.getNewsClusterForArticle>>,
): SeededCoverage {
  if (!cluster) return EMPTY_COVERAGE;
  const rows = cluster.articles?.articles ?? [];
  const memberIds = rows.map((a) => a._id).filter((x): x is string => !!x);
  const titles = rows
    .map((a) => a.title_en_internal_only ?? a.title ?? null)
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  const first = rows[0];
  return {
    stableClusterId: cluster.stableClusterId ?? null,
    memberIds,
    titles,
    latest: first
      ? {
          latestArticleId: first._id,
          latestTitle: first.title_en_internal_only ?? first.title ?? null,
        }
      : null,
  };
}

/**
 * Kick off (or run) the headline job for a freshly-seeded story. Cloud mode
 * runs the handler inline (one E2EE completion); on-device mode enqueues a
 * single deduped queue job so it never contends with chat for llama.rn. Mirrors
 * persona-summary-trigger. Never throws.
 */
async function triggerHeadline(trackedStoryId: string, titles: string[]): Promise<void> {
  const trimmed = titles
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, MAX_HEADLINE_TITLES);
  if (trimmed.length === 0) return;

  try {
    const useCloud =
      useMeraProtocolStore.getState().processingMode === ProcessingMode.Cloud;
    const payload: StoryHeadlinePayload = { trackedStoryId, titles: trimmed, useCloud };

    if (useCloud) {
      await handleStoryHeadlineJob(payload);
      return;
    }
    // On-device: dedupe on the trackedStoryId the payload already carries.
    if (await hasPendingJob('story_headline', 'trackedStoryId', trackedStoryId)) return;
    await enqueueJob('story_headline', payload as unknown as Record<string, unknown>);
    inferenceQueue.notify();
  } catch (err) {
    logger.warn('[track-actions] headline trigger failed', {
      trackedStoryId,
      error: String(err),
    });
  }
}

/**
 * Resolve server coverage for a freshly-tracked story, seed its members, and
 * fire the headline job. Runs in the background — awaited only by tests.
 */
async function enrichTrackedStory(
  trackedStoryId: string,
  subject: FeedbackSubject,
  opts?: { skipHeadline?: boolean },
): Promise<void> {
  try {
    let coverage: SeededCoverage = EMPTY_COVERAGE;

    // Prefer the durable archive when we already know the stable id.
    if (subject.stableClusterId) {
      const archive = await ArticleService.trackStory(subject.stableClusterId);
      coverage = coverageFromArchive(archive);
    }

    // No stable id, or no archive to seed from → fall back to the live cluster,
    // then archive it under its resolved stable id.
    if (!coverage.stableClusterId) {
      const cluster = await ArticleService.getNewsClusterForArticle(subject.articleId);
      const live = coverageFromCluster(cluster);
      if (live.stableClusterId) {
        await resolveStableId(trackedStoryId, live.stableClusterId);
        // Seed the durable archive so future reads/reconciles have a source.
        const archive = await ArticleService.trackStory(live.stableClusterId);
        coverage = archive ? coverageFromArchive(archive) : live;
      } else {
        coverage = live;
      }
    }

    if (coverage.memberIds.length > 0) {
      await seedMembers(trackedStoryId, coverage.memberIds, coverage.latest ?? undefined);
    }

    // Topic-linked stories set their headline directly (the accepted proposal),
    // so they skip the separate headline job. Legacy toggle-track stories still
    // derive one from the seeded coverage titles.
    if (!opts?.skipHeadline) {
      const titles = coverage.titles.length > 0 ? coverage.titles : [subject.title];
      await triggerHeadline(trackedStoryId, titles);
    }
  } catch (err) {
    logger.warn('[track-actions] enrich failed', {
      trackedStoryId,
      error: String(err),
    });
  }
}

/**
 * Follow the story described by `subject`. Creates the local row immediately
 * (so the UI can flip to "tracked" without waiting on the network), then
 * enriches in the background. Returns once the row exists; the returned promise
 * does NOT wait for enrichment.
 */
export async function trackStoryFromSubject(subject: FeedbackSubject): Promise<void> {
  const created = await trackStory({
    stableClusterId: subject.stableClusterId ?? null,
    articleId: subject.articleId,
    title: subject.title,
    originSurface: subject.surface,
  });
  // Fire-and-forget enrichment — never blocks the follow.
  void enrichTrackedStory(created.id, subject);
}

/**
 * Follow the story described by `subject` as a TOPIC, using the proposal the
 * user accepted in the floating Mera chat (the proposeTrack tool → ProposalCard
 * Confirm → executeProposalActions). Mints a `topics` row (the continuous
 * server-side link), creates the local TrackedStory carrying that topic id +
 * the proposal as its headline, seeds the originating article snapshot, then
 * enriches the originating cluster in the background for archive backfill (but
 * NOT a headline job — the accepted proposal IS the headline). Returns once the
 * row exists; enrichment is fire-and-forget.
 */
export async function trackStoryWithProposal(
  subject: FeedbackSubject,
  proposalText: string,
): Promise<void> {
  const text = (proposalText ?? '').trim();
  if (!text) return;

  // 1. Mint the topic — the durable server-side link. Continue even if this
  //    fails; the story still tracks locally against its origin cluster.
  let topicId: string | null = null;
  try {
    const [topic] = await createTopics([
      {
        text,
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

  // 2. Create the local story row (headline = the accepted proposal).
  const created = await trackStory({
    stableClusterId: subject.stableClusterId ?? null,
    articleId: subject.articleId,
    title: subject.title,
    originSurface: subject.surface,
    topicId,
    topicText: text,
    llmHeadline: text,
    initialSnapshot: snapshotFromSubject(subject),
  });

  // 3. Background enrichment for the originating cluster (archive/members),
  //    skipping the headline job.
  void enrichTrackedStory(created.id, subject, { skipHeadline: true });
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

// Exposed for direct awaiting in tests (the public flow fires it fire-and-forget).
export const __test = { enrichTrackedStory, triggerHeadline };
