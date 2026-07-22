// 30-min tracked-stories poll task. Complements the feed-sync reconcile
// (lib/scheduler/feed-sync/tracked-story-reconcile.ts, which only sees THIS
// device's just-persisted suggestions) by asking the server directly for
// each due story: the durable archive when a stable id is resolved, or a
// live-cluster lookup when it isn't (singleton stories) / the archive came
// back empty. A story whose stable id resolves via the live-cluster lookup
// is "promoted" from singleton to stable-id-tracked via `resolveStableId`.
//
// Serial by design (small cap, network calls) — see feed-sync-steps.ts for
// the counterpart local-only pass.

import { ArticleService } from '@/lib/article-service';
import {
  getActiveForPoll,
  applyUpdates,
  resolveStableId,
  recordMiss,
  stampChecked,
  type TrackedStoryPollRow,
} from '@/lib/database/services/tracked-story-service';
import { getCurrentPathname } from '@/lib/nav-state';
import logger from '@/lib/logger';
import { AppScheduler } from '../AppScheduler';
import type { TaskContext } from '../scheduler-types';

const POLL_INTERVAL_MS = 30 * 60 * 1000;
/** Per-run cap — keeps the serial network pass well inside the task timeout. */
const MAX_STORIES_PER_RUN = 10;

/** Diff a candidate article-id set against a story's known members. */
function diffNewMembers(candidateIds: string[], existingIds: string[]): string[] {
  const existing = new Set(existingIds);
  return candidateIds.filter((id) => !existing.has(id));
}

/**
 * Look up the current live cluster for a story with no (or a just-emptied)
 * archive, diff its members, and either grow the story or record a miss.
 * Also promotes a singleton story once the server resolves a stable id.
 */
async function pollViaLiveCluster(story: TrackedStoryPollRow): Promise<void> {
  const seedArticleId =
    story.latestArticleId ?? story.memberArticleIds[story.memberArticleIds.length - 1] ?? null;
  if (!seedArticleId) {
    await recordMiss(story.id);
    return;
  }

  const cluster = await ArticleService.getNewsClusterForArticle(seedArticleId);
  if (!cluster) {
    await recordMiss(story.id);
    return;
  }

  if (cluster.stableClusterId) {
    await resolveStableId(story.id, cluster.stableClusterId);
  }

  const candidateIds = (cluster.articles?.articles ?? []).map((a) => a._id);
  const newMemberIds = diffNewMembers(candidateIds, story.memberArticleIds);
  if (newMemberIds.length > 0) {
    // Legacy count fallback (no newSnapshots): the poll works off id-only diffs
    // against the live cluster / archive, so it can't hand applyUpdates the
    // per-member pubDates the v44 watermark gate needs. The feed-sync reconcile
    // owns the watermark-accurate path; this network poll stays id-only.
    await applyUpdates(story.id, { newMemberIds });
  } else {
    await recordMiss(story.id);
  }
}

/** Poll a story that has a resolved stable id via its durable archive. */
async function pollViaArchive(story: TrackedStoryPollRow, stableClusterId: string): Promise<void> {
  const archive = await ArticleService.getTrackedStory(stableClusterId);
  if (!archive) {
    // Archive gone (e.g. TTL'd out server-side) — fall back to the live
    // cluster, same as the no-stable-id path.
    await pollViaLiveCluster(story);
    return;
  }

  const candidateIds = archive.articles.map((a) => a.articleId);
  const newMemberIds = diffNewMembers(candidateIds, story.memberArticleIds);
  if (newMemberIds.length > 0) {
    await applyUpdates(story.id, { newMemberIds });
  } else {
    await recordMiss(story.id);
  }
}

async function pollOne(story: TrackedStoryPollRow, ctx: TaskContext): Promise<void> {
  try {
    if (story.stableClusterId) {
      await pollViaArchive(story, story.stableClusterId);
    } else {
      await pollViaLiveCluster(story);
    }
  } catch (err) {
    // Isolate per-story failures — one bad lookup must not stall the rest of
    // this run (or fail it and cost the whole batch its `last_checked_at`).
    logger.captureException(err, {
      tags: { component: 'tracked-stories-poll-task', method: 'pollOne' },
      extra: { trackedStoryId: story.id },
    });
    ctx.log(`poll failed for story ${story.id}: ${String(err)}`);
  } finally {
    // Always stamp — whatever happened, this story was just checked, and the
    // next run's staleness window should move on.
    await stampChecked(story.id);
  }
}

AppScheduler.register({
  name: 'tracked-stories-poll',
  displayName: 'Tracked Stories Poll',
  frequency: POLL_INTERVAL_MS,
  triggers: ['app-foreground'],
  conditions: [
    { type: 'authenticated' },
    // Skip while gated behind the paywall (server calls would 402).
    {
      type: 'custom',
      check: () => !getCurrentPathname().includes('not-subscribed'),
    },
  ],
  timeout: 20_000,
  maxAttempts: 2,
  exclusive: true,
  handler: async (_input, ctx) => {
    const due = await getActiveForPoll(Date.now() - POLL_INTERVAL_MS, MAX_STORIES_PER_RUN);
    if (due.length === 0) {
      ctx.log('no tracked stories due for a poll check');
      return;
    }
    ctx.log(`polling ${due.length} tracked stor${due.length === 1 ? 'y' : 'ies'}`);
    for (const story of due) {
      await pollOne(story, ctx);
    }
  },
});
