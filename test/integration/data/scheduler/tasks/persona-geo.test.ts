// The persona-geo scheduler task on the REAL AppScheduler, driving the real geo-derivation sweep on the
// in-memory DB. The sweep itself is covered in services/cloud-persona/geo-derivation.test.ts; this file
// pins what the TASK does around it: what holds it back, what it writes, and above all that an
// ineligible run (the common state, behind a 24h cooldown) RETURNS and arms the cadence. A markNoOp
// there would leave lastRun unstamped and re-fire the task on every 5s tick forever.
import { gatewayCalls } from '@/test/helpers';
import '@/lib/scheduler/tasks/persona-geo-task';

import { addFact } from '@/lib/database/services/fact-service';
import { getAll as getLocations } from '@/lib/database/services/location-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { useDatabaseStore } from '@/lib/stores/database-store';

import {
  DAY,
  HOUR,
  MIN,
  T0,
  advanceUntil,
  conditionTypes,
  endTest,
  holdFeedSync,
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

const TASK = 'persona-geo';
const LAST_RUN = 'geo_derivation_last_run_at';
const FINGERPRINT = 'geo_derivation_fact_fingerprint';
const AMSTERDAM = 'Lives in Amsterdam, Netherlands';

const places = async () => (await getLocations()).map((l) => ({ countryCode: l.countryCode, city: l.city, role: l.role }));

beforeEach(async () => {
  await startTest(TASK);
});
afterEach(endTest);

describe('registration', () => {
  it('is a daily foreground task gated on db-ready plus exactly ONE custom idle check, exclusive, 30s, 2 attempts', () => {
    const def = registeredDefinition('@/lib/scheduler/tasks/persona-geo-task');

    expect(def).toMatchObject({
      name: TASK,
      frequency: DAY,
      triggers: ['app-foreground'],
      exclusive: true,
      timeout: 30_000,
      maxAttempts: 2,
    });
    expect(conditionTypes(def)).toEqual(['db-ready', 'custom']);
  });
});

describe('the handler', () => {
  it('derives a country from a fact, with no model call, and stamps lastRun (store and persisted)', async () => {
    await addFact(AMSTERDAM);

    expect(await runTask(TASK)).toBe('ran');

    expect(await places()).toEqual([{ countryCode: 'NL', city: 'Amsterdam', role: 'home' }]);
    expect(gatewayCalls()).toHaveLength(0);
    expect(await getSetting(LAST_RUN)).toBe(String(T0));
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBe(T0);
    expect(await lastRunPersisted(TASK)).toBe(T0);
  });

  it('inside the sweep cooldown it adds nothing and STILL stamps lastRun (a routine skip is not a markNoOp)', async () => {
    await addFact(AMSTERDAM);
    await setSetting(LAST_RUN, String(T0 - HOUR));

    await runTask(TASK);

    expect(await places()).toEqual([]);
    expect(await getSetting(LAST_RUN)).toBe(String(T0 - HOUR)); // the sweep's own stamp is untouched
    expect(lastRunInStore(TASK)).toBe(T0);
    expect(await lastRunPersisted(TASK)).toBe(T0);
  });

  it('with no facts it returns and stamps lastRun', async () => {
    await runTask(TASK);

    expect(await places()).toEqual([]);
    expect(await getSetting(FINGERPRINT)).toBeNull();
    expect(lastRunInStore(TASK)).toBe(T0);
  });

  it('with facts it already swept (same fingerprint) it adds nothing and stamps lastRun', async () => {
    await addFact(AMSTERDAM);
    await runTask(TASK);
    await setSetting(LAST_RUN, String(T0 - 2 * DAY)); // the cooldown has passed; the facts have not changed
    await settle(5_000);

    await runTask(TASK);

    expect(await places()).toEqual([{ countryCode: 'NL', city: 'Amsterdam', role: 'home' }]);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0 + 5_000);
  });
});

describe('on the tick', () => {
  it('an ineligible run arms the daily cadence: an hour of 5s ticks starts it exactly once', async () => {
    await addFact(AMSTERDAM);
    await setSetting(LAST_RUN, String(T0 - HOUR)); // cooling down

    await initScheduler();
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the first run', 10_000);
    await settle(HOUR);

    expect(await jobRows(TASK)).toHaveLength(1);
    expect(await places()).toEqual([]);
  });

  it('is held back until the database is ready', async () => {
    await addFact(AMSTERDAM);
    useDatabaseStore.setState({ ready: false });

    await initScheduler();
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);

    useDatabaseStore.setState({ ready: true });
    await settle(10_000);

    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(await places()).toHaveLength(1);
  });

  it('the idle check holds it back while the feed sync runs, and releases it when that ends', async () => {
    await addFact(AMSTERDAM);
    const feedSync = holdFeedSync();
    await feedSync.start();

    await initScheduler();
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);
    expect(await places()).toEqual([]);

    await feedSync.release();
    await settle(10_000);

    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(await places()).toHaveLength(1);
  });
});
