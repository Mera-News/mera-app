// Handler for track_proposal jobs — turns a tapped article into ONE sentence
// describing what ongoing topic to track. Mirrors the story-headline handler's
// shape (input → LLM → strict JSON), but its result is consumed INTERACTIVELY
// by the TrackProposalSheet, so the real work lives in `runTrackProposal`, a
// direct complete-primitive call (cloud with local fallback) the sheet awaits.
// The queue handler + dedupe key exist for registration/completeness; the open
// sheet never routes through the FIFO queue (a queue round-trip can't hand a
// value back to an awaiting UI, and it would contend with chat for llama.rn).

import { cloudComplete } from '../../llm/cloudComplete';
import { completeLocal } from '../../llm/completeLocal';
import {
  buildTrackProposalPrompt,
  parseTrackProposalOutput,
  type TrackProposalInput,
} from '../../news-harness/track-proposal';
import logger from '../../logger';

export interface TrackProposalPayload extends TrackProposalInput {
  /** The article the proposal is for — dedupe key + interactive correlation. */
  articleId: string;
  /** Cloud vs on-device transport (defaults to on-device). */
  useCloud?: boolean;
}

export interface TrackProposalResult {
  ok: boolean;
  /** The proposal text on success (empty on failure). */
  track: string;
}

/**
 * Stable dedupe key so a queue enqueue never stacks duplicate proposal jobs for
 * the same article: `track_proposal:<articleId>`.
 */
export function trackProposalDedupeKey(articleId: string): string {
  return `track_proposal:${articleId}`;
}

/**
 * Run ONE track-proposal round and return the proposal text. This is the
 * interactive primitive the sheet awaits directly. Cloud path = one E2EE
 * completion; on-device path = one local completion. Throws on transport or
 * parse failure so the sheet can show its retry state.
 */
export async function runTrackProposal(
  input: TrackProposalInput,
  useCloud: boolean,
): Promise<string> {
  const { system, user } = buildTrackProposalPrompt(input);

  const raw = useCloud
    ? await cloudComplete({
        systemPrompt: system,
        prompt: user,
        maxTokens: 128,
        temperature: 0.4,
      })
    : await completeLocal({
        systemPrompt: system,
        prompt: user,
        maxTokens: 128,
        temperature: 0.4,
        responseFormat: 'json',
        enableThinking: false,
      });

  return parseTrackProposalOutput(raw);
}

/**
 * Queue-handler wrapper (registered in InferenceQueue's JOB_HANDLERS). Never
 * throws — a transport/parse failure resolves `{ ok: false, track: '' }` so the
 * queue records a benign result rather than a retry storm.
 */
export async function handleTrackProposalJob(
  payload: TrackProposalPayload,
): Promise<TrackProposalResult> {
  if (!payload?.articleId || !payload?.title) {
    logger.warn('[track-proposal] invalid payload — skipping', {
      articleId: payload?.articleId,
    });
    return { ok: false, track: '' };
  }
  try {
    const track = await runTrackProposal(payload, !!payload.useCloud);
    return { ok: true, track };
  } catch (err) {
    logger.warn('[track-proposal] generation failed', { error: String(err) });
    return { ok: false, track: '' };
  }
}
