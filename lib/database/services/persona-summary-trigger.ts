// Persona-Summary Regeneration Trigger — decides WHEN to (re)build the "About
// you" strings. Called on Profile focus (debounced) and after a chat session
// mutates facts. Computes a cheap persona fingerprint from the persisted facts;
// if it differs from the fingerprint the current strings were built for, it
// (re)generates: cloud mode runs the handler inline; on-device mode enqueues a
// single deduped queue job (so it never contends with chat for llama.rn).

import { getFacts } from './fact-service';
import {
  getLatestPersonaVersion,
  countSummaryStrings,
  replaceAllSummaryStrings,
} from './persona-summary-service';
import { enqueueJob, hasPendingJob } from './inference-job-service';
import {
  handlePersonaSummaryJob,
  type PersonaSummaryPayload,
} from '../../inference/handlers/persona-summary-handler';
import { inferenceQueue } from '../../inference/InferenceQueue';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import { ProcessingMode } from '../../generated/graphql-types';
import logger from '../../logger';

/** Stable payload marker so `hasPendingJob` can dedupe the global job. */
const DEDUPE_KEY = 'persona_summary';

/** djb2 — cheap, deterministic content hash (survives app restarts, unlike the
 *  in-memory factMutationVersion). */
function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Fingerprint the persona for summary-freshness. Built from facts only (id +
 * statement) — weight-only nudges from the sheet don't change the string TEXT,
 * so they intentionally don't force a regeneration. Add/remove/edit a fact and
 * the fingerprint changes.
 */
export async function computePersonaFingerprint(): Promise<string> {
  const facts = await getFacts();
  const parts = facts.map((f) => `${f.id}:${f.statement}`).sort();
  return `v1:${facts.length}:${djb2(parts.join('|'))}`;
}

/** Module-level guard so overlapping cloud-inline runs can't stack up. */
let inFlight = false;

/**
 * (Re)generate the persona summary strings iff the persona changed since they
 * were last built. Safe to call frequently (focus, fact mutation) — it no-ops
 * when nothing changed. Never throws.
 */
export async function maybeRegeneratePersonaSummary(): Promise<void> {
  if (inFlight) return;
  try {
    const facts = await getFacts();

    // Empty persona → clear any existing strings so the empty-state CTA shows.
    if (facts.length === 0) {
      if ((await countSummaryStrings()) > 0) {
        await replaceAllSummaryStrings([], null);
      }
      return;
    }

    const fingerprint = await computePersonaFingerprint();
    const [current, count] = await Promise.all([
      getLatestPersonaVersion(),
      countSummaryStrings(),
    ]);
    // Up to date: same fingerprint AND we actually have strings.
    if (current === fingerprint && count > 0) return;

    const useCloud =
      useMeraProtocolStore.getState().processingMode === ProcessingMode.Cloud;
    const payload: PersonaSummaryPayload = {
      useCloud,
      personaVersion: fingerprint,
      dedupeKey: DEDUPE_KEY,
    };

    if (useCloud) {
      inFlight = true;
      try {
        await handlePersonaSummaryJob(payload);
      } finally {
        inFlight = false;
      }
      return;
    }

    // On-device: enqueue a single deduped job (queue owns llama.rn access).
    if (await hasPendingJob('persona_summary', 'dedupeKey', DEDUPE_KEY)) return;
    await enqueueJob('persona_summary', payload as unknown as Record<string, unknown>);
    inferenceQueue.notify();
  } catch (err) {
    logger.warn('[persona-summary] regeneration trigger failed', { error: String(err) });
  }
}
