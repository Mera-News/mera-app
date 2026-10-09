// The inference-recover scheduler task on the REAL AppScheduler, driving the real recovery steps on the
// in-memory DB: cycle recovery, the stale-pending-fact rescue, the unweighted-topic repair, the staged
// topic-delete flush, the combination-pass resume and the open-facts-draft recovery. Each service has its
// own seam tests; this file pins what the TASK does with them. Replaces
// lib/scheduler/tasks/__tests__/inference-recover-task.test.ts.
//
// The task is event-only (frequency 0, foreground), gated on db-ready ONLY (a needsReauth window or an
// offline app must not starve the self-heal), and never calls markNoOp ("nothing to rescue" is the
// normal state, and a markNoOp there is a silent 5 second loop).
import { advanceUntilDone, setAppState } from '@/test/helpers';
import {
  BACKGROUND_COLLECT_WAIT_MS,
  __resetColdStartLatchForTests,
} from '@/lib/scheduler/tasks/inference-recover-task';

import { Q } from '@nozbe/watermelondb';

import database from '@/lib/database';
import type InferenceJobModel from '@/lib/database/models/InferenceJob';
import type TopicModel from '@/lib/database/models/Topic';
import { trackBackgroundCollect } from '@/lib/background/collect-gate';
import * as comboPass from '@/lib/database/services/combo-pass-service';
import { addFact, getTopicsStatus } from '@/lib/database/services/fact-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { __resetPendingForTests, deleteTopicWithDecline } from '@/lib/database/services/topic-decline-service';
import { beginTopicGeneration } from '@/lib/database/services/topic-generation-status-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { FACTS_DRAFT_OPEN_KEY, openFactsDraft } from '@/lib/services/facts-draft-service';
import logger from '@/lib/logger';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useDatabaseStore } from '@/lib/stores/database-store';

import {
  MIN,
  T0,
  captureTaskLogs,
  conditionTypes,
  endTest,
  initScheduler,
  jobRows,
  jobStatuses,
  lastRunInStore,
  lastRunPersisted,
  registerFeedSyncCounter,
  registeredDefinition,
  resetCloudCallPath,
  runTask,
  setMode,
  settle,
  startTest,
} from './support';

const TASK = 'inference-recover';
const STALE_MS = 11 * MIN; // PENDING_TOPICS_STALE_MS is 10 minutes

const comboJobs = async () =>
  (await database.get<InferenceJobModel>('inference_jobs').query(Q.where('job_type', 'topic_combo')).fetch()).map((j) => ({
    status: j.status,
    factId: (j.payload as { factId?: string }).factId,
  }));
const topicRows = async () =>
  (await database.get<TopicModel>('topics').query().fetch()).map((t) => ({ text: t.text, weight: t.weight, provenance: t.provenance }));

/** A fact stamped 'pending' a while ago whose generation job is long gone. */
async function stalePendingFact() {
  const fact = await addFact('Follows Formula 1');
  jest.setSystemTime(T0 - STALE_MS);
  await beginTopicGeneration([fact.id]);
  jest.setSystemTime(T0);
  return fact;
}

let releaseCollect: (() => void) | null = null;
beforeEach(async () => {
  resetCloudCallPath();
  __resetColdStartLatchForTests();
  __resetPendingForTests();
  comboPass.__resetComboPassForTests();
  await startTest(TASK);
  await setMode('cloud');
});
afterEach(() => {
  releaseCollect?.(); // the collect gate keeps one promise in module memory
  releaseCollect = null;
  endTest();
  jest.restoreAllMocks();
});

describe('registration', () => {
  it('is event-only: frequency 0, foreground, gated on db-ready ALONE (not network, not authenticated), exclusive, 120s, one attempt', () => {
    const def = registeredDefinition('@/lib/scheduler/tasks/inference-recover-task');

    expect(def).toMatchObject({
      name: TASK,
      frequency: 0,
      triggers: ['app-foreground'],
      exclusive: true,
      timeout: 120_000,
      maxAttempts: 1,
    });
    expect(conditionTypes(def)).toEqual(['db-ready']);
    expect(BACKGROUND_COLLECT_WAIT_MS).toBe(20_000);
  });
});

describe('the recovery steps', () => {
  it('rescues a fact stuck at pending with no live job, repairs an unqueryable topic, and commits a staged topic delete', async () => {
    const stuck = await stalePendingFact();
    const fact = await addFact('Follows racing');
    const [dead, staged] = await createTopics([
      { factId: fact.id, text: 'Formula 1', weight: 0, provenance: 'user', status: 'active' },
      { factId: fact.id, text: 'Grand Prix', weight: 0.75, provenance: 'llm', status: 'active' },
    ]);
    await deleteTopicWithDecline(staged.id, { undoWindowMs: 60_000 });
    const logs = captureTaskLogs(TASK);

    expect(await runTask(TASK)).toBe('ran');

    expect(await getTopicsStatus(stuck.id)).toBe('error');
    expect(await topicRows()).toEqual([
      { text: 'Formula 1', weight: DEFAULT_HARNESS_CONFIG.topicGen.llmTopicWeight, provenance: 'llm' },
    ]);
    expect(dead.id).toBeTruthy();
    expect(logs()).toEqual([
      'recovering cycle',
      'rescued 1 stale pending facts',
      're-weighted 1 unqueryable topics',
      'committed 1 staged topic deletes',
    ]);
  });

  it('on a quiet device it only recovers the cycle, never calls markNoOp, and stamps lastRun (store and persisted)', async () => {
    const logs = captureTaskLogs(TASK);

    expect(await runTask(TASK)).toBe('ran');

    expect(logs()).toEqual(['recovering cycle']);
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
    expect(await lastRunPersisted(TASK)).toBe(lastRunInStore(TASK));
  });
});

describe('the combination pass', () => {
  it('resumes a pending pass through the real queue rows: one topic_combo job per fact, the owed flag cleared', async () => {
    const a = await addFact('Works as a nurse');
    const b = await addFact('Lives in Porto');
    await comboPass.markComboPending();
    const logs = captureTaskLogs(TASK);

    await runTask(TASK);

    expect((await comboJobs()).map((j) => j.factId).sort()).toEqual([a.id, b.id].sort());
    expect((await comboJobs()).every((j) => j.status === 'pending')).toBe(true);
    expect(await comboPass.isComboPending()).toBe(false);
    expect(logs()).toContain('combination pass: enqueued');
  });

  it('on-device it owes no jobs: the flag is cleared and the end-of-pass refresh fires the feed sync', async () => {
    const feedSync = registerFeedSyncCounter();
    await addFact('Works as a nurse');
    await setMode('on-device');
    await comboPass.markComboPending();
    const logs = captureTaskLogs(TASK);

    await runTask(TASK);
    await settle(500);

    expect(await comboJobs()).toEqual([]);
    expect(await comboPass.isComboPending()).toBe(false);
    expect(logs()).toContain('combination pass: refreshed');
    expect(feedSync.runs).toBe(1);
  });

  it('with no pass owed it logs nothing about it', async () => {
    await addFact('Works as a nurse');
    const logs = captureTaskLogs(TASK);

    await runTask(TASK);

    expect(await comboJobs()).toEqual([]);
    expect(logs().filter((l) => l.startsWith('combination pass'))).toEqual([]);
  });

  it('a failing resume is reported and never fails the task: the job completes, lastRun is stamped, the flag stays for the next foreground', async () => {
    await addFact('Works as a nurse');
    await comboPass.markComboPending();
    const captured = jest.spyOn(logger, 'captureException').mockImplementation(() => '');
    jest.spyOn(comboPass, 'runPendingComboPass').mockRejectedValueOnce(new Error('db busy'));

    await runTask(TASK);

    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(captured).toHaveBeenCalledWith(expect.any(Error), { tags: { task: 'inference-recover', step: 'combo-pass' } });
    expect(await comboPass.isComboPending()).toBe(true);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
  });
});

describe('the first run in a JS context', () => {
  /** The Profile chat opened with these facts, then the facts changed and the app was killed. */
  async function draftLeftOpenWithChanges() {
    await addFact('Works as a nurse');
    await openFactsDraft();
    await addFact('Lives in Porto');
  }

  it('recovers a facts draft a kill left open: the changed facts become a pass, and the pass is resumed in the SAME run', async () => {
    await draftLeftOpenWithChanges();
    const logs = captureTaskLogs(TASK);

    await runTask(TASK);

    expect(await getSetting(FACTS_DRAFT_OPEN_KEY)).toBeNull();
    expect(await comboJobs()).toHaveLength(2);
    expect(logs()).toEqual(expect.arrayContaining(['facts draft left open with changes', 'combination pass: enqueued']));
  });

  it('a later run in the same context leaves an open draft alone (the chat may still be open) but still resumes a pass', async () => {
    await runTask(TASK); // the first run of this context
    await settle(5_000);
    await draftLeftOpenWithChanges();

    await runTask(TASK);

    expect(await getSetting(FACTS_DRAFT_OPEN_KEY)).toBe('1');
    expect(await comboJobs()).toEqual([]);
    expect(await comboPass.isComboPending()).toBe(false);
  });

  it('through real foreground returns: the first recovers the draft, the second does not', async () => {
    await initScheduler();
    await draftLeftOpenWithChanges();

    setAppState('background');
    setAppState('active');
    await settle(500);
    expect(await getSetting(FACTS_DRAFT_OPEN_KEY)).toBeNull();
    expect(await jobStatuses(TASK)).toEqual(['completed']);

    await openFactsDraft();
    await addFact('Plays chess');
    setAppState('background');
    setAppState('active');
    await settle(500);

    expect(await getSetting(FACTS_DRAFT_OPEN_KEY)).toBe('1');
    expect(await jobStatuses(TASK)).toEqual(['completed', 'completed']);
  });
});

describe('waiting for a background collect', () => {
  /** A collect the OS task is still running when the reader opens the app. */
  function collectRunning(): () => void {
    let finish: () => void = () => {};
    trackBackgroundCollect(new Promise<void>((resolve) => (finish = resolve)));
    releaseCollect = finish;
    return finish;
  }

  it('starts recovery only after the collect settles, however early that is', async () => {
    const stuck = await stalePendingFact();
    const finish = collectRunning();

    const run = AppScheduler.trigger(TASK);
    await settle(5_000);
    expect(await getTopicsStatus(stuck.id)).toBe('pending'); // recovery has not begun
    expect(await jobStatuses(TASK)).toEqual(['running']);

    finish();
    await advanceUntilDone(run);

    expect(await getTopicsStatus(stuck.id)).toBe('error');
    expect(Date.now()).toBeLessThan(T0 + BACKGROUND_COLLECT_WAIT_MS);
  });

  it('gives up waiting after 20s rather than holding recovery hostage', async () => {
    const stuck = await stalePendingFact();
    collectRunning(); // never settles

    const run = AppScheduler.trigger(TASK);
    await settle(BACKGROUND_COLLECT_WAIT_MS - 100);
    expect(await getTopicsStatus(stuck.id)).toBe('pending');
    expect(await jobStatuses(TASK)).toEqual(['running']);

    await settle(200);
    await advanceUntilDone(run);

    expect(await getTopicsStatus(stuck.id)).toBe('error');
    expect(await jobStatuses(TASK)).toEqual(['completed']);
  });
});

describe('what starts it', () => {
  it('never runs on the tick, however long the app is open', async () => {
    await stalePendingFact();

    await initScheduler();
    await settle(30 * MIN);

    expect(await jobRows(TASK)).toHaveLength(0);
  });

  it('runs on EVERY foreground return (frequency 0 has no floor)', async () => {
    await initScheduler();

    for (let i = 1; i <= 3; i++) {
      setAppState('background');
      setAppState('active');
      await settle(500);
      expect(await jobRows(TASK)).toHaveLength(i);
    }
  });

  it('waits for the database, and needs neither network nor a signed-in user', async () => {
    useDatabaseStore.setState({ ready: false });
    await initScheduler();

    setAppState('background');
    setAppState('active');
    await settle(500);
    expect(await jobRows(TASK)).toHaveLength(0);

    useDatabaseStore.setState({ ready: true });
    const { useNetworkStore } = await import('@/lib/stores/network-store');
    useNetworkStore.setState({ isConnected: false });
    setAppState('background');
    setAppState('active');
    await settle(500);

    expect(await jobStatuses(TASK)).toEqual(['completed']);
  });
});
