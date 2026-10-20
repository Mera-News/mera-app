// Handler for tracked_story_migrate jobs — converts a LEGACY stable-cluster
// follow (a `tracked_stories` row with no `topic_id`) into a topic-linked story.
// It LLM-generates a `{label, search}` scope from the story's known titles, mints
// a tracked TOPIC from the `search` query, binds it onto the story, and writes the
// display `label` as the story's headline. Cloud path = one E2EE completion;
// on-device path = one structured local completion with its own prompt
// (news-harness/on-device/story-scope). Mirrors the story_headline handler's
// shape (titles → LLM → strict JSON → write) and reuses the queue's retry
// mechanics. Non-destructive: any transport/parse failure leaves the row
// unmigrated (still legacy) so a later wave can retry.

import { createTopics } from '../../database/services/topic-service';
import {
  bindTrackedTopic,
  setLlmHeadline,
} from '../../database/services/tracked-story-service';
import { cloudComplete } from '../../llm/cloudComplete';
import { isOnDeviceMode } from '../../llm/on-device-gate';
import { completeLocalStructured } from '../../llm/completeLocal';
import { isOnDeviceDeferrable } from '../job-defer';
import { buildStoryScopePrompt, parseStoryScopeOutput, type StoryScope } from '../../news-harness/story-scope';
import { buildOnDeviceStoryScopePrompt } from '../../news-harness/on-device/story-scope/prompt';
import { STORY_SCOPE_SCHEMA, type StoryScopeReply } from '../../news-harness/on-device/story-scope/schema';
import { storyScopeFromReply } from '../../news-harness/on-device/story-scope/parse';
import logger from '../../logger';

/** Seed weight for a topic minted from a legacy follow — mirrors the interactive
 *  "Track story" weight (below a hand-pinned 1.0, high enough to retrieve). */
const TRACKED_TOPIC_WEIGHT = 0.85;

export interface TrackedStoryMigratePayload {
  /** The legacy `tracked_stories` row to convert to a topic-linked story. */
  trackedStoryId: string;
  /** The story's known member-article titles, fed to the scope generator. */
  titles: string[];
  /** Cloud vs on-device transport (defaults to on-device). */
  useCloud?: boolean;
}

export interface TrackedStoryMigrateResult {
  ok: boolean;
}

/**
 * Stable dedupe key so a later wave's enqueue can avoid stacking duplicate
 * migrate jobs for the same story: `tracked_story_migrate:<trackedStoryId>`.
 */
export function trackedStoryMigrateDedupeKey(trackedStoryId: string): string {
  return `tracked_story_migrate:${trackedStoryId}`;
}

export async function handleTrackedStoryMigrateJob(
  payload: TrackedStoryMigratePayload,
): Promise<TrackedStoryMigrateResult> {
  const trackedStoryId = payload.trackedStoryId;
  const titles = Array.isArray(payload.titles) ? payload.titles : [];

  if (!trackedStoryId || titles.length === 0) {
    logger.warn('[tracked-story-migrate] invalid payload — skipping', {
      trackedStoryId,
      titleCount: titles.length,
    });
    return { ok: false };
  }

  // Real clock supplied HERE: both prompt builders take the date as a
  // parameter so their prompts stay deterministic/pinnable.
  const now = Date.now();
  let scope: StoryScope;
  try {
    // A job queued in cloud mode runs locally if the mode has since changed.
    if (payload.useCloud && !(await isOnDeviceMode())) {
      const { system, user } = buildStoryScopePrompt(titles, now);
      const raw = await cloudComplete({
        systemPrompt: system,
        prompt: user,
        maxTokens: 128,
        temperature: 0.3,
      });
      scope = parseStoryScopeOutput(raw);
    } else {
      const { system, prompt } = buildOnDeviceStoryScopePrompt(titles, now);
      const reply = await completeLocalStructured<StoryScopeReply>({
        systemPrompt: system,
        prompt,
        schema: STORY_SCOPE_SCHEMA,
        maxTokens: 128,
        temperature: 0.3,
      });
      scope = storyScopeFromReply(reply);
    }
  } catch (err) {
    // The built-in model said "not now" (busy, unavailable): the queue defers the job.
    if (isOnDeviceDeferrable(err)) throw err;
    // Transport failure or unusable output: leave the story unmigrated (no write).
    logger.warn('[tracked-story-migrate] no scope', { error: String(err) });
    return { ok: false };
  }
  const { label, search } = scope;

  // Mint (or resolve an existing) 'tracked' topic from the generated search
  // query, bind it onto the story, and set the display label as its headline.
  const [topic] = await createTopics([
    {
      text: search,
      weight: TRACKED_TOPIC_WEIGHT,
      status: 'active',
      provenance: 'tracked',
      highPriority: true,
    },
  ]);
  await bindTrackedTopic(trackedStoryId, topic?.id ?? null, search);
  await setLlmHeadline(trackedStoryId, label);
  logger.debug('[tracked-story-migrate] migrated legacy story', { trackedStoryId });
  return { ok: true };
}
