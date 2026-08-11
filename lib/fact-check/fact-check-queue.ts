/**
 * The fact-check queue: the seam between "the user picked a claim" and "a job
 * is running".
 *
 * MODULE-LEVEL, NOT A COMPONENT EFFECT. The whole point of the pivot is that
 * the check runs in the background while the user keeps reading — so the
 * in-flight map has to outlive the screen that started it. Navigating away,
 * collapsing the chat, or unmounting the panel must not cancel the job or start
 * a second one.
 *
 * TWO LAYERS OF DEDUPE, and they answer different questions:
 *   - the in-memory `Map<key, Promise>` answers "is a run happening RIGHT NOW",
 *     which survives navigation but not a process death;
 *   - the WatermelonDB row answers "is there a result", which survives
 *     everything. `fact-check-recover-task.ts` re-drives rows the map has
 *     forgotten because the app was killed.
 *
 * `enqueueFactCheck` writes the row `processing` and RETURNS — it never awaits
 * the run. The user is never blocked; F1's proposal handler calls it from a
 * chat tap and gets its ids back in milliseconds.
 */

import {
  getFactCheckForClaim,
  upsertFactCheck,
} from '../database/services/fact-check-record-service';
import logger from '../logger';
import { runFactCheck, type FactCheckJob, type FactCheckPayload } from './fact-check-runner';

/**
 * Row statuses this feature writes.
 *
 * `processing` is deliberately NOT one of `fact-check-state.ts`'s documented
 * server statuses, and that file is not ours to edit. It does not need to be:
 * `isTerminalStatus` treats anything outside {complete, blocked} as "not
 * answered yet", which is exactly right, and the column is a plain string.
 */
export const FACT_CHECK_STATUS = {
  processing: 'processing',
  complete: 'complete',
  blocked: 'blocked',
  failed: 'failed',
} as const;

/**
 * Claim text → the stable key half of `(article_id, claim_key)`.
 *
 * Normalisation is what makes the key stable: the same assertion re-picked
 * later, with different casing, spacing or trailing punctuation, must land on
 * the same row rather than duplicating the answer. FNV-1a plus the normalised
 * length — collisions only matter WITHIN one article (a handful of claims), and
 * a 32-bit hash with a length discriminator is far past sufficient there.
 */
export function computeClaimKey(claim: string): string {
  const normalised = (claim ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalised.length; i++) {
    hash ^= normalised.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}${normalised.length.toString(36)}`;
}

/** Device-local stand-in for the server row's `_id`, and deterministic on
 *  purpose: re-enqueueing the same claim reuses the same identity instead of
 *  minting a second one for the same row. */
export function factCheckIdFor(articleId: string, claimKey: string): string {
  return `local:${articleId}:${claimKey}`;
}

export interface EnqueueFactCheckInput {
  articleId: string;
  articleTitle: string;
  articleUrl?: string;
  publicationName?: string;
  /** The exact claim text the user picked. */
  claim: string;
}

const inFlight = new Map<string, Promise<void>>();

function flightKey(articleId: string, claimKey: string): string {
  return `${articleId}::${claimKey}`;
}

/** True while a run for this claim is actually executing in this process. The
 *  recovery task consults it so a foreground event mid-run cannot double-drive
 *  the same row. */
export function isFactCheckInFlight(articleId: string, claimKey: string): boolean {
  return inFlight.has(flightKey(articleId, claimKey));
}

/** Current UI language as BCP-47, for the ClaimReview lookup. Lazily required:
 *  the queue must stay importable in a plain Node/jest context, and i18n drags
 *  in the whole locale bundle. */
function currentLanguageCode(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate, see above.
    const i18n = require('../i18n').default as { language?: string };
    const lang = i18n?.language;
    return typeof lang === 'string' && lang.length > 0 ? lang : undefined;
  } catch {
    return undefined;
  }
}

/** Starts the run and books it into the in-flight map. Never throws, never
 *  awaited by the caller. The `.catch` is attached HERE rather than at the call
 *  site so the stored promise can never become an unhandled rejection. */
function launch(job: FactCheckJob): void {
  const key = flightKey(job.articleId, job.claimKey);
  if (inFlight.has(key)) return;
  const run = runFactCheck(job)
    .then(() => undefined)
    .catch((err: unknown) => {
      logger.captureException(err, {
        tags: { service: 'fact-check-queue', method: 'runFactCheck' },
        extra: { articleId: job.articleId },
      });
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, run);
}

/**
 * Stage a check and return immediately.
 *
 * THE CONTRACT F1 CODES AGAINST — the signature is fixed. It always resolves
 * with usable ids, even if the row write fails: the caller is a chat proposal
 * handler that has already told the user "checking this", and a rejected
 * promise there would surface as a broken tap rather than as a failed check
 * (which is what the row's own status is for).
 *
 * Re-enqueueing a claim that already has a COMPLETE row is a no-op — the answer
 * is already on the device. Everything else is re-driven, which is what makes
 * "tap again" a working retry.
 *
 * `blocked` is deliberately in the re-driven set even though it is terminal for
 * the RENDER. Its causes are a gateway 503, a 429, a dead route — transient
 * conditions that will very often have cleared by the time the user taps again.
 * Making it permanent would mean one blip silently retires that claim forever,
 * which is the stranded-row failure this queue exists to avoid, dressed up as a
 * status. Terminal means "stop the automation" (the recovery task will not
 * touch it, and `MAX_FACT_CHECK_ATTEMPTS` bounds that), not "refuse the human".
 * A user-initiated retry therefore also RESETS the attempt count: the person is
 * asking again, which is not the loop the cap exists to stop.
 */
export async function enqueueFactCheck(input: EnqueueFactCheckInput): Promise<{
  factCheckId: string;
  claimKey: string;
}> {
  const articleId = String(input?.articleId ?? '');
  const claim = String(input?.claim ?? '').trim();
  const claimKey = computeClaimKey(claim);
  const factCheckId = factCheckIdFor(articleId, claimKey);

  try {
    if (!articleId || claim.length === 0) {
      logger.warn('[fact-check] enqueue ignored: missing article or claim');
      return { factCheckId, claimKey };
    }

    const existing = await getFactCheckForClaim(articleId, claimKey);
    if (existing && existing.status === FACT_CHECK_STATUS.complete) {
      return { factCheckId, claimKey };
    }
    if (isFactCheckInFlight(articleId, claimKey)) {
      return { factCheckId, claimKey };
    }

    // The row lands BEFORE the run starts, so the panel can render "checking…"
    // on the very next frame and a process death leaves something recoverable.
    const payload: FactCheckPayload = {
      _id: factCheckId,
      articleTitle: input.articleTitle ?? null,
      articleUrl: input.articleUrl ?? null,
      publicationName: input.publicationName ?? null,
      status: FACT_CHECK_STATUS.processing,
      verdict: null,
      summary: null,
      claims: [],
      checkedBy: [],
      // We have not asked anybody yet. The fail-safe value, so a row rendered
      // mid-run can never read as "no fact-checker has published on this".
      checkedByStatus: 'unavailable',
      citations: [],
      createdAt: new Date().toISOString(),
      completedAt: null,
      claim,
      attempts: 0,
      startedAt: Date.now(),
    };
    await upsertFactCheck({
      articleId,
      factCheckId,
      articleTitle: input.articleTitle ?? null,
      claim,
      claimKey,
      status: FACT_CHECK_STATUS.processing,
      verdict: null,
      payload,
    });

    launch({
      factCheckId,
      articleId,
      claim,
      claimKey,
      articleTitle: input.articleTitle,
      articleUrl: input.articleUrl,
      publicationName: input.publicationName,
      languageCode: currentLanguageCode(),
      // A blocked row is being retried BY THE USER, so the attempt budget
      // starts over — the cap bounds the recovery task's automation, not a
      // person asking again. Any other row carries its count forward.
      attempts: existing?.status === FACT_CHECK_STATUS.blocked
        ? 0
        : (existing?.payload?.attempts ?? 0),
    });
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'fact-check-queue', method: 'enqueueFactCheck' },
      extra: { articleId },
    });
  }

  return { factCheckId, claimKey };
}

/**
 * Re-drive a row that is already on the device — the recovery task's entry
 * point. Everything the run needs is reconstructed from the stored payload,
 * because by definition the screen that started it is long gone.
 */
export function redriveFactCheck(row: {
  articleId: string;
  claim: string | null;
  claimKey: string | null;
  factCheckId: string;
  articleTitle: string | null;
  payload: Partial<FactCheckPayload> | null;
}): boolean {
  const claim = (row.claim ?? row.payload?.claim ?? '').trim();
  // A legacy (v51) row has no claim text at all, so there is nothing to check.
  // Re-driving it would be a guess about what the user asked.
  if (!row.articleId || claim.length === 0 || !row.claimKey) return false;
  if (isFactCheckInFlight(row.articleId, row.claimKey)) return false;
  launch({
    factCheckId: row.factCheckId || factCheckIdFor(row.articleId, row.claimKey),
    articleId: row.articleId,
    claim,
    claimKey: row.claimKey,
    articleTitle: row.articleTitle ?? row.payload?.articleTitle ?? undefined,
    articleUrl: row.payload?.articleUrl ?? undefined,
    publicationName: row.payload?.publicationName ?? undefined,
    languageCode: currentLanguageCode(),
    attempts: row.payload?.attempts ?? 0,
  });
  return true;
}

/** Test seam — the in-flight map is module state and would leak across specs. */
export function __resetFactCheckQueueForTests(): void {
  inFlight.clear();
}
