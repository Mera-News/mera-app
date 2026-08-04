// One-time topic-sanity backfill (r12 K-P5).
//
// The weekly sweep audits 60 topics a week, which prevents new contamination but
// would take a month to reach what is already on the device. The user asked for
// the existing mess cleaned now, WITH replacements, so this walks the whole
// corpus once — in chunks, at idle, self-disabling when finished.
//
// RESUMABILITY is the design constraint, and it is why the state is two stamps
// plus the audit cursor rather than a progress counter:
//
//   • `sanity_backfill_started_at` — the cursor was reset; the pass has begun.
//     Its presence is what stops a relaunch resetting the cursor again and
//     re-auditing from scratch every time the app starts.
//   • `sanity_audited_through_ms`  — how far the corpus has actually been
//     walked. Owned by topic-sanity-service and advanced ONLY when verdicts
//     come back, so a chunk killed mid-flight is retried, not skipped.
//   • `sanity_backfill_done_at`    — set ONLY when a chunk comes back with
//     nothing left to audit (or the hard ceiling is hit). A pass killed halfway
//     therefore cannot mark itself done: the stamp is written from the
//     completion condition, never from "we ran".
//
// Killed midway ⇒ next idle foreground resumes at the cursor. Never re-runs from
// scratch; never claims completion having processed half the corpus.

import logger from '../../logger';
import { getSetting, setSetting } from './setting-service';
import { getFacts } from './fact-service';
import { runSanityAudit, resetSanityCursor } from './topic-sanity-service';
import { addSanityProposals } from './hygiene-service';

const STARTED_KEY = 'sanity_backfill_started_at';
const DONE_KEY = 'sanity_backfill_done_at';
const AUDITED_KEY = 'sanity_backfill_audited_count';
const NOTIFIED_KEY = 'sanity_backfill_notified';

/** Topics audited per run, then yield. 60 = 4 batches in one HTTP round trip —
 *  the same shape the weekly sweep uses, so the cost per run is already known. */
export const BACKFILL_CHUNK_TOPICS = 60;

/** Hard ceiling across the WHOLE pass. A pathological corpus cannot produce an
 *  unbounded run; beyond this the remainder falls back to the weekly rhythm. */
export const SANITY_BACKFILL_MAX_TOPICS = 600;

export interface BackfillRunResult {
  ran: boolean;
  reason?: 'already_done' | 'no_facts';
  audited: number;
  proposalsAdded: number;
  done: boolean;
}

const SKIPPED = (reason: BackfillRunResult['reason']): BackfillRunResult => ({
  ran: false,
  reason,
  audited: 0,
  proposalsAdded: 0,
  done: false,
});

async function readNumber(key: string): Promise<number> {
  const raw = Number(await getSetting(key));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** True once the pass has finished — every later call is a single settings read. */
export async function isBackfillDone(): Promise<boolean> {
  return (await readNumber(DONE_KEY)) > 0;
}

/**
 * Run ONE chunk of the backfill. Safe to call on every scheduler tick: returns
 * immediately once done, and never throws.
 */
export async function runSanityBackfillChunk(opts?: {
  now?: number;
}): Promise<BackfillRunResult> {
  try {
    if (await isBackfillDone()) return SKIPPED('already_done');

    const now = opts?.now ?? Date.now();

    // Begin: reset the audit cursor so topics minted BEFORE the prompt fix are
    // re-judged. Guarded by the started stamp, or every launch would rewind.
    const startedAt = await readNumber(STARTED_KEY);
    if (startedAt === 0) {
      await resetSanityCursor();
      await setSetting(STARTED_KEY, String(now));
    }

    const facts = await getFacts();
    if (facts.length === 0) {
      // Nothing to judge topics against; don't burn the once-only flag on it.
      return SKIPPED('no_facts');
    }

    const result = await runSanityAudit({
      facts: facts.map((f) => ({ id: f.id, statement: f.statement })),
      maxTopics: BACKFILL_CHUNK_TOPICS,
    });

    const auditedTotal = (await readNumber(AUDITED_KEY)) + result.audited;
    await setSetting(AUDITED_KEY, String(auditedTotal));

    let proposalsAdded = 0;
    if (result.incoherentFacts.length > 0) {
      // Notify ONCE for the whole pass, on the first chunk that finds anything —
      // not once per chunk, which would be a notification storm.
      const alreadyNotified = (await getSetting(NOTIFIED_KEY)) === '1';
      proposalsAdded = await addSanityProposals(result.incoherentFacts, {
        notify: !alreadyNotified,
        now,
      });
      if (!alreadyNotified && proposalsAdded > 0) {
        await setSetting(NOTIFIED_KEY, '1');
      }
    }

    // COMPLETION, derived — never "we ran, so we're done". A chunk that audited
    // nothing means the cursor has reached the newest topic.
    const exhausted = result.audited === 0;
    const hitCeiling = auditedTotal >= SANITY_BACKFILL_MAX_TOPICS;
    const done = exhausted || hitCeiling;
    if (done) {
      await setSetting(DONE_KEY, String(now));
      logger.debug('[sanity-backfill] complete', {
        auditedTotal,
        reason: exhausted ? 'exhausted' : 'ceiling',
      });
    }

    return { ran: true, audited: result.audited, proposalsAdded, done };
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'sanity-backfill-service', method: 'runSanityBackfillChunk' },
    });
    // Deliberately NOT marking done — a failed chunk is retried next tick.
    return { ran: false, audited: 0, proposalsAdded: 0, done: false };
  }
}
