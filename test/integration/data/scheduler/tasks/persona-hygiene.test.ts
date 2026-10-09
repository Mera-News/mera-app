// The persona-hygiene scheduler task on the REAL AppScheduler, driving the real hygiene sweep, the real
// topic-sanity audit and the gateway mock (real E2EE), with the session cookie in the (in-memory) keychain.
// The sweep is covered in services/cloud-persona/hygiene-sweep.test.ts; this file pins what the TASK adds:
// the LOCAL credential gate in front of a billed batch, what a gated run leaves behind (job done, lastRun
// NOT stamped, so the next tick retries), and what holds the weekly sweep back. Replaces
// lib/scheduler/tasks/__tests__/persona-hygiene-task.test.ts.
import { failSecureStore, gatewayCalls, mockGateway, secureStoreDump, server, setAppState } from '@/test/helpers';
import '@/lib/scheduler/tasks/persona-hygiene-task';

import * as SecureStore from 'expo-secure-store';

import { invalidateJwtCache } from '@/lib/auth-client';
import { addFact } from '@/lib/database/services/fact-service';
import { MIN_FACTS_FOR_SWEEP, getPendingCount } from '@/lib/database/services/hygiene-service';
import { getAll as getNotifications } from '@/lib/database/services/notification-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { useDatabaseStore } from '@/lib/stores/database-store';

import {
  DAY,
  HOUR,
  MIN,
  T0,
  advanceUntil,
  captureTaskLogs,
  conditionTypes,
  endTest,
  holdFeedSync,
  initScheduler,
  jobRows,
  jobStatuses,
  lastRunInStore,
  lastRunPersisted,
  registeredDefinition,
  resetCloudCallPath,
  runTask,
  sanityModel,
  setMode,
  settle,
  startTest,
} from './support';

const TASK = 'persona-hygiene';
const STAMP = 'hygiene_last_sweep_at';

/** `count` facts created 100 days before T0; fact 0 is the single word "News" (too broad: one cleanup proposed). */
async function seedPersona(count = MIN_FACTS_FOR_SWEEP) {
  jest.setSystemTime(T0 - 100 * DAY);
  for (let i = 0; i < count; i++) await addFact(i === 0 ? 'News' : `distinct interest number ${i}`);
  jest.setSystemTime(T0);
}

const cookieKey = () => {
  const key = Object.keys(secureStoreDump()).find((k) => k.endsWith('_cookie'));
  if (!key) throw new Error('no session cookie in the keychain');
  return key;
};

/** The device loses its session cookie (and the cached JWT with it). Returns a function that puts it back. */
async function loseCookie(): Promise<() => Promise<void>> {
  const key = cookieKey();
  const value = secureStoreDump()[key];
  await SecureStore.deleteItemAsync(key);
  invalidateJwtCache();
  return async () => {
    await SecureStore.setItemAsync(key, value);
    invalidateJwtCache();
  };
}

const hygieneRows = async () => (await getNotifications()).filter((n) => n.type === 'hygiene').map((n) => n.source);

beforeEach(async () => {
  resetCloudCallPath();
  await startTest(TASK, { signedIn: true });
  server.use(...mockGateway(sanityModel()));
});
afterEach(endTest);

describe('registration', () => {
  it('is a weekly timer-only task gated on db-ready plus exactly ONE custom idle check, exclusive, 90s, 2 attempts', () => {
    const def = registeredDefinition('@/lib/scheduler/tasks/persona-hygiene-task');

    expect(def).toMatchObject({
      name: TASK,
      frequency: 7 * DAY,
      // `triggers: []` is load-bearing: the tick catches it up on the interval, a foreground trigger would not.
      triggers: [],
      exclusive: true,
      timeout: 90_000,
      maxAttempts: 2,
    });
    expect(conditionTypes(def)).toEqual(['db-ready', 'custom']);
  });
});

describe('the credential gate', () => {
  it('with no session cookie it runs no sweep, makes no gateway call, writes nothing, and leaves lastRun UNSTAMPED', async () => {
    await seedPersona();
    await loseCookie();
    const logs = captureTaskLogs(TASK);

    expect(await runTask(TASK)).toBe('ran');

    expect(gatewayCalls()).toHaveLength(0);
    expect(await getSetting(STAMP)).toBeNull();
    expect(await getPendingCount()).toBe(0);
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBeNull();
    expect(await lastRunPersisted(TASK)).toBeNull();
    expect(logs()).toEqual(['hygiene sweep skipped \u2014 no local session credential']);
  });

  it('a keychain that THROWS on the cookie read (locked before first unlock) counts as no credential', async () => {
    await seedPersona();
    failSecureStore(cookieKey(), 'get');

    await runTask(TASK);

    expect(await getSetting(STAMP)).toBeNull();
    expect(await getPendingCount()).toBe(0);
    expect(lastRunInStore(TASK)).toBeNull();
  });

  it('with a credential the sweep runs: it proposes the cleanup, notifies once, stamps its cooldown and lastRun', async () => {
    await seedPersona();

    await runTask(TASK);

    expect(await getPendingCount()).toBe(1);
    expect(await hygieneRows()).toEqual(['hygiene']);
    expect(await getSetting(STAMP)).toBe(String(T0));
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
    expect(await lastRunPersisted(TASK)).toBe(lastRunInStore(TASK));
  });

  it('a sweep that is not eligible (too few facts) still stamps lastRun: only the missing credential is a markNoOp', async () => {
    await seedPersona(MIN_FACTS_FOR_SWEEP - 1);

    await runTask(TASK);

    expect(await getPendingCount()).toBe(0);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
  });

  it('an audit that was skipped (on-device mode: no cloud call) is NOT a markNoOp: lastRun is stamped, only the cooldown is withheld', async () => {
    await seedPersona();
    await setMode('on-device');
    const logs = captureTaskLogs(TASK);

    await runTask(TASK);

    expect(gatewayCalls()).toHaveLength(0);
    expect(await getSetting(STAMP)).toBeNull();
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
    expect(logs()[0]).toContain('sanity audit skipped');
  });
});

describe('on the tick', () => {
  it('without a credential every 5s tick retries; once the credential is back it sweeps ONCE and the weekly cadence arms', async () => {
    await seedPersona();
    const restore = await loseCookie();

    await initScheduler();
    await settle(30_000);
    const retries = (await jobRows(TASK)).length;
    expect(retries).toBeGreaterThanOrEqual(4);
    expect(lastRunInStore(TASK)).toBeNull();
    expect(gatewayCalls()).toHaveLength(0);

    await restore();
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the sweep after the credential returned', 20_000);
    const swept = (await jobRows(TASK)).length;
    expect(await getPendingCount()).toBe(1);

    await settle(HOUR);
    expect(await jobRows(TASK)).toHaveLength(swept);
  });

  it('a foreground return never starts it (no trigger): it waits for the interval', async () => {
    await seedPersona();
    const { saveLastRun } = await import('@/lib/scheduler/scheduler-persistence');
    await saveLastRun(TASK, T0);
    await initScheduler();

    setAppState('background');
    setAppState('active');
    await settle(MIN);

    expect(await jobRows(TASK)).toHaveLength(0);
  });

  it('is held back until the database is ready', async () => {
    await seedPersona();
    useDatabaseStore.setState({ ready: false });

    await initScheduler();
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);

    useDatabaseStore.setState({ ready: true });
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the sweep', 20_000);

    expect(await getPendingCount()).toBe(1);
  });

  it('the idle check holds it back while the feed sync runs, and releases it when that ends', async () => {
    await seedPersona();
    const feedSync = holdFeedSync();
    await feedSync.start();

    await initScheduler();
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);
    expect(await getSetting(STAMP)).toBeNull();

    await feedSync.release();
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the sweep', 20_000);

    expect(await getPendingCount()).toBe(1);
  });
});
