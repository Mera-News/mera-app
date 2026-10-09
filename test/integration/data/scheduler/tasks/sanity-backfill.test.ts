// The sanity-backfill scheduler task on the REAL AppScheduler, driving the real chunked topic-sanity
// backfill, the real audit and queue, and the gateway mock (real E2EE). The service is covered in
// services/cloud-persona/sanity-backfill.test.ts; this file pins what the TASK does with it: what holds
// it back, that a chunk advances the cursor, that a skipped run still arms the 6h cadence, and that
// the finished pass costs one settings read per run.
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import '@/lib/scheduler/tasks/sanity-backfill-task';

import { getPendingCount } from '@/lib/database/services/hygiene-service';
import * as topicSanity from '@/lib/database/services/topic-sanity-service';
import logger from '@/lib/logger';
import { getSetting } from '@/lib/database/services/setting-service';
import { useDatabaseStore } from '@/lib/stores/database-store';

import {
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
  seedFactWithTopics,
  setMode,
  settle,
  startTest,
} from './support';

jest.setTimeout(30_000); // the tick tests step minutes of fake time, which an instrumented run can stretch

const TASK = 'sanity-backfill';
const CURSOR = 'sanity_audited_through_ms';
const STARTED = 'sanity_backfill_started_at';
const DONE = 'sanity_backfill_done_at';
const AUDITED = 'sanity_backfill_audited_count';
const BAD = 'Amsterdam cricket festival music tech';

beforeEach(async () => {
  resetCloudCallPath();
  await startTest(TASK, { signedIn: true });
  server.use(...mockGateway(sanityModel()));
});
afterEach(() => {
  endTest();
  jest.restoreAllMocks();
});

/** A fact whose topics are `cricket topic 0..n-1`, plus the contaminated one when asked. */
async function corpus(count: number, withBad = false) {
  await seedFactWithTopics('Follows Indian cricket', [
    ...Array.from({ length: count }, (_, i) => `cricket topic ${i}`),
    ...(withBad ? [BAD] : []),
  ]);
}

describe('registration', () => {
  it('is a 6 hour foreground task gated on db-ready plus exactly ONE custom idle check, exclusive, 90s, 2 attempts', () => {
    const def = registeredDefinition('@/lib/scheduler/tasks/sanity-backfill-task');

    expect(def).toMatchObject({
      name: TASK,
      frequency: 6 * HOUR,
      triggers: ['app-foreground'],
      exclusive: true,
      timeout: 90_000,
      maxAttempts: 2,
    });
    expect(conditionTypes(def)).toEqual(['db-ready', 'custom']);
  });
});

describe('the handler', () => {
  it('audits a chunk through the gateway, advances the cursor and the count, proposes the bad topic, stamps lastRun', async () => {
    await corpus(5, true);

    expect(await runTask(TASK)).toBe('ran');

    expect(gatewayCalls('batch')).toHaveLength(1);
    expect(await getSetting(STARTED)).not.toBeNull();
    expect(await getSetting(AUDITED)).toBe('6');
    expect(Number(await getSetting(CURSOR))).toBeGreaterThan(0);
    expect(await getSetting(DONE)).toBeNull(); // a chunk that found work is not the end of the pass
    expect(await getPendingCount()).toBe(1);
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    // The gateway limiter spaces its calls on the fake clock, so the run ends a moment after T0.
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
    expect(await lastRunPersisted(TASK)).toBe(lastRunInStore(TASK));
  });

  it('the next chunk continues past the cursor, finds nothing left and completes the pass; later runs ask nobody', async () => {
    await corpus(5);
    await runTask(TASK);
    const cursor = await getSetting(CURSOR);
    await settle(5_000);

    await runTask(TASK);
    expect(await getSetting(DONE)).not.toBeNull();
    expect(await getSetting(CURSOR)).toBe(cursor);
    const calls = gatewayCalls('batch').length;
    await settle(5_000);

    await runTask(TASK);

    expect(gatewayCalls('batch')).toHaveLength(calls);
    expect(await jobStatuses(TASK)).toEqual(['completed', 'completed', 'completed']);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0 + 10_000);
  });

  it('with no facts it skips, audits nothing, does not finish the pass and STILL stamps lastRun (a routine skip is not a markNoOp)', async () => {
    await runTask(TASK);

    expect(gatewayCalls()).toHaveLength(0);
    expect(await getSetting(DONE)).toBeNull();
    expect(await getSetting(AUDITED)).toBeNull();
    expect(lastRunInStore(TASK)).toBe(T0);
  });

  it('on-device it never calls the cloud AI, starts no pass, and still stamps lastRun', async () => {
    await corpus(5, true);
    await setMode('on-device');

    await runTask(TASK);

    expect(gatewayCalls()).toHaveLength(0);
    expect(await getSetting(STARTED)).toBeNull();
    expect(await getSetting(CURSOR)).toBeNull();
    expect(lastRunInStore(TASK)).toBe(T0);
  });
});

describe('a chunk that fails', () => {
  it('is not done and not a markNoOp: the task logs "retrying next tick", the pass stays open, and lastRun is stamped', async () => {
    await corpus(3);
    jest.spyOn(logger, 'captureException').mockImplementation(() => '');
    jest.spyOn(topicSanity, 'runSanityAudit').mockRejectedValueOnce(new Error('audit blew up'));
    const logs = captureTaskLogs(TASK);

    await runTask(TASK);

    expect(logs()).toEqual(['sanity backfill skipped \u2014 retrying next tick']);
    expect(await getSetting(DONE)).toBeNull();
    expect(await getSetting(AUDITED)).toBeNull();
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
  });
});

describe('on the tick', () => {
  it('a skipped run arms the 6h cadence: an hour of 5s ticks starts it exactly once', async () => {
    await initScheduler();
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the first run', 10_000);
    await settle(HOUR);

    expect(await jobRows(TASK)).toHaveLength(1);
  });

  it('is held back until the database is ready', async () => {
    await corpus(3);
    useDatabaseStore.setState({ ready: false });

    await initScheduler();
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);

    useDatabaseStore.setState({ ready: true });
    await settle(10_000);

    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(await getSetting(AUDITED)).toBe('3');
  });

  it('the idle check holds it back while the feed sync runs, and releases it when that ends', async () => {
    await corpus(3);
    const feedSync = holdFeedSync();
    await feedSync.start();

    await initScheduler();
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);
    expect(gatewayCalls()).toHaveLength(0);

    await feedSync.release();
    await settle(10_000);

    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(await getSetting(AUDITED)).toBe('3');
  });
});
