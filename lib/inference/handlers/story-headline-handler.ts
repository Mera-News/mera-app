// Handler for story_headline jobs — turns the titles of a tracked story's member
// articles into ONE plain-language English headline and writes it to the
// story's `llm_headline`. Cloud path = one E2EE completion; on-device path = one
// local completion. Mirrors the persona-summary handler's shape (input → LLM →
// strict JSON → write) and reuses the queue's retry mechanics. Non-destructive:
// any transport/parse failure leaves the existing `fallback_title` in place.

import { setLlmHeadline } from '../../database/services/tracked-story-service';
import { cloudComplete } from '../../llm/cloudComplete';
import { completeLocal } from '../../llm/completeLocal';
import {
  buildStoryHeadlinePrompt,
  parseStoryHeadlineOutput,
} from '../../news-harness/story-headline';
import logger from '../../logger';

export interface StoryHeadlinePayload {
  /** The tracked_stories row to write the headline back to. */
  trackedStoryId: string;
  /** Member-article titles the headline is derived from. */
  titles: string[];
  /** Cloud vs on-device transport (defaults to on-device). */
  useCloud?: boolean;
}

export interface StoryHeadlineResult {
  ok: boolean;
}

/**
 * Stable dedupe key so a later wave's enqueue can avoid stacking duplicate
 * headline jobs for the same story: `story_headline:<trackedStoryId>`.
 */
export function storyHeadlineDedupeKey(trackedStoryId: string): string {
  return `story_headline:${trackedStoryId}`;
}

export async function handleStoryHeadlineJob(
  payload: StoryHeadlinePayload,
): Promise<StoryHeadlineResult> {
  const trackedStoryId = payload.trackedStoryId;
  const titles = Array.isArray(payload.titles) ? payload.titles : [];

  if (!trackedStoryId || titles.length === 0) {
    logger.warn('[story-headline] invalid payload — skipping', {
      trackedStoryId,
      titleCount: titles.length,
    });
    return { ok: false };
  }

  const { system, user } = buildStoryHeadlinePrompt(titles);

  let raw = '';
  try {
    if (payload.useCloud) {
      raw = await cloudComplete({
        systemPrompt: system,
        prompt: user,
        maxTokens: 128,
        temperature: 0.3,
      });
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
    // Transport failure — keep the fallback title (no write).
    logger.warn('[story-headline] completion failed', { error: String(err) });
    return { ok: false };
  }

  let headline: string;
  try {
    headline = parseStoryHeadlineOutput(raw);
  } catch (err) {
    // Model produced non-JSON garbage — keep the fallback title.
    logger.warn('[story-headline] parse failed', { error: String(err) });
    return { ok: false };
  }

  await setLlmHeadline(trackedStoryId, headline);
  logger.debug('[story-headline] wrote headline', { trackedStoryId });
  return { ok: true };
}
