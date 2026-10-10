// The `mera-background` wake, driven through the exported runners (`runBackgroundWake`,
// `runBackgroundRefresh`) over the REAL stack: the install boundary, the keychain, the auth breaker,
// the scoring pipeline, the feed-sync machine in background mode, the backup step, the in-memory DB,
// MSW and the gateway mock. Only the OS task registry and keep-awake are stand-ins.
//
// Replaces lib/background/__tests__/background-task.test.ts (the wake, quiet-exit and
// unexpected-throw blocks). Registration is in registration.test.ts. The legacy suite mocked the
// settings module, the install boundary, the auth client, the breaker, the pipeline, the fetch step
// and the backup step; every one of those runs for real here.
jest.mock('expo-task-manager', () => require('./native-fakes').taskManagerModule);
jest.mock('expo-background-task', () => require('./native-fakes').backgroundTaskModule);
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import * as Sentry from '@sentry/react-native';
import * as SecureStore from 'expo-secure-store';

import { _getBreakerState } from '@/lib/auth-failure-breaker';
import * as bgFeedSync from '@/lib/background/background-feed-sync';
import * as backupTask from '@/lib/background/backup-task';
import * as bgSettings from '@/lib/background/bg-refresh-settings';
import {
  DB_PROBE_TIMEOUT_MS,
  FETCH_START_RESERVE_MS,
  RUN_DEADLINE_MS,
  runBackgroundRefresh,
  runBackgroundWake,
} from '@/lib/background/background-task';
import { deleteSetting, getSetting } from '@/lib/database/services/setting-service';
import * as installBoundary from '@/lib/security/install-boundary';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { advanceUntilDone, failSecureStore, gatewayCalls, http, HttpResponse, mockGqlError, secureStoreDump } from '@/test/helpers';

import { BackgroundTaskResult, resetNativeTasks } from './native-fakes';
import {
  COOKIE_KEY,
  NOW,
  emptyKeychain,
  failSettingRead,
  hangSettingRead,
  recordPaths,
  rowsById,
  runFetch,
  seedInterest,
  sentryEvents,
  server,
  serveFresh,
  spyOnExport,
  tap,
  tapCookieRead,
  toastsShown,
  wakeCleanup,
  wakeWorld,
} from './support';

jest.setTimeout(60_000);

beforeEach(async () => {
  resetNativeTasks();
  await wakeWorld();
});
afterEach(wakeCleanup);

/** Everything the wake touches, in the order it was first reached. */
function observe(): string[] {
  const order: string[] = [];
  tap(bgSettings, 'isBgRefreshEnabled', 'toggle', order);
  tap(installBoundary, 'enforceInstallBoundary', 'boundary', order);
  tapCookieRead(order);
  tap(pipeline, 'advanceWaitingForBackground', 'collect', order);
  tap(bgFeedSync, 'runBackgroundFeedSync', 'fetch', order);
  tap(backupTask, 'runScheduledBackup', 'backup', order);
  return order;
}
const firstReached = (order: string[]) => [...new Set(order)];

/** A normal state of a device: no event, no toast, no logout, and the session kept where it was. */
function expectQuiet(paths: string[], opts: { sessionKept: boolean }) {
  expect(sentryEvents()).toEqual([]);
  expect(toastsShown()).toEqual([]);
  expect(paths.filter((p) => p.includes('sign-out'))).toEqual([]);
  if (opts.sessionKept) expect(Object.keys(secureStoreDump())).toContain(COOKIE_KEY);
}

describe('the order of a wake', () => {
  it('toggle, install boundary, keychain, collect, fetch, then backup', async () => {
    const order = observe();

    await advanceUntilDone(runBackgroundWake());

    expect(firstReached(order)).toEqual(['toggle', 'boundary', 'cookie', 'collect', 'fetch', 'backup']);
  });

  it('is the whole job end to end: fresh articles fetched and persisted, submitted for scoring, the ledger kept', async () => {
    const { fresh } = await serveFresh(3);

    const result = await advanceUntilDone(runBackgroundWake());

    expect(result).toBe(BackgroundTaskResult.Success);
    expect([...(await rowsById()).keys()].sort()).toEqual([...fresh].sort());
    expect(gatewayCalls('job').length).toBeGreaterThan(0); // the bounded submit reached the gateway
    expect(await getSetting('bg_articles_charged:2026-10-09')).toBe('3');
    expect(sentryEvents()).toEqual([]);
  });

  it('gives the collect and the fetch the same 60s deadline', async () => {
    const collect = jest.spyOn(pipeline, 'advanceWaitingForBackground');
    const fetch = jest.spyOn(bgFeedSync, 'runBackgroundFeedSync');

    await advanceUntilDone(runBackgroundRefresh(NOW));

    expect(RUN_DEADLINE_MS).toBe(60_000);
    expect(collect).toHaveBeenCalledWith({ deadlineAt: NOW + 60_000 });
    expect(fetch).toHaveBeenCalledWith({ deadlineAt: NOW + 60_000 });
    collect.mockRestore();
    fetch.mockRestore();
  });

  it('still backs up when the refresh is off', async () => {
    await bgSettings.setBgRefreshEnabled(false);
    const order = observe();

    await advanceUntilDone(runBackgroundWake());

    expect(firstReached(order)).toEqual(['toggle', 'backup']);
  });
});

describe('the fetch needs 15s left', () => {
  it('starts no fetch with less than 15s of the budget left, but has already collected', async () => {
    const order = observe();
    const asked = recordPaths();
    await seedInterest('I follow racing', ['formula 1']);

    // 50s of the 60s budget are gone: 10s left.
    const out = await advanceUntilDone(runBackgroundRefresh(NOW - 50_000));

    expect(out).toEqual({ stoppedBy: 'deadline' });
    expect(firstReached(order)).toEqual(['toggle', 'boundary', 'cookie', 'collect']);
    expect(asked.filter((p) => p.endsWith('/graphql'))).toEqual([]);
    expect(sentryEvents()).toEqual([]);
  });

  it('starts the fetch with exactly 15s left', async () => {
    const order = observe();

    const out = await advanceUntilDone(runBackgroundRefresh(NOW - (RUN_DEADLINE_MS - FETCH_START_RESERVE_MS)));

    expect(out.stoppedBy).toBe('done');
    expect(firstReached(order)).toContain('fetch');
  });
});

describe('every normal state of a device exits quietly', () => {
  it('toggle off: stops at the first read, and the wake still backs up', async () => {
    await bgSettings.setBgRefreshEnabled(false);
    const order = observe();
    const paths = recordPaths();

    expect(await advanceUntilDone(runBackgroundRefresh(NOW))).toEqual({ stoppedBy: 'disabled' });

    expect(order).toEqual(['toggle']);
    expectQuiet(paths, { sessionKept: true });
  });

  it('a first read that never answers is the DB probe timing out after 3s: db-unavailable, a breadcrumb only', async () => {
    hangSettingRead(bgSettings.BG_REFRESH_ENABLED_KEY);
    const order = observe();
    const paths = recordPaths();
    let outcome: unknown;
    void runBackgroundRefresh(NOW).then((o) => (outcome = o));

    await jest.advanceTimersByTimeAsync(DB_PROBE_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined(); // still waiting at 2999ms
    await jest.advanceTimersByTimeAsync(1);
    await advanceUntilDone(Promise.resolve());

    expect(outcome).toEqual({ stoppedBy: 'db-unavailable' });
    expect(order).toEqual(['toggle']);
    expect((Sentry.addBreadcrumb as jest.Mock).mock.calls.map((c) => c[0].message)).toContain('background: database unavailable');
    expectQuiet(paths, { sessionKept: true });
  });

  it('a first read that throws is the same: db-unavailable, nothing sent', async () => {
    failSettingRead(bgSettings.BG_REFRESH_ENABLED_KEY);
    const order = observe();
    const paths = recordPaths();

    expect(await advanceUntilDone(runBackgroundRefresh(NOW))).toEqual({ stoppedBy: 'db-unavailable' });

    expect(order).toEqual(['toggle']);
    expect(paths).toEqual([]);
    expectQuiet(paths, { sessionKept: true });
  });

  it('a database that cannot be read still lets the wake reach the backup step and report success', async () => {
    hangSettingRead(bgSettings.BG_REFRESH_ENABLED_KEY);
    const order = observe();
    const wake = runBackgroundWake();

    await advanceUntilDone(Promise.resolve(), DB_PROBE_TIMEOUT_MS + 100);
    expect(await advanceUntilDone(wake)).toBe(BackgroundTaskResult.Success);

    expect(firstReached(order)).toEqual(['toggle', 'backup']);
  });

  it('signed out (an empty keychain): nothing is collected or fetched, and nothing is signed out', async () => {
    await emptyKeychain();
    const order = observe();
    const paths = recordPaths();

    expect(await advanceUntilDone(runBackgroundRefresh(NOW))).toEqual({ stoppedBy: 'signed-out' });

    expect(firstReached(order)).toEqual(['toggle', 'boundary', 'cookie']);
    expect(paths.filter((p) => p.endsWith('/graphql'))).toEqual([]);
    expectQuiet(paths, { sessionKept: false });
  });

  // DA35 (DATA-U15-1). A keychain that throws (locked since reboot) exits `locked`, read async and directly:
  // the SecureStore adapter's sync read swallows the throw and answers null. Both exits are quiet.
  it('DA35: a keychain that throws on read (locked since reboot) exits locked', async () => {
    failSecureStore(COOKIE_KEY, 'get', new Error('errSecInteractionNotAllowed'));
    const paths = recordPaths();

    expect(await advanceUntilDone(runBackgroundRefresh(NOW))).toEqual({ stoppedBy: 'locked' });

    expectQuiet(paths, { sessionKept: true });
  });

  it('a cookie blob that makes the probe itself throw exits locked, quietly: the only way into that branch', async () => {
    // better-auth parses the stored JSON and reads `.expires` of each member: a null member throws.
    await SecureStore.setItemAsync(COOKIE_KEY, '{"better-auth.session_token":null}');
    const order = observe();
    const paths = recordPaths();

    expect(await advanceUntilDone(runBackgroundRefresh(NOW))).toEqual({ stoppedBy: 'locked' });

    expect(firstReached(order)).toEqual(['toggle', 'boundary', 'cookie']);
    expectQuiet(paths, { sessionKept: true });
  });

  it('an offline fetch is a result, not an exception', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    server.use(mockGqlError('GetArticleIdsForPersona', 'INTERNAL_SERVER_ERROR', { httpStatus: 500 }));

    const out = await advanceUntilDone(runBackgroundRefresh(NOW));

    expect(out).toEqual({ stoppedBy: 'done', fetch: 'error' });
  });
});

describe('the install boundary comes before any cookie read', () => {
  it('a device whose settings are fresh looks like a new install: the surviving session is cleared and the wake ends signed-out', async () => {
    await deleteSetting('has_launched'); // the marker an app update keeps and a reinstall loses
    const paths = recordPaths();

    expect(await advanceUntilDone(runBackgroundRefresh(NOW))).toEqual({ stoppedBy: 'signed-out' });

    expect(Object.keys(secureStoreDump())).not.toContain(COOKIE_KEY);
    expect(await getSetting('has_launched')).toBe('1');
    expect(paths.filter((p) => p.endsWith('/graphql'))).toEqual([]);
    expect(sentryEvents()).toEqual([]);
  });

  it('releases the read latch, so the stored cookie is seen', async () => {
    const out = await advanceUntilDone(runBackgroundRefresh(NOW));

    expect(out.stoppedBy).toBe('done');
  });
});

describe('a 401 inside the wake', () => {
  // Every GraphQL operation answers 401: one that succeeded would reset the breaker and hide the count.
  const dead = () =>
    http.post('*/graphql', () =>
      HttpResponse.json({ errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }] }, { status: 401 }),
    );

  it('does not feed the auth breaker, and the session stays', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    server.use(dead());
    const paths = recordPaths();

    const out = await advanceUntilDone(runBackgroundRefresh(NOW));

    expect(out).toEqual({ stoppedBy: 'done', fetch: 'error' });
    expect(_getBreakerState()).toEqual({ consecutiveFailures: 0, breakerOpen: false, recheckInFlight: false });
    expectQuiet(paths, { sessionKept: true });
  });

  it('control: the same 401 outside the task scope, with the app in the background, does count', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    server.use(dead());
    // The wake's steps up to the fetch, minus the scope.
    const { enforceInstallBoundary } = installBoundary;
    await enforceInstallBoundary();

    await advanceUntilDone(runFetch());

    const state = _getBreakerState();
    expect(state.consecutiveFailures).toBeGreaterThan(0);
  });
});

describe('an unexpected throw', () => {
  it('is reported once, with its step, and the wake still backs up', async () => {
    // The fetch step reads last_foreground_at first and does not catch it.
    failSettingRead(bgSettings.LAST_FOREGROUND_AT_KEY);
    const order = observe();

    const result = await advanceUntilDone(runBackgroundWake());

    expect(result).toBe(BackgroundTaskResult.Success);
    expect((Sentry.captureException as jest.Mock).mock.calls).toHaveLength(1);
    expect((Sentry.captureException as jest.Mock).mock.calls[0][1].tags).toEqual({ service: 'background-task', step: 'refresh' });
    expect(firstReached(order)).toContain('backup');
    expect(toastsShown()).toEqual([]);
  });

  it('a backup step that throws is reported once, with its step, and the wake still reports success', async () => {
    // runScheduledBackup never throws on its own; a one-call fault stands in for the lazy require
    // handing back a step that does (R23: the require returns the same module object).
    spyOnExport(backupTask, 'runScheduledBackup').mockRejectedValueOnce(new Error('backup step died'));

    const result = await advanceUntilDone(runBackgroundWake());

    expect(result).toBe(BackgroundTaskResult.Success);
    const captured = (Sentry.captureException as jest.Mock).mock.calls;
    expect(captured).toHaveLength(1);
    expect(captured[0][1].tags).toEqual({ service: 'background-task', step: 'backup' });
  });
});
