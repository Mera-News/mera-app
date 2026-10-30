// Handler for story_names jobs: writes a followed story's mustMatch names (the
// 1-3 names every article of the story must mention) from the label and search
// the reader accepted. Modelled on story-headline-handler: cloud = one E2EE
// completion, on-device = one local completion, a cloud-queued job runs locally
// once the mode is on-device. Non-destructive: a transport or parse failure, or
// an empty answer, writes nothing.
//
// The names come from this job, never from the chat that offered the story:
// putting a mustMatch field and rule on the cloud follow loop's proposeTrack cut
// its follow cards in one live run, so the chat tools carry no names.

import { enqueueJob, hasPendingJob } from '../../database/services/inference-job-service';
import { cloudComplete } from '../../llm/cloudComplete';
import { isOnDeviceMode } from '../../llm/on-device-gate';
import { completeLocal } from '../../llm/completeLocal';
import { buildStoryNamesPrompt, parseStoryNamesOutput } from '../../news-harness/story-names';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import { ProcessingMode } from '../../generated/graphql-types';
import { isOnDeviceDeferrable } from '../job-defer';
import logger from '../../logger';

export interface StoryNamesPayload {
  /** The tracked topic the names belong to. */
  topicId: string;
  /** The accepted option's display label. */
  label: string;
  /** The accepted option's search text. */
  search: string;
  /** Cloud vs on-device transport (defaults to on-device). */
  useCloud?: boolean;
}

export interface StoryNamesResult {
  ok: boolean;
  /** How many names were written (0 when none). */
  names?: number;
}

/** Writes the names onto the tracked topic. Injected in tests. */
export type WriteStoryNames = (topicId: string, names: string[]) => Promise<unknown>;

// Required at call time: track-actions imports the queue, which imports this
// handler, so a module-scope import would close a cycle.
const writeViaTrackActions: WriteStoryNames = (topicId, names) =>
  (require('../../tracking/track-actions') as {
    setTrackedMustMatch: (topicId: string, names: unknown) => Promise<boolean>;
  }).setTrackedMustMatch(topicId, names);

export async function handleStoryNamesJob(
  payload: StoryNamesPayload,
  _ctx?: unknown,
  write: WriteStoryNames = writeViaTrackActions,
): Promise<StoryNamesResult> {
  const topicId = payload.topicId;
  const label = typeof payload.label === 'string' ? payload.label.trim() : '';
  const search = typeof payload.search === 'string' ? payload.search.trim() : '';
  if (!topicId || (!label && !search)) {
    logger.warn('[story-names] invalid payload, skipping', { hasTopic: !!topicId });
    return { ok: false };
  }

  const { system, user } = buildStoryNamesPrompt({ label, search: search || label });

  let raw = '';
  try {
    if (payload.useCloud && !(await isOnDeviceMode())) {
      raw = await cloudComplete({ systemPrompt: system, prompt: user, maxTokens: 128, temperature: 0.3 });
    } else {
      raw = await completeLocal({
        systemPrompt: system,
        prompt: user,
        maxTokens: 128,
        temperature: 0.3,
        responseFormat: 'json',
        enableThinking: false,
      });
    }
  } catch (err) {
    // The built-in model's "not now" defers the job instead of spending it.
    if (isOnDeviceDeferrable(err)) throw err;
    logger.warn('[story-names] completion failed', { error: String(err) });
    return { ok: false };
  }

  let names: string[];
  try {
    names = parseStoryNamesOutput(raw);
  } catch (err) {
    logger.warn('[story-names] parse failed', { error: String(err) });
    return { ok: false };
  }

  if (names.length === 0) return { ok: true, names: 0 };
  await write(topicId, names);
  return { ok: true, names: names.length };
}

/**
 * Queue one story_names job for a tracked topic, unless one is already pending
 * or running for it. Transport follows the processing mode at enqueue time; the
 * handler re-checks it at run time. Returns whether a job was queued. Never throws.
 */
export async function enqueueStoryNamesJob(input: { topicId: string; label: string; search: string }): Promise<boolean> {
  try {
    if (!input.topicId) return false;
    if (await hasPendingJob('story_names', 'topicId', input.topicId)) return false;
    const payload: StoryNamesPayload = {
      topicId: input.topicId,
      label: input.label,
      search: input.search,
      useCloud: useMeraProtocolStore.getState().processingMode === ProcessingMode.Cloud,
    };
    await enqueueJob('story_names', payload as unknown as Record<string, unknown>);
    // Same cycle as above: the queue imports this module.
    (require('../InferenceQueue') as typeof import('../InferenceQueue')).inferenceQueue.notify();
    return true;
  } catch (err) {
    logger.warn('[story-names] enqueue failed', { error: String(err) });
    return false;
  }
}
