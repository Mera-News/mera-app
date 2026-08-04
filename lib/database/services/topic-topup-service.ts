// Topic Top-up Service — the weekly fact-combination sweep step (r12 J-P3).
//
// Topic generation is point-in-time: a topic minted from fact A (plus whatever
// facts existed alongside it) never revisits that decision. Add fact B later and
// the richer A×B topic is never created. This walks the persona once a week and
// appends the topics that would have existed had the facts arrived together.
//
// APPEND-ONLY and UNATTENDED — the user asked for it to be automatic, so it must
// never mutate, re-weight, retire, or delete an existing row. It is also the
// first thing in the app that mints topics with nobody watching, which is why
// the guards below are wider than a chat-driven generation would need.

import logger from '../../logger';
import { cloudBatchComplete } from '../../llm/cloudComplete';
import { appHarnessLogger } from '@/lib/news-harness-app/logger-adapter';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import { ProcessingMode } from '../../generated/graphql-types';
import { isTopicGenerationInFlight } from '../../chat-tools/tool-handlers';
import {
  selectTopupCandidates,
  buildComboOnlyBatchCall,
  planTopupTopicRows,
  type TopupCandidate,
} from '../../news-harness/persona-management/topic-topup';
import { parseTopicsFromOutput } from '../../news-harness/persona-management/topic-generation';
import { getFacts, appendFactMetadataTopics } from './fact-service';
import {
  getAllNormalizedTexts,
  getTopupTopicSnapshots,
  normalizeTopicText,
  appendTopupTopicsForFact,
} from './topic-service';
import { getSetting, setSetting } from './setting-service';

const STATE_KEY = 'topic_topup_state';

/** Cap the per-fact watermark blob so KV can't grow unbounded (mirrors the
 *  hygiene rejected-fingerprint cap). */
const MAX_TRACKED_FACTS = 200;

interface TopupState {
  /** factId → the epoch ms this fact was last CONSIDERED (not last minted). */
  byFact: Record<string, number>;
  lastRunAt: number;
}

export interface TopupResult {
  ran: boolean;
  reason?: 'not_cloud' | 'no_candidates' | 'batch_failed';
  /** Facts considered this run — the watermark advanced for all of them. */
  considered: number;
  /** Rows actually minted. */
  appended: number;
}

const SKIPPED = (reason: TopupResult['reason']): TopupResult => ({
  ran: false,
  reason,
  considered: 0,
  appended: 0,
});

async function readState(): Promise<TopupState> {
  const raw = await getSetting(STATE_KEY);
  if (!raw) return { byFact: {}, lastRunAt: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<TopupState>;
    return {
      byFact:
        parsed.byFact && typeof parsed.byFact === 'object' ? parsed.byFact : {},
      lastRunAt: typeof parsed.lastRunAt === 'number' ? parsed.lastRunAt : 0,
    };
  } catch {
    return { byFact: {}, lastRunAt: 0 };
  }
}

async function writeState(state: TopupState, liveFactIds: Set<string>): Promise<void> {
  // Prune to live facts so deleting a fact reclaims its slot, then cap.
  const entries = Object.entries(state.byFact).filter(([id]) => liveFactIds.has(id));
  const capped = entries.slice(-MAX_TRACKED_FACTS);
  await setSetting(
    STATE_KEY,
    JSON.stringify({ byFact: Object.fromEntries(capped), lastRunAt: state.lastRunAt }),
  );
}

/**
 * Run one weekly top-up pass. Never throws.
 *
 * @param excludeFactIds facts a hygiene proposal is about to delete — topping up
 *   a doomed fact is wasted spend and would briefly widen a feed the user is
 *   about to narrow.
 */
export async function runTopicTopup(opts?: {
  now?: number;
  excludeFactIds?: Set<string>;
}): Promise<TopupResult> {
  try {
    // CLOUD ONLY. The on-device path would queue llama.rn jobs behind the user's
    // own work on a device already running warm, for a background nicety.
    if (useMeraProtocolStore.getState().processingMode !== ProcessingMode.Cloud) {
      return SKIPPED('not_cloud');
    }

    const now = opts?.now ?? Date.now();
    const [facts, topicRows, globalTexts, state] = await Promise.all([
      getFacts(),
      getTopupTopicSnapshots(),
      getAllNormalizedTexts(),
      readState(),
    ]);
    if (facts.length === 0) return SKIPPED('no_candidates');

    const liveFactIds = new Set(facts.map((f) => f.id));

    // Skip facts whose generation is mid-flight — a chat save racing this sweep
    // would otherwise produce two concurrent batches for the same fact.
    const excluded = new Set(opts?.excludeFactIds ?? []);
    for (const f of facts) {
      if (isTopicGenerationInFlight(f.id)) excluded.add(f.id);
    }

    const candidates = selectTopupCandidates(
      facts.map((f) => ({
        id: f.id,
        statement: f.statement,
        createdAtMs: toEpochMs(f.createdAt),
      })),
      topicRows,
      {
        mode: 'watermark',
        consideredThroughByFact: new Map(Object.entries(state.byFact)),
        excludeFactIds: excluded,
        nowMs: now,
      },
    );
    if (candidates.length === 0) {
      state.lastRunAt = now;
      await writeState(state, liveFactIds);
      return SKIPPED('no_candidates');
    }

    // ONE HTTP round trip for the whole sweep (<= 4 combo-only calls).
    const calls = candidates.map((c) => buildComboOnlyBatchCall(c));
    let results;
    try {
      results = await cloudBatchComplete(calls);
    } catch (err) {
      logger.warn('[topic-topup] batch failed — watermarks not advanced', {
        error: String(err),
      });
      return SKIPPED('batch_failed');
    }

    const byId = new Map(results.map((r) => [r.id, r]));
    // One growing exclusion set across the whole run, so two candidates in the
    // same sweep cannot mint the same text as each other.
    const seenTexts = new Set(globalTexts);
    let appended = 0;

    for (const candidate of candidates) {
      appended += await applyCandidate(candidate, byId, seenTexts);
      // ADVANCE REGARDLESS of outcome. This is the idempotency mechanism: a
      // fact considered against today's fact set is never re-considered against
      // the SAME set — including when the model returned [], everything
      // deduped, or that half errored. Only a genuinely newer fact re-opens it.
      state.byFact[candidate.factId] = candidate.consideredThroughMs;
    }

    state.lastRunAt = now;
    await writeState(state, liveFactIds);

    logger.debug('[topic-topup] complete', {
      considered: candidates.length,
      appended,
    });
    return { ran: true, considered: candidates.length, appended };
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'topic-topup-service', method: 'runTopicTopup' },
    });
    return SKIPPED('batch_failed');
  }
}

async function applyCandidate(
  candidate: TopupCandidate,
  byId: Map<string, { output: string; error?: string }>,
  seenTexts: Set<string>,
): Promise<number> {
  const result = byId.get(`topup:${candidate.factId}`);
  if (!result || result.error) {
    logger.warn('[topic-topup] half failed', {
      factId: candidate.factId,
      error: result?.error ?? 'no result',
    });
    return 0;
  }

  const texts = parseTopicsFromOutput(
    result.output,
    candidate.statement,
    appHarnessLogger,
  );
  if (texts.length === 0) return 0;

  // GLOBAL exclusion — every status, every provenance, every fact. Critically
  // this includes `tracked` texts: tracked-topic articles hydrate through a
  // quota-exempt path (live in prod), so minting a metered row carrying a text a
  // followed story already owns would silently make that story billable again.
  // It also blocks re-appending what the sanity pass just got the user to retire.
  const planned = planTopupTopicRows(seenTexts, texts, normalizeTopicText);
  if (planned.length === 0) return 0;

  const created = await appendTopupTopicsForFact(candidate.factId, planned);
  for (const p of planned) seenTexts.add(p.normalizedText);

  if (created.length > 0) {
    // Keep the legacy metadata list in step for unmigrated devices. APPEND —
    // Fact.updateFact replaces metadata wholesale, so a naive write drops it.
    await appendFactMetadataTopics(
      candidate.factId,
      created.map((t) => t.text),
    ).catch((err: unknown) =>
      logger.warn('[topic-topup] metadata append failed', {
        factId: candidate.factId,
        error: String(err),
      }),
    );
  }
  return created.length;
}

function toEpochMs(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}
