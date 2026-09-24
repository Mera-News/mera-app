// fact-check-settled — "your fact check is ready", for checks THIS device asked for.
//
// The server check finishes asynchronously, usually within 30s, and nothing
// pushes the result: the old server push was removed because sending it needed
// a user-to-article link (see resolveNotificationRoute in lib/notification-service).
// So the device notices the result itself, in three places that can each see the
// same row change: the article panel's poll, a mirror from an article response,
// and the re-read below. All three store through `storeServerFactCheck`, which
// is the ONE place a settled check is detected.
//
// SCOPE: only checks this device asked for. `fact_checks` also holds checks
// mirrored from articles other readers had checked; notifying for those would
// announce a result nobody here requested. The asked list is persisted, so it
// survives the JS reload every return to the foreground causes, and the
// re-read rebuilds its work from it after each reload.
//
// In-app only this wave: a notification-centre row plus the toast. The OS
// notification is on hold for its own design.

import logger from '../logger';
import type { FactCheckRow } from './fact-check-types';
import { describeCheckedBy, describeExternalChecks, isTerminalStatus } from './fact-check-state';

/** The persisted list of asks, by article id. */
const ASKED_KEY = 'mera_fact_check_asked_v1';
/** An ask older than this is dropped unanswered: the foreground re-read has
 *  had every chance, and the Dashboard list still shows the row. */
export const ASKED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Titles in the notification body are cut here, so a long headline cannot
 *  push the outcome off the row. */
export const NOTIFY_TITLE_MAX = 60;

export interface AskedFactCheck {
  articleId: string;
  suggestionId: string | null;
  title: string | null;
  askedAt: number;
}

export type FactCheckOutcome = 'found' | 'none' | 'unavailable';

// Lazy: `setting-service` builds a WatermelonDB collection at module scope, so
// a top-level import would construct a real SQLiteAdapter in every suite that
// loads the fact-check client.
function settings(): typeof import('../database/services/setting-service') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../database/services/setting-service');
}

async function readAsked(): Promise<Record<string, AskedFactCheck>> {
  try {
    const raw = await settings().getSetting(ASKED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, AskedFactCheck>) : {};
  } catch {
    return {};
  }
}

async function writeAsked(map: Record<string, AskedFactCheck>): Promise<void> {
  try {
    await settings().setSetting(ASKED_KEY, JSON.stringify(map));
  } catch (err) {
    logger.captureException(err, { tags: { service: 'fact-check-settled', method: 'writeAsked' } });
  }
}

// Serialises read-modify-write of the asked map: two stores landing in the
// same tick must not each write back a map missing the other's change.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

/** Records an explicit ask. Called from the fact-check tick only. */
export function recordFactCheckAsked(entry: Omit<AskedFactCheck, 'askedAt'>, now = Date.now()): Promise<void> {
  return serial(async () => {
    const map = await readAsked();
    map[entry.articleId] = { ...entry, askedAt: now };
    await writeAsked(map);
  });
}

/** The asks still worth re-reading, oldest first. Expired ones are dropped. */
export function listAskedFactChecks(now = Date.now()): Promise<AskedFactCheck[]> {
  return serial(async () => {
    const map = await readAsked();
    let changed = false;
    for (const [id, a] of Object.entries(map)) {
      if (!a || typeof a.askedAt !== 'number' || now - a.askedAt > ASKED_TTL_MS) {
        delete map[id];
        changed = true;
      }
    }
    if (changed) await writeAsked(map);
    return Object.values(map).sort((a, b) => a.askedAt - b.askedAt);
  });
}

function takeAsked(articleId: string): Promise<AskedFactCheck | null> {
  return serial(async () => {
    const map = await readAsked();
    const hit = map[articleId] ?? null;
    if (hit) {
      delete map[articleId];
      await writeAsked(map);
    }
    return hit;
  });
}

/** Which of the three notification bodies a settled check gets. */
export function outcomeFor(row: Pick<FactCheckRow, 'status' | 'checkedBy' | 'checkedByStatus'>): FactCheckOutcome {
  const external = describeExternalChecks(
    row.status,
    describeCheckedBy(row.checkedBy).length,
    row.checkedByStatus,
  );
  if (external === 'published') return 'found';
  if (external === 'none-published') return 'none';
  return 'unavailable';
}

const BODY_KEY: Record<FactCheckOutcome, string> = {
  found: 'factCheck.notify.bodyFound',
  none: 'factCheck.notify.bodyNone',
  unavailable: 'factCheck.notify.bodyUnavailable',
};

function clip(title: string): string {
  const t = title.trim();
  return t.length > NOTIFY_TITLE_MAX ? `${t.slice(0, NOTIFY_TITLE_MAX - 1).trimEnd()}…` : t;
}

/**
 * Called after every store of a server check, with the status the local row
 * had BEFORE the store. Notifies once, when an ASKED check goes from waiting
 * to settled. An ask whose very first answer is already settled was answered
 * on the spot, in front of the reader, so it is cleared without a notification.
 */
export async function noteFactCheckStored(
  articleId: string,
  previousStatus: string | null,
  row: FactCheckRow,
): Promise<boolean> {
  if (!isTerminalStatus(row.status)) return false;
  const asked = await takeAsked(articleId);
  if (!asked) return false;
  if (previousStatus === null || isTerminalStatus(previousStatus)) return false;

  const outcome = outcomeFor(row);
  const articleTitle = row.articleTitle ?? asked.title ?? '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { toastManager } = require('../toast-manager') as typeof import('../toast-manager');
    await toastManager.showNotifiedToast({
      type: 'fact_check_done',
      source: 'fact-check',
      title: 'factCheck.notify.title',
      body: BODY_KEY[outcome],
      icon: 'fact-check',
      context: {
        articleId,
        ...(asked.suggestionId ? { suggestionId: asked.suggestionId } : {}),
        articleTitle,
        outcome,
        // The body's interpolation value, pre-cut.
        title: clip(articleTitle),
      },
      actions: [{ id: 'open-fact-check', labelKey: 'factCheck.notify.open' }],
    });
    return true;
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'fact-check-settled', method: 'noteFactCheckStored' },
      extra: { articleId },
    });
    return false;
  }
}
