// The single app-restart authority.
//
// "Restart" means a JS reload (`Updates.reloadAsync()`). An app cannot kill
// itself on iOS, so a reload is the only mechanism there is — every caller that
// wants the app to come up fresh goes through `requestRestart()` rather than
// reaching for expo-updates itself. Before this module there were four
// uncoordinated `reloadAsync()` callers and no shared gate between them.
//
// WHAT RESTARTS, AND WHEN
//   - an OTA that was ALREADY downloaded before a true background -> active
//     return, and only when the reader's spot can be rebuilt after the reload
//     (`OTASilentUpdater`, reason 'ota'). A download never reloads by itself.
//   - the reader's Restart tap on the update toast or inbox row
//     (`lib/ota-notice.ts`, reason 'update')
//   - an RTL-crossing language change, and a completed backup restore
//
// THE SPOT rides in the marker: `requestRestart(reason, { spot })` writes it
// and the gate takes it ONCE (`takeRestoreSpot()`) to rebuild the screens the
// reader was on. Nothing is written at a departure; a process the OS kills in
// the background comes back as a cold start, which never restores.
//
// A RETURN ON ITS OWN IS NOT A REASON TO RESTART. The app briefly restarted on
// every true background -> active return regardless of whether anything had
// changed, and the owner rejected it in production: a reader who switches away
// for three seconds should come back to the app they left, not to a relaunch.
// Do not reintroduce an unconditional foreground restart, and do not add one
// behind a time threshold either — the objection was to refreshing a reader who
// is already on the current bundle, which a threshold does not address.
//
// WHAT A RESTART COSTS, AND WHO PAYS IT
// A reload looks exactly like a cold start to every boot path in the app, which
// is wrong for two of them. Each reads the marker this module writes and
// treats a restart boot as warm:
//   - `lib/stores/pin-store.ts`      — otherwise a 3-second background becomes
//                                      a PIN entry on every return
//   - `lib/scheduler/AppScheduler.ts`— otherwise the 5s cold-start floor
//                                      replaces the 60s warm one, so feed-sync
//                                      fires on every single return
// Notification taps do NOT read the marker and must not skip restart boots: a
// tap made from the background returns through a restart. They dedupe on the
// tap's persisted identifier instead (`handleInitialNotification` in
// lib/notification-service.ts).
// Money, credential and typed-text paths hold every restart off via
// `holdRestart()`; places that cannot be rebuilt (sheets, dialogs, the chat
// panel) hold off only the automatic one via `holdAutoRestart()`.
//
// IMPORT DISCIPLINE. `lib/database/index.ts` opens SQLite at import time and the
// damage travels to every downstream suite, so `setting-service`, the feed-order
// store and `expo-updates` are all lazy-`require`d at their call sites. This
// module is imported by `pin-store` and `AppScheduler`; a static import of any
// of the three would drag the native DB adapter into both of their suites and
// everything downstream of them. `react` (for `useRestartHold`) and `AppState`
// stay static: both are universally available, and departures need `AppState`.

import { useEffect } from 'react';
import { AppState, DevSettings, type AppStateStatus } from 'react-native';

import logger from '@/lib/logger';

export type RestartReason = 'ota' | 'update' | 'language' | 'restore';

export type RestartContext = {
  /** This boot is a JS reload we asked for, not a real cold start. */
  wasJsRestart: boolean;
  /** Why the previous process reloaded, or null on a cold start. */
  reason?: RestartReason | null;
  /** The spot to rebuild (opaque here; `lib/navigation/resume-spot.ts` validates it), or null. */
  spot?: unknown;
  /** When the app went to background before the restart, or null if it never did. */
  backgroundedAt: number | null;
  /** The pre-restart foreground stamp. */
  lastForegroundAt: number | null;
};

/**
 * The settings row carrying a restart across the reload.
 *
 * `globalThis` does not survive a reload and expo-updates has no reload payload
 * API, so the marker has to go to disk. It is read with `getSetting` DIRECTLY,
 * never through a store: it is read before `hydrateAllStores()` runs and a store
 * read at that point is silently empty. `lib/navigation/startup-tab.ts` reads
 * the settings table directly for the same reason. The DB singleton opens SQLite
 * at import time, so the row is readable that early.
 *
 * Not in `lib/backup/allowlist.ts`'s settings allowlist, deliberately: it
 * describes one reload on one device and means nothing after it is read.
 */
export const RESTART_MARKER_KEY = 'js_restart_marker';

/**
 * Routes where a restart must not wipe what the user came back to finish: a
 * login, an OTP fetched from their mail app, a PIN being set or entered,
 * onboarding answers.
 *
 * THE LIST LIVES HERE, NOT IN A CALLER, and that is the whole point. It used to
 * be checked by the foreground restart alone, so `requestRestart('ota')` was
 * route-blind: a user returning from their mail app to `/verify-otp` had the
 * foreground restart correctly skipped and was then restarted by the OTA check
 * on that same transition, wiping the code the return had just delivered.
 * Applied in `blockedBy()`, so every reason is covered rather than whichever one
 * happens to own a list.
 *
 * `/pin-lock` is here for a SECURITY reason, not a convenience one: `locked`
 * lives only in memory, so a restart recomputes it from the threshold and a
 * short trip to a password manager would come back unlocked.
 * `lib/stores/pin-store.ts` also takes a `holdRestart('pin-lock')` for the whole
 * time the gate is engaged, which is the order-independent half of that fix. Do
 * not remove either one on the grounds that the other exists.
 */
export const RESTART_BLOCKED_ROUTES = [
  '/login',
  '/verify-otp',
  '/pin-setup',
  '/pin-lock',
  '/logged-in/onboarding',
] as const;

export function isRestartBlockedRoute(pathname: string): boolean {
  return RESTART_BLOCKED_ROUTES.some((route) => pathname.startsWith(route));
}

/**
 * The settings row recording which update id a restart has already been
 * attempted for.
 *
 * OVERWRITTEN, NEVER DELETED, and deliberately NOT part of the restart marker.
 * The marker is deleted on first read, so a bundle that downloads, restarts and
 * then fails to launch would have its record cleared by the very boot that
 * proves it failed — the guard erased by the exact failure it exists to bound.
 *
 * WHY IT IS NEEDED AT ALL: the OTA check is now the only restart trigger left,
 * and it runs on every return. `MIN_RESTART_INTERVAL_MS` only SPACES a repeat,
 * it does not stop one, so without this a bundle that keeps reporting itself
 * downloadable leaves the app reloading every ten seconds for as long as that
 * lasts. `restartCount` on the native context does not help: it counts reloads
 * and says nothing about WHICH update was attempted.
 */
export const OTA_RESTART_GUARD_KEY = 'ota_restart_attempted_update_id';

/** Whether a restart has already been attempted for this update id. */
export async function otaRestartAlreadyAttempted(updateId: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSetting } = require('@/lib/database/services/setting-service');
    return (await getSetting(OTA_RESTART_GUARD_KEY)) === updateId;
  } catch (err) {
    // Fail to "already attempted". An unreadable guard must not license an
    // unbounded reload loop; the update still launches at the next cold start,
    // which is what expo-updates does on its own.
    logger.captureException(err, {
      tags: { module: 'app-restart', method: 'otaRestartAlreadyAttempted' },
    });
    return true;
  }
}

/**
 * Records the attempt. AWAITED BEFORE the restart is requested, never after: a
 * write after `reloadAsync()` never runs, and an attempt that is then blocked by
 * a hold or a route must still consume the guard — that update lands at the next
 * cold start, which is the safe direction.
 */
export async function markOtaRestartAttempted(updateId: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setSetting } = require('@/lib/database/services/setting-service');
    await setSetting(OTA_RESTART_GUARD_KEY, updateId);
  } catch (err) {
    logger.captureException(err, {
      tags: { module: 'app-restart', method: 'markOtaRestartAttempted' },
    });
  }
}

/**
 * Floor between two restarts, ACROSS the reload as well as inside one process.
 *
 * Module state does not survive `reloadAsync()`, so an in-process latch alone
 * bounds nothing: a reload -> boot -> reload cycle would be rate-limited by
 * exactly zero gates. `restartContext()` therefore seeds `lastRestartAt` from
 * the marker's own stamp on a restart boot, and this floor is the one gate that
 * survives. The OTA path is the reachable loop — `OTASilentUpdater` checks on
 * MOUNT, so a bundle that fetches as new on every boot would otherwise restart
 * on every boot.
 */
export const MIN_RESTART_INTERVAL_MS = 10_000;

type MarkerPayload = {
  reason: RestartReason;
  at: number;
  backgroundedAt: number | null;
  lastForegroundAt: number | null;
  /** 'ota' and 'update' only: where the reader was. */
  spot?: unknown;
  /** A restore failed earlier in this session: no automatic reload until a cold start. */
  noAutoReload?: boolean;
};

const RESTART_REASONS: readonly RestartReason[] = ['ota', 'update', 'language', 'restore'];

const EMPTY_CONTEXT: RestartContext = {
  wasJsRestart: false,
  backgroundedAt: null,
  lastForegroundAt: null,
};

// ---------------------------------------------------------------------------
// Departure tracking
// ---------------------------------------------------------------------------

let trackingInstalled = false;
let backgroundedAt: number | null = null;
let lastForegroundAt: number | null = null;

/**
 * Records the stamps the marker carries.
 *
 * `background` ONLY, never `!== 'active'`: iOS reports `inactive` for the app
 * switcher, a notification banner pulled down and Control Centre, none of which
 * is a departure. `lib/subscriptions/subscribe-flow.ts` draws the same line for
 * the same reason and is the precedent.
 *
 * Installed from `restartContext()`, so both entry points into this module
 * (`pin-store.init()` and the root bootstrap) arm it, and idempotent so neither
 * has to know about the other.
 */
function ensureDepartureTracking(): void {
  if (trackingInstalled) return;
  trackingInstalled = true;
  AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'background') {
      backgroundedAt = Date.now();
    } else if (state === 'active') {
      lastForegroundAt = Date.now();
    }
  });
}

// ---------------------------------------------------------------------------
// The marker
// ---------------------------------------------------------------------------

let contextPromise: Promise<RestartContext> | null = null;
let cachedContext: RestartContext = EMPTY_CONTEXT;

async function readAndClearMarker(): Promise<RestartContext> {
  ensureDepartureTracking();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSetting, deleteSetting } = require('@/lib/database/services/setting-service');
    const raw: string | null = await getSetting(RESTART_MARKER_KEY);
    if (raw == null) return EMPTY_CONTEXT;
    await deleteSetting(RESTART_MARKER_KEY);

    const parsed = JSON.parse(raw) as Partial<MarkerPayload>;
    // A marker written by this process's predecessor bounds the next restart.
    if (typeof parsed.at === 'number') lastRestartAt = parsed.at;
    if (parsed.noAutoReload === true) autoReloadOff = true;
    const reason = RESTART_REASONS.includes(parsed.reason as RestartReason) ? (parsed.reason as RestartReason) : null;
    return {
      wasJsRestart: true,
      reason,
      spot: (reason === 'ota' || reason === 'update') && parsed.spot != null && typeof parsed.spot === 'object' ? parsed.spot : null,
      backgroundedAt: typeof parsed.backgroundedAt === 'number' ? parsed.backgroundedAt : null,
      lastForegroundAt:
        typeof parsed.lastForegroundAt === 'number' ? parsed.lastForegroundAt : null,
    };
  } catch (err) {
    // Fail to "this is a cold start". Every consumer's cold-start branch is the
    // conservative one: the PIN gate locks, the notification is handled, the
    // scheduler uses the cold-start floor.
    logger.captureException(err, { tags: { module: 'app-restart', method: 'readMarker' } });
    return EMPTY_CONTEXT;
  }
}

/**
 * This boot's restart context. Memoised, so the marker is read and deleted once
 * however many callers ask.
 */
export function restartContext(): Promise<RestartContext> {
  if (contextPromise == null) {
    contextPromise = readAndClearMarker().then((ctx) => {
      cachedContext = ctx;
      return ctx;
    });
  }
  return contextPromise;
}

/**
 * Populates the synchronous cache. Awaited once near the top of the root
 * bootstrap, BEFORE `AppScheduler.init()`, so `onStoresHydrated()` can read
 * `wasJsRestartSync()` without becoming async — see the note on
 * `AppScheduler.onStoresHydrated()` for why it must stay synchronous.
 */
export function initRestartContext(): Promise<RestartContext> {
  return restartContext();
}

/**
 * Whether this boot is a JS restart, without awaiting.
 *
 * Returns false until `initRestartContext()` has resolved, so only code that
 * runs after that await may use it. Anything earlier awaits `restartContext()`.
 */
export function wasJsRestartSync(): boolean {
  return cachedContext.wasJsRestart;
}

let spotTaken = false;

/**
 * The spot this boot should rebuild, ONCE. The launch gate re-runs (PIN unlock,
 * a reauth, the feedback-request route), and a second rebuild would drag the
 * reader back to where they were a minute ago. Null on a cold start, on a
 * language or restore restart, and on every call after the first.
 */
export async function takeRestoreSpot(): Promise<unknown> {
  const ctx = await restartContext();
  if (spotTaken) return null;
  spotTaken = true;
  return ctx.spot ?? null;
}

// ---------------------------------------------------------------------------
// Automatic reload switch
// ---------------------------------------------------------------------------

let autoReloadOff = false;

/**
 * A rebuild of the reader's spot failed: no AUTOMATIC reload for any update
 * until the next cold start, so a failed restore can never repeat. Carried
 * across later reloads in the marker. A Restart tap still works.
 */
export function disableAutoReload(): void {
  autoReloadOff = true;
}

export function autoReloadDisabled(): boolean {
  return autoReloadOff;
}

/**
 * The reader's spot right now, or null when it cannot be rebuilt. Lazy and
 * total: the resume module reads navigation and stores, which this module must
 * not import (see IMPORT DISCIPLINE), and a capture that throws means "not
 * restorable", never a crash on the way out.
 */
export function captureResumeSpot(): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { captureSpot } = require('@/lib/navigation/resume-spot');
    return captureSpot() ?? null;
  } catch (err) {
    logger.captureException(err, { tags: { module: 'app-restart', method: 'captureResumeSpot' } });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

let nextHoldId = 1;
/** `auto` holds block only the automatic reload (reason 'ota'); `hard` ones block every reason. */
const holds = new Map<number, { label: string; kind: 'hard' | 'auto' }>();

function addHold(label: string, kind: 'hard' | 'auto'): () => void {
  const id = nextHoldId++;
  holds.set(id, { label, kind });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds.delete(id);
  };
}

/**
 * Holds EVERY restart off while something must not be interrupted — a purchase, a
 * credential write, a stream mid-flight, text the reader typed. Returns an
 * idempotent release.
 *
 * A BLOCKED RESTART IS DEFERRED TO THE NEXT UNBLOCKED background -> active
 * TRANSITION, AND IS NEVER RETRIED WHEN THE HOLD RELEASES. Releasing a 20s
 * purchase hold while the user is foregrounded mid-flow would restart them out
 * of the success state they just paid for. Do not add a release-triggered retry.
 */
export function holdRestart(label: string): () => void {
  return addHold(label, 'hard');
}

/**
 * Holds off only the AUTOMATIC reload on a return (reason 'ota'): the reader's
 * place could not be rebuilt (an open sheet, dialog, tutorial, the chat panel).
 * A Restart tap, a language change and a backup restore still go through, so a
 * dialog closing in the same tick as its confirm cannot swallow them.
 */
export function holdAutoRestart(label: string): () => void {
  return addHold(label, 'auto');
}

/** A hold for as long as `active` is true, released on change and unmount. */
export function useRestartHold(active: boolean, label: string, kind: 'hard' | 'auto' = 'auto'): void {
  useEffect(() => {
    if (!active) return undefined;
    return addHold(label, kind);
  }, [active, label, kind]);
}

/** The labels holding a restart off: every hold, or only those that block `reason`. */
export function activeHolds(reason?: RestartReason): string[] {
  return Array.from(holds.values())
    .filter((h) => reason == null || reason === 'ota' || h.kind === 'hard')
    .map((h) => h.label);
}

// ---------------------------------------------------------------------------
// The restart itself
// ---------------------------------------------------------------------------

let lastRestartAt = 0;
let restartInFlight = false;

/**
 * Logs the decision instead of reloading.
 *
 * Required, not optional: on the simulator `__DEV__` is true and
 * `Updates.isEnabled` is false, so the whole feature is inert there and the
 * decision logic is otherwise unobservable. With
 * `EXPO_PUBLIC_RESTART_DEBUG=true` every call prints its verdict and, when
 * blocked, what blocked it.
 */
function restartDebugEnabled(): boolean {
  return process.env.EXPO_PUBLIC_RESTART_DEBUG === 'true';
}

/** Why a restart for `reason` cannot happen now, or null if it can. */
function blockedBy(reason: RestartReason): string | null {
  if (AppState.currentState !== 'active') return `appstate:${AppState.currentState}`;
  if (restartInFlight) return 'in-flight';
  const since = Date.now() - lastRestartAt;
  if (lastRestartAt > 0 && since < MIN_RESTART_INTERVAL_MS) return `cooldown:${since}ms`;
  const held = activeHolds(reason);
  if (held.length > 0) return `hold:${held.join(',')}`;
  const route = blockedRoute();
  return route ? `route:${route}` : null;
}

/** The live route when it is in RESTART_BLOCKED_ROUTES, else null. */
function blockedRoute(): string | null {
  // Lazy-required for the reason this file's header gives: `pin-store` and
  // `AppScheduler` import this module, and nav-state is cheap but the rule is
  // absolute. It mirrors the live route for exactly this kind of non-React read.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCurrentPathname } = require('@/lib/nav-state');
    const pathname: string = getCurrentPathname();
    if (isRestartBlockedRoute(pathname)) return pathname;
  } catch {
    // An unreadable route is not a reason to block a restart the user asked for
    // by changing their language or restoring a backup.
  }
  return null;
}

/**
 * Whether the screen showing now can never restart (PIN lock, sign-in,
 * onboarding), whatever else allows it. For the OTA toast, whose Restart would
 * do nothing there.
 */
export function routeBlocksRestart(): boolean {
  return blockedRoute() != null;
}

/**
 * DEV BUILDS ONLY: drive the real update-reload path on a simulator, where
 * expo-updates is off and every restart is otherwise inert. With
 * `EXPO_PUBLIC_DEV_RESTORE_TEST=1` in a dev build, a true return with a
 * rebuildable spot reloads (Metro's `DevSettings.reload`) with the marker
 * written exactly as in production, so the next boot runs the gate's rebuild
 * and the "Mera updated" toast. `__DEV__` is false in a release bundle, so the
 * flag can never act there.
 */
export function devRestoreTestEnabled(): boolean {
  return __DEV__ && process.env.EXPO_PUBLIC_DEV_RESTORE_TEST === '1';
}

/**
 * Whether a restart could actually happen on this build.
 *
 * The two restore callers need this because their fallback is user-facing: when
 * updates are disabled they have to tell the reader to reopen the app rather
 * than leave them on a success message and a stale screen. They cannot infer it
 * from `requestRestart()` returning, because `reloadAsync()`'s promise can
 * resolve before the JS context is torn down and the fallback would then paint
 * over a restart that IS happening.
 */
export function restartIsAvailable(): boolean {
  if (__DEV__) return devRestoreTestEnabled();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Updates = require('expo-updates');
    return Boolean(Updates.isEnabled);
  } catch {
    return false;
  }
}

/**
 * Whether a restart requested RIGHT NOW would actually reload the app.
 *
 * Exists for one caller: the OTA path records one attempt per update id, and
 * that record must only be spent on a request that genuinely reloads. A request
 * that was blocked did not reload, so it cannot have failed to launch, so it is
 * not what the guard bounds — retrying it on the next return is correct
 * behaviour. Consuming the attempt anyway stranded the bundle: a reader mid-chat
 * -stream, mid-checkout or sitting on `/verify-otp` when the download finished
 * would never be offered it again on a return, only at a cold start — and the
 * reader who never cold-starts is the entire premise of the feature.
 *
 * REUSES `blockedBy()` rather than restating its ladder. A second copy of that
 * precedence is how the two drift apart, and a predicate that disagreed with the
 * gate it predicts would be worse than no predicate.
 *
 * FALSE ON THE INERT PATHS TOO, not just when blocked. A dev build or a build
 * without expo-updates eats the attempt otherwise, which is the same bug in
 * different clothes; and it is false under `EXPO_PUBLIC_RESTART_DEBUG` as well,
 * so a simulator pass can watch the decision on every return instead of seeing
 * it once and then silently never again.
 */
export function restartWouldReload(reason: RestartReason): boolean {
  if (restartDebugEnabled()) return false;
  if (!restartIsAvailable()) return false;
  return blockedBy(reason) == null;
}

/**
 * Restart the app, if every gate allows it.
 *
 * Says nothing itself: no prompt, banner or toast here (the OTA notice is
 * `lib/ota-notice.ts`'s). The caller does not find out whether it happened; see
 * `restartIsAvailable()` for the one flow that needs to know.
 */
export async function requestRestart(reason: RestartReason, opts?: { spot?: unknown }): Promise<void> {
  const blocker = blockedBy(reason);

  // Ahead of the dev / isEnabled gate on purpose: the simulator is where the
  // decision logic gets exercised, and it is exactly where a reload cannot run.
  if (restartDebugEnabled()) {
    logger.info(
      `[app-restart] would restart (${reason}, blocked-by: ${blocker ?? 'none'})`,
    );
    if (blocker == null) lastRestartAt = Date.now();
    return;
  }

  if (blocker != null) {
    // Deferred, not queued. The next unblocked background -> active transition
    // picks it up.
    logger.debug(`[app-restart] skipped (${reason}, blocked-by: ${blocker})`);
    return;
  }

  if (!restartIsAvailable()) {
    logger.debug(`[app-restart] inert build, not restarting (${reason})`);
    return;
  }

  restartInFlight = true;
  lastRestartAt = Date.now();

  try {
    // Flush the feed's card states first. FeedScreen flushes on `background`,
    // so an OTA restart on a return is already covered — but a language or
    // restore restart fires with the app foregrounded, where nothing has
    // flushed. Synchronous and a
    // no-op when nothing is pending; its write goes through `setSetting`, and
    // WatermelonDB serializes writes, so awaiting the marker below is also the
    // barrier that guarantees this one landed.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { useFeedOrderStore } = require('@/lib/stores/feed-order-store');
      useFeedOrderStore.getState().flushPersist();
    } catch (err) {
      // A failed flush costs card states, not the restart.
      logger.captureException(err, { tags: { module: 'app-restart', method: 'flush' } });
    }

    // The departure stamp is only meaningful to the next boot for 'ota': by construction that is the
    // restart that fires on a background -> active return (OTASilentUpdater is its only caller, and
    // a blocked restart is deferred to the next return), so the stamp measures the trip that just
    // ended. 'update', 'language' and 'restore' are in-app taps made after the PIN gate, so the
    // reader never left as far as the next boot is concerned: null, which pin-store reads as
    // "never left". 'update' must not reuse 'ota': its stamp is from a trip that already ended.
    const payload: MarkerPayload = {
      reason,
      at: lastRestartAt,
      backgroundedAt: reason === 'ota' ? backgroundedAt : null,
      lastForegroundAt,
      ...((reason === 'ota' || reason === 'update') && opts?.spot != null ? { spot: opts.spot } : {}),
      ...(autoReloadOff ? { noAutoReload: true } : {}),
    };
    // AWAITED. An unawaited write races the reload and the next boot reads a
    // cold start, which is the PIN prompt on every return.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setSetting } = require('@/lib/database/services/setting-service');
    await setSetting(RESTART_MARKER_KEY, JSON.stringify(payload));

    logger.addBreadcrumb('App restart requested', 'app-restart', {
      reason,
      backgroundedAt,
      lastForegroundAt,
    });

    if (__DEV__) {
      // Only reachable under devRestoreTestEnabled(): a dev client has no
      // expo-updates reload, and the Metro reload keeps the settings table.
      DevSettings.reload('restore test');
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Updates = require('expo-updates');
    await Updates.reloadAsync();
  } catch (err) {
    restartInFlight = false;
    // The marker describes a restart that did not happen. Left behind it would
    // make the NEXT cold start read as warm, so the PIN gate would not lock.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { deleteSetting } = require('@/lib/database/services/setting-service');
      await deleteSetting(RESTART_MARKER_KEY);
    } catch {
      // Nothing further to try; the marker's own parse is defensive.
    }
    logger.captureException(err, {
      tags: { module: 'app-restart', method: 'requestRestart' },
      extra: { reason },
    });
  }
}

/** Test seam. Resets every piece of module state this file keeps. */
export function __resetAppRestartForTests(): void {
  contextPromise = null;
  cachedContext = EMPTY_CONTEXT;
  holds.clear();
  nextHoldId = 1;
  lastRestartAt = 0;
  restartInFlight = false;
  backgroundedAt = null;
  lastForegroundAt = null;
  trackingInstalled = false;
  spotTaken = false;
  autoReloadOff = false;
}
