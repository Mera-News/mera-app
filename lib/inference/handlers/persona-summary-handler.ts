// Handler for persona_summary jobs — turns the on-device persona (facts + their
// generated topics) into 4–8 plain-language "About you" strings and writes them
// to `persona_summary_strings`. Cloud path = one E2EE completion; on-device path
// = one local completion. Mirrors the topic-gen handler's shape (persona → LLM →
// strict JSON → write table) and reuses the queue's retry mechanics.

import { getFacts, getFactSectionSnapshots } from '../../database/services/fact-service';
import { getActiveTopicSnapshots } from '../../database/services/topic-service';
import { replaceAllSummaryStrings } from '../../database/services/persona-summary-service';
import { cloudComplete } from '../../llm/cloudComplete';
import { completeLocal } from '../../llm/completeLocal';
import {
  assemblePersonaSummaryStrings,
  buildPersonaSummaryPrompt,
  parsePersonaSummaryOutput,
  selectFactsForSummary,
  type PersonaSummaryFactInput,
} from '../../news-harness/persona-summary';
import logger from '../../logger';

export interface PersonaSummaryPayload {
  useCloud?: boolean;
  /** Persona fingerprint the strings are generated for (dedupe + freshness). */
  personaVersion?: string;
  /** Stable marker so `hasPendingJob` can dedupe a global persona_summary job. */
  dedupeKey?: string;
}

export interface PersonaSummaryResult {
  count: number;
}

/**
 * Assemble the LLM input from the persisted persona: every fact with its weight
 * and the ids of the active topic rows it owns. RN-coupled (reads WatermelonDB);
 * the pure selection/prompt/parse/assemble live in the harness.
 */
export async function buildPersonaSummaryInputs(): Promise<PersonaSummaryFactInput[]> {
  const [facts, factSnaps, topicSnaps] = await Promise.all([
    getFacts(),
    getFactSectionSnapshots(),
    getActiveTopicSnapshots(),
  ]);

  const weightById = new Map(factSnaps.map((s) => [s.id, s.weight ?? 1]));
  const topicsByFact = new Map<string, string[]>();
  for (const t of topicSnaps) {
    if (!t.factId) continue;
    const arr = topicsByFact.get(t.factId);
    if (arr) arr.push(t.id);
    else topicsByFact.set(t.factId, [t.id]);
  }

  return facts.map((f) => ({
    factId: f.id,
    statement: f.statement,
    weight: weightById.get(f.id) ?? 1,
    topicIds: topicsByFact.get(f.id) ?? [],
  }));
}

export async function handlePersonaSummaryJob(
  payload: PersonaSummaryPayload,
): Promise<PersonaSummaryResult> {
  const personaVersion = payload.personaVersion ?? null;
  const inputs = await buildPersonaSummaryInputs();

  // Empty persona → clear any stale strings so the empty-state CTA shows.
  if (inputs.length === 0) {
    await replaceAllSummaryStrings([], personaVersion);
    return { count: 0 };
  }

  const selected = selectFactsForSummary(inputs);
  const { system, user } = buildPersonaSummaryPrompt(selected);

  let raw = '';
  try {
    if (payload.useCloud) {
      raw = await cloudComplete({
        systemPrompt: system,
        prompt: user,
        maxTokens: 512,
        temperature: 0.4,
      });
    } else {
      raw = await completeLocal({
        systemPrompt: system,
        prompt: user,
        maxTokens: 512,
        temperature: 0.4,
        responseFormat: 'json',
        enableThinking: false,
      });
    }
  } catch (err) {
    // Transport failure — keep the previous strings (no wipe).
    logger.warn('[persona-summary] completion failed', { error: String(err) });
    return { count: 0 };
  }

  let results;
  try {
    const drafts = parsePersonaSummaryOutput(raw);
    results = assemblePersonaSummaryStrings(drafts, selected);
  } catch (err) {
    // Model produced non-JSON garbage — keep the previous strings.
    logger.warn('[persona-summary] parse failed', { error: String(err) });
    return { count: 0 };
  }

  if (results.length === 0) {
    logger.debug('[persona-summary] no usable strings produced; keeping previous');
    return { count: 0 };
  }

  await replaceAllSummaryStrings(results, personaVersion);
  logger.debug('[persona-summary] wrote strings', { count: results.length });
  return { count: results.length };
}
