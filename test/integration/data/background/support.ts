// Shared by the `mera-background` seam tests (data-U15). Not a test file.
//
// A wake runs the REAL stack: the exported runners, the real feed-sync machine in background mode,
// the real scoring pipeline over the gateway mock, the in-memory DB, MSW and the stateful keychain.
// Only native edges are stand-ins (the OS task registry in `native-fakes.ts`, keep-awake).
//
// The wake starts the way a headless OS wake does: the install-boundary latch is closed (sync
// cookie reads answer null) and the boundary has not run. `signInFixtureAccount` puts the session in
// the keychain first, then the latch is re-closed so only `enforceInstallBoundary` can open it.
import * as Sentry from '@sentry/react-native';
import * as SecureStore from 'expo-secure-store';

import { runBackgroundFeedSync, __resetBackgroundFeedSyncForTests } from '@/lib/background/background-feed-sync';
import { LAST_FOREGROUND_AT_KEY } from '@/lib/background/bg-refresh-settings';
import { _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import { Q } from '@nozbe/watermelondb';

import database from '@/lib/database';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-persist';
import { saveScoringResult } from '@/lib/database/services/article-suggestion-scoring-writes';
import { setSetting } from '@/lib/database/services/setting-service';
import { countAllTopics } from '@/lib/database/services/topic-service';
import { __resetAuthReadQuarantineForTests } from '@/lib/security/install-boundary-latch';
import { HAS_LAUNCHED_SETTING_KEY, __resetInstallBoundaryForTests } from '@/lib/security/install-boundary';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { toastManager } from '@/lib/toast-manager';
// aliased: a use* name inside a plain function trips react-hooks/rules-of-hooks
import { setAppState, server, useStrictClock as strictClockAt } from '@/test/helpers';
import { resetBackupSettingsMirror } from '@/lib/backup/backup-settings';
import {
  art,
  cleanupFeedSync,
  resetFeedSyncMemory,
  resetScoringWorld,
  seedInterest,
  serveHydrate,
  servePersona,
  spyOnExport,
  type HydrateServe,
} from '../feed-sync/steps/support';
import { oid } from '../feed-sync/machine/support';
import {
  addRule,
  failBatchWhere,
  failSettingRead as failSharedSettingRead,
  isKey,
  restoreFaults,
  type BatchOp,
} from '../support/faults';

export { servePersona, serveHydrate, seedInterest, seedTracked, recordOps, rowsById, art, spyOnExport } from '../feed-sync/steps/support';
export { oid, watchScoring, scoreEntries, keepAwake, recordMachine } from '../feed-sync/machine/support';

export { server };

/** Fixed wake time. Equal to the scoring world's `PIPELINE_NOW`, so nothing re-seats the clock. */
export const NOW = Date.UTC(2026, 9, 9, 10, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** The cookie key the real client writes (`APP_SLUG` is the integration expo-constants slug). */
export const COOKIE_KEY = 'exampleapp_cookie';

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export interface WorldOptions {
  /** Epoch ms of the last real foreground; `null` seeds none. Default: one hour before NOW. */
  lastForeground?: number | null;
  /** Skip the `has_launched` marker, so the install boundary treats the device as a fresh install. */
  freshInstall?: boolean;
  /** The install boundary has already run in this process (a fetch-only test): the read latch is open. */
  afterBoundary?: boolean;
}

/**
 * Call from `beforeEach`. Signed in, app in the background, strict clock at NOW, every module-level
 * latch back to a process that has just been started.
 */
export async function wakeWorld(opts: WorldOptions = {}): Promise<void> {
  resetFeedSyncMemory();
  await resetScoringWorld(); // signs in (releasing the read latch) and installs a fake clock
  resetBreaker();
  __resetBackgroundFeedSyncForTests();
  __resetInstallBoundaryForTests();
  if (!opts.afterBoundary) __resetAuthReadQuarantineForTests();
  resetBackupSettingsMirror();
  useDatabaseStore.setState({ ready: false }); // the boot has not run in a headless wake
  if (!opts.freshInstall) await setSetting(HAS_LAUNCHED_SETTING_KEY, '1');
  const foreground = opts.lastForeground === undefined ? NOW - HOUR : opts.lastForeground;
  if (foreground !== null) await setSetting(LAST_FOREGROUND_AT_KEY, String(foreground));
  setAppState('background');
  strictClockAt(NOW);
  watchToasts();
}

/** Call from `afterEach`. */
export async function wakeCleanup(): Promise<void> {
  releaseHolds();
  // A released run unwinds over a few turns; the machine joins a start() to a run still in flight, so
  // the next test must not begin before it has finished.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { feedSyncMachine } = require('@/lib/scheduler/feed-sync/FeedSyncMachine') as typeof import('@/lib/scheduler/feed-sync/FeedSyncMachine');
  for (let turns = 0; feedSyncMachine.isRunning() && turns < 200; turns++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  restoreDbFaults();
  cleanupFeedSync();
}

// ---------------------------------------------------------------------------
// Quiet-exit evidence
// ---------------------------------------------------------------------------

/** Every Sentry event this test caused (exceptions and messages). */
export const sentryEvents = (): unknown[][] => [
  ...(Sentry.captureException as jest.Mock).mock.calls,
  ...(Sentry.captureMessage as jest.Mock).mock.calls,
];

const toastSpies: jest.SpyInstance[] = [];
const TOAST_METHODS = ['showNetworkError', 'showError', 'showSuccess', 'showInfo', 'showUndoToast', 'showNotifiedToast'] as const;
function watchToasts(): void {
  toastSpies.length = 0;
  for (const m of TOAST_METHODS) toastSpies.push(spyOnExport(toastManager, m));
}
/** Toasts shown since `wakeWorld`, by method name. */
export const toastsShown = (): string[] =>
  toastSpies.flatMap((s, i) => (s.mock.calls.length > 0 ? [TOAST_METHODS[i]] : []));

/** Messages of every Sentry breadcrumb this test caused. */
export const breadcrumbs = (): string[] =>
  (Sentry.addBreadcrumb as jest.Mock).mock.calls.map((c) => (c[0] as { message: string }).message);

/** A setting as the DISK has it, bypassing the record cache (a refused write is still cached). */
export async function persistedSetting(key: string): Promise<string | null> {
  const raws = (await database.get('settings').query(Q.where('key', key)).unsafeFetchRaw()) as { value: string }[];
  return raws.length > 0 ? raws[0].value : null;
}

/** Paths of every request sent from now on, in order (`/sign-out` would be a logout). */
export function recordPaths() {
  const paths: string[] = [];
  const listener = ({ request }: { request: Request }) => {
    paths.push(new URL(request.url).pathname);
  };
  server.events.on('request:start', listener);
  stoppers.push(() => server.events.removeListener('request:start', listener));
  return paths;
}
const stoppers: (() => void)[] = [];

// ---------------------------------------------------------------------------
// Seeding the open-ready state through the app's own writers
// ---------------------------------------------------------------------------

/**
 * Rows the reader can already see: scored `Complete` at `relevance`, published `ageMs` ago. They
 * land the way a sync lands them, then the scoring writer moves them on.
 */
export async function seedScored(count: number, over: { relevance?: number; ageMs?: number; prefix?: string } = {}) {
  const prefix = over.prefix ?? 'seen';
  const ids = Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
  const pubDate = new Date(Date.now() - (over.ageMs ?? HOUR)).toISOString();
  await persistAndLinkV2Suggestions(ids.map((id) => art(id, { pubDate })), new Map());
  for (const id of ids) await saveScoringResult(id, { relevance: over.relevance ?? 0.9, reason: '', reasonSkipped: true });
  return ids;
}

/** Rows still waiting for a score, published `ageMs` ago. */
export async function seedUnscored(count: number, over: { ageMs?: number; prefix?: string } = {}) {
  const prefix = over.prefix ?? 'wait';
  const ids = Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
  const pubDate = new Date(Date.now() - (over.ageMs ?? HOUR)).toISOString();
  await persistAndLinkV2Suggestions(ids.map((id) => art(id, { pubDate })), new Map());
  return ids;
}

// ---------------------------------------------------------------------------
// Faults on the real database (R26)
// ---------------------------------------------------------------------------

export { failBatchWhere };

/** A `settings` read for exactly `key` that never answers: the DB probe hanging. */
export function hangSettingRead(key: string): void {
  addRule('settings', { match: isKey(key), gate: new Promise<void>(() => undefined) });
}

/** A `settings` read for exactly `key` that throws: SQLite not opening. */
export function failSettingRead(key: string, error = new Error('unable to open database file (injected)')): void {
  failSharedSettingRead(key, error);
}

export function restoreDbFaults(): void {
  restoreFaults();
  for (const stop of stoppers.splice(0)) stop();
}

// ---------------------------------------------------------------------------
// Held server responses
// ---------------------------------------------------------------------------

const holds: (() => void)[] = [];

/** A promise the test settles by hand; every hold is released by `wakeCleanup`. */
export function hold(): { held: Promise<void>; release(): void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  holds.push(release);
  return { held, release };
}
function releaseHolds(): void {
  holds.splice(0).forEach((release) => release());
}

// ---------------------------------------------------------------------------
// A run of step (b) on its own
// ---------------------------------------------------------------------------

/** `runBackgroundFeedSync` with the wake's own 60s budget from NOW. */
export const runFetch = (over: { now?: number; deadlineAt?: number } = {}) => {
  const now = over.now ?? NOW;
  return runBackgroundFeedSync({ now, deadlineAt: over.deadlineAt ?? now + 60_000 });
};

// ---------------------------------------------------------------------------
// Serving a fetch
// ---------------------------------------------------------------------------

/**
 * One interest (`formula 1`) and the server listing `count` articles inserted a minute ago for it,
 * plus `old` listed ones inserted `oldAgeMs` ago. `hydrate` shapes the hydrate answers.
 */
export async function serveFresh(
  count: number,
  over: { old?: number; oldAgeMs?: number; headlines?: string[]; hydrate?: HydrateServe; at?: number; first?: number } = {},
) {
  const at = over.at ?? NOW;
  const first = over.first ?? 1;
  const fresh = Array.from({ length: count }, (_, i) => oid(first + i, at - 60_000));
  const old = Array.from({ length: over.old ?? 0 }, (_, i) => oid(first + 1000 + i, at - (over.oldAgeMs ?? 7 * HOUR)));
  if ((await countAllTopics()) === 0) await seedInterest('I follow racing', ['formula 1']);
  const served = serveHydrate(over.hydrate);
  server.use(
    servePersona({
      topics: { 'formula 1': [...fresh, ...old] },
      headlines: over.headlines ? [{ scope: 'GLOBAL', ids: over.headlines }] : [],
    }),
    ...served.handlers,
  );
  return { fresh, old, served };
}

// ---------------------------------------------------------------------------
// Watching the wake
// ---------------------------------------------------------------------------

/** Call-through observation of one export: `label` goes into `order` each time it is called. */
export function tap<T extends object, K extends keyof T & string>(target: T, method: K, label: string, order: string[]): void {
  const original = (target as Record<string, unknown>)[method] as (...args: unknown[]) => unknown;
  spyOnExport(target, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
    order.push(label);
    return original.apply(this, args);
  });
}

/** The first read of the session cookie from the keychain, as a step of the order. */
export function tapCookieRead(order: string[]): void {
  const original = SecureStore.getItem;
  spyOnExport(SecureStore as { getItem: typeof original }, 'getItem').mockImplementation(((key: string, ...rest: never[]) => {
    if (key === COOKIE_KEY) order.push('cookie');
    return (original as (k: string, ...r: never[]) => string | null)(key, ...rest);
  }) as never);
}

/** The device is signed out: nothing in the keychain. */
export async function emptyKeychain(): Promise<void> {
  await SecureStore.deleteItemAsync(COOKIE_KEY);
  await SecureStore.deleteItemAsync('exampleapp_session_data');
}
