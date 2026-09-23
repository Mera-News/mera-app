// pending-notification-route — the hand-off between a notification tap and the
// startup/PIN gate. Not a Zustand store: a plain module plus one settings row.
//
// WHY IT EXISTS. A tap can arrive when navigating is wrong or useless:
//   - the PIN lock is up (navigating would put a screen over the lock, or be
//     bounced to /pin-lock and lost);
//   - the startup gate (app/logged-in/index.tsx) has not run yet, so identity,
//     onboarding and the startup tab are still undecided;
//   - a JS reload is about to happen. Every background -> active return reloads
//     (lib/app-restart.ts), so a warm tap's navigation is usually wiped a moment
//     later.
// So a tap never navigates on its own authority. It STASHES the route, and the
// route is consumed either immediately (gate passed, PIN unlocked) or by the
// startup gate after it lands on the startup tab. PIN unlock goes back through
// /logged-in, so the gate covers that case too.
//
// PERSISTED, not only in memory, because of the reload: the warm listener in
// the pre-reload JS context writes the row, and the startup gate in the new
// context reads it. Memory is the fast path; the row is the one that survives.
//
// IMPORT DISCIPLINE. The startup gate and the notification service both import
// this, so it must not drag the SQLite singleton into their suites:
// setting-service is lazy-required at the call site (same rule as
// lib/app-restart.ts).

import logger from '@/lib/logger';

/** Every destination a notification tap may open. Route paths never change
 *  here: the harness drives the app by deep link. */
export type NotificationHref =
  | '/logged-in/app_container/for_you'
  | { pathname: '/logged-in/suggestion-detail'; params: { articleSuggestionId: string } }
  | { pathname: '/logged-in/article-detail'; params: { articleId: string } };

interface PendingRoute {
  href: NotificationHref;
  userId: string;
  /** Epoch ms of the tap (stash time). */
  at: number;
}

export const PENDING_NOTIFICATION_ROUTE_KEY = 'pending_notification_route';

/** A stash older than this is dropped rather than opened. Long enough for a
 *  reload plus a PIN entry; short enough that an abandoned tap never opens a
 *  screen out of nowhere on some later launch. */
export const PENDING_ROUTE_MAX_AGE_MS = 10 * 60 * 1000;

let memory: PendingRoute | null = null;
let startupGatePassed = false;

function settings(): typeof import('@/lib/database/services/setting-service') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/database/services/setting-service');
}

function isHref(v: unknown): v is NotificationHref {
  if (v === '/logged-in/app_container/for_you') return true;
  if (!v || typeof v !== 'object') return false;
  const o = v as { pathname?: unknown; params?: Record<string, unknown> };
  if (o.pathname === '/logged-in/suggestion-detail') {
    return typeof o.params?.articleSuggestionId === 'string' && o.params.articleSuggestionId !== '';
  }
  if (o.pathname === '/logged-in/article-detail') {
    return typeof o.params?.articleId === 'string' && o.params.articleId !== '';
  }
  return false;
}

function parse(raw: string | null): PendingRoute | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (p && typeof p.userId === 'string' && typeof p.at === 'number' && isHref(p.href)) {
      return { href: p.href, userId: p.userId, at: p.at };
    }
  } catch {
    // fall through: a corrupt row is the same as no row
  }
  return null;
}

/**
 * Record where a tap should go. Awaits the settings write so a caller about to
 * be reloaded has the row on disk first. Never throws: a failed write leaves
 * the memory copy, which is still enough when no reload happens.
 */
export async function stashPendingNotificationRoute(
  href: NotificationHref,
  userId: string,
  now: number = Date.now(),
): Promise<void> {
  memory = { href, userId, at: now };
  try {
    await settings().setSetting(PENDING_NOTIFICATION_ROUTE_KEY, JSON.stringify(memory));
  } catch (err) {
    logger.captureException(err, {
      tags: { module: 'pending-notification-route', method: 'stash' },
    });
  }
}

/**
 * Take the pending route, if any, and clear it (memory and row) so it opens
 * exactly once. Returns null when there is none, when it belongs to another
 * user, or when it is older than {@link PENDING_ROUTE_MAX_AGE_MS}. Never throws.
 */
export async function consumePendingNotificationRoute(
  userId: string | null | undefined,
  now: number = Date.now(),
): Promise<NotificationHref | null> {
  let pending = memory;
  memory = null;
  try {
    const svc = settings();
    if (!pending) pending = parse(await svc.getSetting(PENDING_NOTIFICATION_ROUTE_KEY));
    await svc.deleteSetting(PENDING_NOTIFICATION_ROUTE_KEY);
  } catch (err) {
    logger.captureException(err, {
      tags: { module: 'pending-notification-route', method: 'consume' },
    });
  }
  if (!pending || !userId || pending.userId !== userId) return null;
  if (now - pending.at > PENDING_ROUTE_MAX_AGE_MS) return null;
  return pending.href;
}

/**
 * Called by the startup gate (app/logged-in/index.tsx) once it has sent the
 * user to their startup tab. From then on a tap in this JS context may
 * navigate immediately (PIN permitting). Memory only, on purpose: a reload
 * must go through the gate again.
 */
export function markStartupGatePassed(): void {
  startupGatePassed = true;
}

export function isStartupGatePassed(): boolean {
  return startupGatePassed;
}

/** Test seam: forget memory state, as a JS reload would. */
export function __resetPendingNotificationRouteForTests(): void {
  memory = null;
  startupGatePassed = false;
}
