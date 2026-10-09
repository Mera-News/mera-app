// The feedback-cycle scheduler task on the REAL AppScheduler, driving the real optimisation cycle: real
// article-feedback rows, the real digest, the stored plan, the notification, and the gateway mock (real
// E2EE) for the one organise call. The cycle itself is covered in
// services/cloud-persona/optimisation-plan.test.ts; this file pins what the TASK adds: it is timer-only,
// idle-gated, a skipped cycle is an ordinary completed run, and a failing cycle fails the job and is
// retried by the scheduler. Replaces lib/scheduler/tasks/__tests__/feedback-cycle-task.test.ts.
import { gatewayCalls, mockGateway, server, setAppState } from '@/test/helpers';
import '@/lib/scheduler/tasks/feedback-cycle-task';

import { recordArticleFeedback } from '@/lib/database/services/article-feedback-service';
import { addFact } from '@/lib/database/services/fact-service';
import { getAll as getNotifications } from '@/lib/database/services/notification-service';
import * as optimisationPlan from '@/lib/database/services/optimisation-plan-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { createTopics } from '@/lib/database/services/topic-service';
import logger from '@/lib/logger';
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
  setMode,
  settle,
  startTest,
} from './support';

const TASK = 'feedback-cycle';
const LAST_RUN = 'optimisation_last_run_at';
const TREE = { aLotMore: ['more_about_topic', 'a_lot_more'], kindOfEvent: ['not_important_to_me', 'this_kind_of_event'] };

async function verdict(article: string, sentiment: 'like' | 'dislike', ctx: Record<string, unknown>, at: number) {
  jest.setSystemTime(at);
  await recordArticleFeedback({
    articleId: article,
    sentiment,
    title: `Story ${article}`,
    contextJson: JSON.stringify(ctx),
  });
}

/** Two topics and the three verdicts of the usual day: two nudges and one "fewer obituaries". */
async function actionableDay() {
  const fact = await addFact('Follows climate and space');
  const [climate, space] = await createTopics([
    { factId: fact.id, text: 'Climate', weight: 0.5, provenance: 'llm', status: 'active' },
    { factId: fact.id, text: 'Space', weight: 0.5, provenance: 'llm', status: 'active' },
  ]);
  const at = T0 - DAY;
  await verdict('a1', 'like', { matchedTopics: [{ topicId: climate.id, text: 'Climate' }], treePath: TREE.aLotMore }, at);
  await verdict('a2', 'dislike', { eventType: 'obituary', treePath: TREE.kindOfEvent }, at + 1000);
  await verdict('a3', 'like', { matchedTopics: [{ topicId: space.id, text: 'Space' }], treePath: TREE.aLotMore }, at + 2000);
  jest.setSystemTime(T0);
}

const planNotifications = async () => (await getNotifications()).filter((n) => n.type === 'optimisation_plan').length;

beforeEach(async () => {
  resetCloudCallPath();
  await startTest(TASK, { signedIn: true });
  server.use(...mockGateway(() => 'no plan today')); // a reply that parses to nothing: the deterministic plan
});
afterEach(() => {
  endTest();
  jest.restoreAllMocks();
});

describe('registration', () => {
  it('is a 3 hour TIMER-ONLY task gated on db-ready plus exactly ONE custom idle check, exclusive, 30s, 2 attempts', () => {
    const def = registeredDefinition('@/lib/scheduler/tasks/feedback-cycle-task');

    expect(def).toMatchObject({
      name: TASK,
      frequency: 3 * HOUR,
      triggers: [],
      exclusive: true,
      timeout: 30_000,
      maxAttempts: 2,
    });
    expect(conditionTypes(def)).toEqual(['db-ready', 'custom']);
  });
});

describe('the handler', () => {
  it('runs the cycle: one organise call, a stored plan, the plan notification, the cooldown stamp, and lastRun', async () => {
    await actionableDay();
    const logs = captureTaskLogs(TASK);

    expect(await runTask(TASK)).toBe('ran');

    expect(gatewayCalls()).toHaveLength(1);
    const plan = await optimisationPlan.getPendingPlan();
    expect(plan).not.toBeNull();
    expect(plan!.autoChanges.length + plan!.reviewItems.length).toBeGreaterThan(0);
    expect(logs()).toEqual([
      `optimisation cycle complete — ${plan!.autoChanges.length} auto + ${plan!.reviewItems.length} review`,
    ]);
    expect(await planNotifications()).toBe(1);
    expect(await getSetting(LAST_RUN)).not.toBeNull();
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
    expect(await lastRunPersisted(TASK)).toBe(lastRunInStore(TASK));
  });

  it('with too few verdicts it logs the reason, calls no model and STILL stamps lastRun (a skip is not a markNoOp)', async () => {
    const logs = captureTaskLogs(TASK);

    await runTask(TASK);

    expect(logs()).toEqual(['optimisation cycle skipped — too_few_signals']);
    expect(gatewayCalls()).toHaveLength(0);
    expect(await optimisationPlan.getPendingPlan()).toBeNull();
    expect(await getSetting(LAST_RUN)).toBeNull();
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
  });

  it('a second run inside the cycle cooldown skips with the cooldown reason and adds no plan or notification', async () => {
    await actionableDay();
    await runTask(TASK);
    await settle(5_000);
    const logs = captureTaskLogs(TASK);

    await runTask(TASK);

    expect(logs()).toEqual(['optimisation cycle skipped — cooldown']);
    expect(gatewayCalls()).toHaveLength(1);
    expect(await planNotifications()).toBe(1);
  });

  it('on-device it never calls the cloud AI and skips', async () => {
    await actionableDay();
    await setMode('on-device');
    const logs = captureTaskLogs(TASK);

    await runTask(TASK);

    expect(logs()).toEqual(['optimisation cycle skipped — on_device']);
    expect(gatewayCalls()).toHaveLength(0);
    expect(await getSetting(LAST_RUN)).toBeNull();
  });

  it('a failing cycle fails the job without stamping lastRun, and the scheduler retry (attempt 2, +30s) completes it', async () => {
    await actionableDay();
    jest.spyOn(logger, 'captureException').mockImplementation(() => '');
    jest.spyOn(optimisationPlan, 'runOptimisationCycle').mockRejectedValueOnce(new Error('boom'));

    await runTask(TASK);

    expect(await jobStatuses(TASK)).toEqual(['retrying']);
    expect(lastRunInStore(TASK)).toBeNull();

    await settle(31_000);
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the retry to finish', 30_000);

    expect((await jobRows(TASK)).map((r) => [r.attempt, r.status])).toEqual([[1, 'retrying'], [2, 'completed']]);
    expect(await optimisationPlan.getPendingPlan()).not.toBeNull();
  });
});

describe('on the tick', () => {
  it('a skipped cycle arms the 3h cadence: an hour of 5s ticks runs it exactly once', async () => {
    await initScheduler();
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the first run', 10_000);
    await settle(HOUR);

    expect(await jobRows(TASK)).toHaveLength(1);
  });

  it('a foreground return never starts it (no trigger)', async () => {
    const { saveLastRun } = await import('@/lib/scheduler/scheduler-persistence');
    await saveLastRun(TASK, T0);
    await initScheduler();

    setAppState('background');
    setAppState('active');
    await settle(MIN);

    expect(await jobRows(TASK)).toHaveLength(0);
  });

  it('is held back until the database is ready', async () => {
    await actionableDay();
    useDatabaseStore.setState({ ready: false });

    await initScheduler();
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);

    useDatabaseStore.setState({ ready: true });
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the cycle', 20_000);

    expect(await optimisationPlan.getPendingPlan()).not.toBeNull();
  });

  it('the idle check holds it back while the feed sync runs, and releases it when that ends', async () => {
    await actionableDay();
    const feedSync = holdFeedSync();
    await feedSync.start();

    await initScheduler();
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);
    expect(gatewayCalls()).toHaveLength(0);

    await feedSync.release();
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the cycle', 20_000);

    expect(await optimisationPlan.getPendingPlan()).not.toBeNull();
  });
});
