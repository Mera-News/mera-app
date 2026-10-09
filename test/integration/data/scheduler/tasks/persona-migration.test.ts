// The persona-migration scheduler task, registered with the REAL AppScheduler and driving the real
// one-time migration service on the in-memory DB. The service itself is covered in
// core/results/persona-migration.test.ts; this file pins what the TASK does with it: when it is
// eligible to start, what it leaves behind, that the second run is a cheap no-op that still arms the
// cadence, and that an interrupted run is resumed by the scheduler's own retry.
import { setAppState } from '@/test/helpers';
import '@/lib/scheduler/tasks/persona-migration-task';

import database from '@/lib/database';
import type FactModel from '@/lib/database/models/Fact';
import type TopicModel from '@/lib/database/models/Topic';
import { addFact } from '@/lib/database/services/fact-service';
import * as locationService from '@/lib/database/services/location-service';
import { getAll as getLocations } from '@/lib/database/services/location-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { PERSONA_V3_MIGRATION_KEY } from '@/lib/services/persona-migration-service';
import { useDatabaseStore } from '@/lib/stores/database-store';

import {
  HOUR,
  T0,
  advanceUntil,
  conditionTypes,
  endTest,
  initScheduler,
  jobRows,
  jobStatuses,
  lastRunInStore,
  lastRunPersisted,
  registeredDefinition,
  runTask,
  settle,
  startTest,
} from './support';

jest.setTimeout(30_000); // the tick tests step minutes of fake time, which an instrumented run can stretch

const TASK = 'persona-migration';
const setDbReady = (ready: boolean) => useDatabaseStore.setState({ ready });
const HOME = 'Lives in Nieuw-West, Amsterdam, Netherlands, Europe';

const topics = () => database.get<TopicModel>('topics').query().fetch();
const weights = async () =>
  Object.fromEntries((await database.get<FactModel>('facts').query().fetch()).map((f) => [f.statement, f.weight ?? null]));

beforeEach(async () => {
  await startTest(TASK);
  jest.spyOn(logger, 'captureException').mockImplementation(() => '');
});
afterEach(() => {
  endTest();
  jest.restoreAllMocks();
});

describe('registration', () => {
  it('is a 6 hour foreground task gated on exactly db-ready, exclusive, 60s, 3 attempts', () => {
    const def = registeredDefinition('@/lib/scheduler/tasks/persona-migration-task');

    expect(def).toMatchObject({
      name: TASK,
      frequency: 6 * HOUR,
      triggers: ['app-foreground'],
      exclusive: true,
      timeout: 60_000,
      maxAttempts: 3,
    });
    expect(conditionTypes(def)).toEqual(['db-ready']);
  });
});

describe('the handler', () => {
  it('migrates the persona: topic rows, fact weights, a location, the guard, and stamps lastRun', async () => {
    await addFact('Follows Formula 1', { topics: ['Formula 1', 'Grand Prix'] });
    await addFact(HOME);

    expect(await runTask(TASK)).toBe('ran');

    expect((await topics()).map((t) => t.text).sort()).toEqual(expect.arrayContaining(['Formula 1', 'Grand Prix']));
    const w = await weights();
    expect(w['Follows Formula 1']).not.toBeNull();
    expect(w[HOME]).not.toBeNull();
    expect((await getLocations()).map((l) => l.city)).toContain('Nieuw-West');
    expect(await getSetting(PERSONA_V3_MIGRATION_KEY)).toBe('done');
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBe(T0);
    expect(await lastRunPersisted(TASK)).toBe(T0);
  });

  it('a second run is a no-op that writes nothing, yet still stamps lastRun (a finished migration is not a markNoOp)', async () => {
    await addFact('Follows Formula 1', { topics: ['Formula 1'] });
    await runTask(TASK);
    const before = { topics: (await topics()).length, locations: (await getLocations()).length, weights: await weights() };
    await settle(10_000);

    expect(await runTask(TASK)).toBe('ran');

    expect({ topics: (await topics()).length, locations: (await getLocations()).length, weights: await weights() }).toEqual(before);
    expect(await jobStatuses(TASK)).toEqual(['completed', 'completed']);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0 + 10_000);
    expect(lastRunInStore(TASK)).toBe(await lastRunPersisted(TASK));
  });

  it('once the guard reads done it touches no fact, even one added later', async () => {
    await setSetting(PERSONA_V3_MIGRATION_KEY, 'done');
    await addFact('Follows Formula 1', { topics: ['Formula 1'] });

    await runTask(TASK);

    expect(await topics()).toEqual([]);
    expect(await weights()).toEqual({ 'Follows Formula 1': null });
    expect(lastRunInStore(TASK)).toBe(T0);
  });

  it('picks up from a guard left at pending', async () => {
    await setSetting(PERSONA_V3_MIGRATION_KEY, 'pending');
    await addFact('Follows Formula 1', { topics: ['Formula 1'] });

    await runTask(TASK);

    expect((await topics()).map((t) => t.text)).toEqual(['Formula 1']);
    expect(await getSetting(PERSONA_V3_MIGRATION_KEY)).toBe('done');
  });

  it('an interrupted run fails the job without stamping lastRun, and the scheduler retry (attempt 2, +30s) finishes it', async () => {
    await addFact(HOME);
    jest.spyOn(locationService, 'upsertLocation').mockRejectedValueOnce(new Error('disk full'));

    await runTask(TASK);

    expect(await getSetting(PERSONA_V3_MIGRATION_KEY)).toBe('pending');
    expect(lastRunInStore(TASK)).toBeNull();
    expect(await jobStatuses(TASK)).toEqual(['retrying']);
    expect(logger.captureException).toHaveBeenCalledTimes(1);

    await settle(30_000);
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the retry to finish', 30_000);

    const rows = await jobRows(TASK);
    expect(rows.map((r) => [r.attempt, r.status])).toEqual([[1, 'retrying'], [2, 'completed']]);
    expect(await getSetting(PERSONA_V3_MIGRATION_KEY)).toBe('done');
    expect((await getLocations()).map((l) => l.city)).toContain('Nieuw-West');
  });
});

describe('what starts it', () => {
  it('a foreground return runs it once the database is ready, and not before', async () => {
    setDbReady(false);
    await initScheduler();

    setAppState('background');
    setAppState('active');
    await settle(500);
    expect(await jobRows(TASK)).toHaveLength(0);

    setDbReady(true);
    setAppState('background');
    setAppState('active');
    await settle(500);

    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the foreground run', 5_000);
    expect(await jobStatuses(TASK)).toEqual(['completed']);
  });

  it('the 5s tick does not start a task whose cadence is not up (6h), and starts it once it is', async () => {
    await initScheduler(); // the initial tick: lastRun unknown, so due
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the first run', 5_000);
    expect(await jobRows(TASK)).toHaveLength(1);

    await settle(60 * 60_000); // an hour of ticks
    expect(await jobRows(TASK)).toHaveLength(1);

    await settle(6 * HOUR); // jitter is at most +20%
    expect((await jobRows(TASK)).length).toBeGreaterThanOrEqual(2);
  });
});
