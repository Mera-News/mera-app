// Topic Replacement Service — the "replace, don't just delete" half of the r12
// topic-sanity pass (K-P5).
//
// When the user accepts an `incoherent_topics` proposal, the contaminated topics
// must not simply vanish: the fact would lose coverage it never asked to lose.
// So replacements are generated FIRST, and only once they are in hand are the
// bad topics retired — in the same database write.
//
// Reuses J's combo-only builder rather than a third generation path, so the
// scheduled top-up and this one-shot replacement can never drift apart in
// prompt, budget, dedupe, or provenance.

import logger from '../../logger';
import { cloudBatchComplete } from '../../llm/cloudComplete';
import { appHarnessLogger } from '@/lib/news-harness-app/logger-adapter';
import {
  selectTopupCandidates,
  buildComboOnlyBatchCall,
  planTopupTopicRows,
} from '../../news-harness/persona-management/topic-topup';
import { parseTopicsFromOutput } from '../../news-harness/persona-management/topic-generation';
import { getFacts } from './fact-service';
import { appendFactMetadataTopics } from './fact-service';
import {
  getAllNormalizedTexts,
  getTopupTopicSnapshots,
  normalizeTopicText,
  replaceTopicsForFact,
  type ReplaceTopicsResult,
} from './topic-service';

export interface ReplaceOutcome {
  /** False ⇒ the caller must NOT proceed with any removal. */
  ok: boolean;
  minted: number;
  retired: number;
  /** True when the retire was withheld to stop the fact going dark. */
  floorHeld: boolean;
}

const FAILED: ReplaceOutcome = { ok: false, minted: 0, retired: 0, floorHeld: false };

function toEpochMs(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Generate replacements for `factId`, then retire `retireTopicIds` — atomically.
 *
 * Ordering is the safety property, not an implementation detail:
 *   1. generate (network). ANY failure here returns ok:false having changed
 *      NOTHING — no mint, no retire, no metadata write. The caller leaves the
 *      proposal pending and the user is exactly where they started.
 *   2. plan rows against the GLOBAL exclusion set (every status, every
 *      provenance) so a replacement can never collide with a `tracked` topic's
 *      text — that collision would make a followed story's articles metered
 *      again, which is live prod behaviour now, not a hypothetical.
 *   3. mint + retire in ONE write (see replaceTopicsForFact).
 *
 * Never throws.
 */
export async function generateAndReplace(
  factId: string,
  fillTo: number,
  retireTopicIds: string[],
): Promise<ReplaceOutcome> {
  try {
    const [facts, topicRows, globalTexts] = await Promise.all([
      getFacts(),
      getTopupTopicSnapshots(),
      getAllNormalizedTexts(),
    ]);

    const target = facts.find((f) => f.id === factId);
    if (!target) return FAILED;

    const [candidate] = selectTopupCandidates(
      facts.map((f) => ({
        id: f.id,
        statement: f.statement,
        // Fact.createdAt is an ISO string (mera-protocol-toolkit types), not a
        // Date — unlike the WatermelonDB models. NaN would poison the ordering,
        // so an unparseable value degrades to 0 (treated as oldest).
        createdAtMs: toEpochMs(f.createdAt),
      })),
      topicRows,
      {
        mode: 'fillTo',
        fillTargets: new Map([[factId, fillTo]]),
        maxFacts: 1,
        // The proposal already decided how much coverage to restore; the
        // per-sweep per-fact cap governs the scheduled path, not this one.
        maxTopicsPerFact: Math.max(1, fillTo),
      },
    );

    // No candidate ⇒ nothing to generate (already at target, or no supporting
    // facts). That is NOT a failure: retiring is still safe because the fact
    // keeps whatever it has, and the floor in replaceTopicsForFact protects it.
    if (!candidate) {
      const res = await replaceTopicsForFact(factId, [], retireTopicIds);
      return summarise(res);
    }

    const call = buildComboOnlyBatchCall(candidate);
    const [result] = await cloudBatchComplete([call]);

    // Step 1 failure ⇒ change nothing at all.
    if (!result || result.error) {
      logger.warn('[topic-replacement] generation failed — nothing changed', {
        factId,
        error: result?.error ?? 'no result',
      });
      return FAILED;
    }

    const texts = parseTopicsFromOutput(
      result.output,
      target.statement,
      appHarnessLogger,
    );

    const planned = planTopupTopicRows(globalTexts, texts, normalizeTopicText);

    const res = await replaceTopicsForFact(factId, planned, retireTopicIds);

    // Keep the legacy metadata list in step for unmigrated devices. Append-only
    // (updateFact replaces metadata wholesale, so a naive write would drop it).
    if (res.minted.length > 0) {
      await appendFactMetadataTopics(
        factId,
        res.minted.map((t) => t.text),
      ).catch((err: unknown) =>
        logger.warn('[topic-replacement] metadata append failed', {
          factId,
          error: String(err),
        }),
      );
    }

    return summarise(res);
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'topic-replacement-service', method: 'generateAndReplace' },
    });
    return FAILED;
  }
}

function summarise(res: ReplaceTopicsResult): ReplaceOutcome {
  return {
    ok: true,
    minted: res.minted.length,
    retired: res.retired.length,
    floorHeld: res.floorHeld,
  };
}
