// feedback-request-state: what THIS device knows about each feedback request.
//
// ONE settings row, `feedback_requests_state`, holding
//   { [requestId]: { question, endsAt (ms), shownAt?, answeredAt?, dismissedAt? } }
// No table, no migration. The row is wiped with the rest of `settings` on an
// account switch, which is correct: the next account starts with nothing
// shown and nothing answered, and the next sync rebuilds it from the server.
//
// DEVICE-ONLY BY DESIGN. Whether a question was shown, opened or skipped never
// leaves the device (no behavioural instrumentation, ever). The server learns
// one thing only: an answer, when the reader sends one.
//
// SERIALIZED WRITES. The sync task, the auto-show host, the modal and the
// drawer all read-modify-write the same row. Every write goes through one
// promise chain and re-reads the row inside it, so a sync upsert can never
// overwrite a shownAt or answeredAt stamped a moment earlier. There is no
// memory mirror on purpose: a mirror would outlive the settings wipe on an
// account switch and hand the previous account's stamps to the next one.
//
// IMPORT DISCIPLINE. The notifications screen and the auto-show host import
// this, so setting-service (and with it the SQLite singleton) is lazy-required
// at the call site, the lib/app-restart.ts rule.

import logger from '@/lib/logger';

export const FEEDBACK_REQUESTS_STATE_KEY = 'feedback_requests_state';

/** Entries whose question ended longer ago than this are dropped on the next
 *  write. Matches the notifications table's 90-day TTL, so a drawer row never
 *  outlives the state that tells it "Answered" or "Closed" by much. */
export const FEEDBACK_REQUEST_STATE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface FeedbackRequestEntry {
  /** Localized question text, refreshed on every sync. */
  question: string;
  /** Epoch ms the request closes. */
  endsAt: number;
  /** Epoch ms the modal was first presented on this device, by any path. */
  shownAt?: number;
  /** Epoch ms the answer was accepted (here or, per the server, elsewhere). */
  answeredAt?: number;
  /** Epoch ms the reader closed the modal without answering. */
  dismissedAt?: number;
}

export type FeedbackRequestsState = Record<string, FeedbackRequestEntry>;

type Listener = () => void;

const listeners = new Set<Listener>();
let chain: Promise<unknown> = Promise.resolve();

function settings(): typeof import('@/lib/database/services/setting-service') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/database/services/setting-service');
}

function stamp(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Row text -> state. A corrupt row, or a corrupt entry, is the same as none. */
export function parseFeedbackRequestsState(raw: string | null | undefined): FeedbackRequestsState {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: FeedbackRequestsState = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const e = value as Record<string, unknown>;
    const endsAt = stamp(e.endsAt);
    if (typeof e.question !== 'string' || endsAt === undefined) continue;
    const entry: FeedbackRequestEntry = { question: e.question, endsAt };
    const shownAt = stamp(e.shownAt);
    const answeredAt = stamp(e.answeredAt);
    const dismissedAt = stamp(e.dismissedAt);
    if (shownAt !== undefined) entry.shownAt = shownAt;
    if (answeredAt !== undefined) entry.answeredAt = answeredAt;
    if (dismissedAt !== undefined) entry.dismissedAt = dismissedAt;
    out[id] = entry;
  }
  return out;
}

async function readRow(): Promise<FeedbackRequestsState> {
  try {
    return parseFeedbackRequestsState(await settings().getSetting(FEEDBACK_REQUESTS_STATE_KEY));
  } catch (err) {
    logger.captureException(err, {
      tags: { module: 'feedback-request-state', method: 'read' },
    });
    return {};
  }
}

/**
 * The current state. Waits for any write already queued, so a read right after
 * a stamp sees it. Never throws; an unreadable row reads as empty.
 */
export async function readFeedbackRequestsState(): Promise<FeedbackRequestsState> {
  await chain.catch(() => undefined);
  return readRow();
}

/**
 * Read-modify-write the row, serialized with every other write. The mutator
 * edits a fresh copy in place. Entries that ended more than
 * {@link FEEDBACK_REQUEST_STATE_RETENTION_MS} ago are pruned. Listeners hear
 * about every successful write. Never throws: a failed write is reported and
 * resolves with the state as it was.
 */
export function updateFeedbackRequestsState(
  mutate: (state: FeedbackRequestsState) => void,
  now: number = Date.now(),
): Promise<FeedbackRequestsState> {
  const run = chain.catch(() => undefined).then(async () => {
    const before = await readRow();
    const next: FeedbackRequestsState = {};
    for (const [id, e] of Object.entries(before)) next[id] = { ...e };
    mutate(next);
    for (const [id, e] of Object.entries(next)) {
      if (e.endsAt < now - FEEDBACK_REQUEST_STATE_RETENTION_MS) delete next[id];
    }
    try {
      await settings().setSetting(FEEDBACK_REQUESTS_STATE_KEY, JSON.stringify(next));
    } catch (err) {
      logger.captureException(err, {
        tags: { module: 'feedback-request-state', method: 'write' },
      });
      return before;
    }
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One broken listener must not stop the rest.
      }
    }
    return next;
  });
  chain = run;
  return run;
}

/** Called after every successful write. Returns the unsubscribe. */
export function subscribeFeedbackRequestsState(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isFeedbackRequestEnded(entry: Pick<FeedbackRequestEntry, 'endsAt'>, now: number = Date.now()): boolean {
  return entry.endsAt <= now;
}

/**
 * The request the auto-show host should present, or null: never shown, never
 * answered, never dismissed and still open. The one closing soonest wins, so
 * a short window is not lost behind a long one. Pure.
 */
export function pickAutoShowCandidate(
  state: FeedbackRequestsState,
  now: number = Date.now(),
): string | null {
  let best: string | null = null;
  let bestEndsAt = Infinity;
  for (const [id, e] of Object.entries(state)) {
    if (e.shownAt !== undefined || e.answeredAt !== undefined || e.dismissedAt !== undefined) continue;
    if (isFeedbackRequestEnded(e, now)) continue;
    if (e.endsAt < bestEndsAt) {
      best = id;
      bestEndsAt = e.endsAt;
    }
  }
  return best;
}

/**
 * Stamp shownAt once (the first presentation wins, by any path). With `seed`,
 * an entry the device has never synced is created from it, so a push tap that
 * beats the first sync still records that it was shown. Returns whether the
 * entry exists afterwards.
 */
export async function markFeedbackRequestShown(
  id: string,
  now: number = Date.now(),
  seed?: Pick<FeedbackRequestEntry, 'question' | 'endsAt'>,
): Promise<boolean> {
  const state = await updateFeedbackRequestsState((s) => {
    const e = s[id] ?? (seed ? { question: seed.question, endsAt: seed.endsAt } : undefined);
    if (!e) return;
    if (e.shownAt === undefined) e.shownAt = now;
    s[id] = e;
  }, now);
  return state[id] !== undefined;
}

/** The reader closed the modal without answering. First stamp wins. */
export async function markFeedbackRequestDismissed(id: string, now: number = Date.now()): Promise<void> {
  await updateFeedbackRequestsState((s) => {
    const e = s[id];
    if (e && e.dismissedAt === undefined && e.answeredAt === undefined) e.dismissedAt = now;
  }, now);
}

/** The answer was accepted (or the server says it already was). First stamp wins. */
export async function markFeedbackRequestAnswered(id: string, now: number = Date.now()): Promise<void> {
  await updateFeedbackRequestsState((s) => {
    const e = s[id];
    if (e && e.answeredAt === undefined) e.answeredAt = now;
  }, now);
}

/** Test seam: forget listeners and the write chain, as a JS reload would. */
export function __resetFeedbackRequestStateForTests(): void {
  listeners.clear();
  chain = Promise.resolve();
}
