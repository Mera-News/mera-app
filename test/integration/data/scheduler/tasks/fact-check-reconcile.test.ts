// The fact-check-reconcile scheduler task on the REAL AppScheduler, driving the real
// reconcileAskedFactChecks (chat-owned), the real Apollo client over MSW and the fact_checks table.
// Chat's fact-check/reread.test.ts owns the re-read rules (asked only, read-only operation, bounded,
// never throws); this file pins what the TASK does with it: it runs on foreground and reconnect and
// never on the tick, it re-reads exactly the asked checks, it logs how many are still waiting, and an
// empty or failing pass is an ordinary completed run (no markNoOp). Replaces
// lib/scheduler/tasks/__tests__/fact-check-reconcile-task.test.ts.
import { advanceUntilDone, graphql, HttpResponse, server, setAppState } from '@/test/helpers';
import '@/lib/scheduler/tasks/fact-check-reconcile-task';

import { upsertFactCheck } from '@/lib/database/services/fact-check-record-service';
import { stopAskedFactCheckPollerForTest } from '@/lib/fact-check/fact-check-graphql-client';
import { recordFactCheckAsked } from '@/lib/fact-check/fact-check-settled';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import {
  REREAD_OP,
  checkRow,
  opsOf,
  pendingRow,
  serveChecks,
  spyNotified,
  storedFor,
} from '@/test/integration/chat/fact-check/kit';

import {
  MIN,
  T0,
  advanceUntil,
  captureTaskLogs,
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

const TASK = 'fact-check-reconcile';

/** `order` keeps the asks oldest-first without ageing them anywhere near the 7 day expiry. */
const ask = (articleId: string, order = 0) =>
  advanceUntilDone(recordFactCheckAsked({ articleId, suggestionId: null, title: articleId }, T0 - 60_000 + order));

beforeEach(async () => {
  await startTest(TASK, { signedIn: true });
  spyNotified();
});
afterEach(() => {
  stopAskedFactCheckPollerForTest();
  endTest();
  jest.restoreAllMocks();
});

describe('registration', () => {
  it('is event-driven only: frequency 0, foreground and reconnect, gated on exactly db-ready and network, one attempt', () => {
    const def = registeredDefinition('@/lib/scheduler/tasks/fact-check-reconcile-task');

    expect(def).toMatchObject({
      name: TASK,
      frequency: 0,
      triggers: ['app-foreground', 'network-reconnect'],
      exclusive: true,
      timeout: 60_000,
      maxAttempts: 1,
    });
    expect(conditionTypes(def)).toEqual(['db-ready', 'network']);
  });
});

describe('the handler', () => {
  it('re-reads ONLY the asked checks through the read-only operation, stores what settled, and logs how many still wait', async () => {
    const wire = serveChecks({ reread: (id) => ({ a1: checkRow(), a2: pendingRow() })[id as 'a1'] ?? null });
    await ask('a1', 1);
    await ask('a2', 2);
    // Stored before the community lookup went: on this phone, never asked for.
    await upsertFactCheck({ articleId: 'a9', factCheckId: 'x', status: 'pending', payload: null });
    const logs = captureTaskLogs(TASK);

    expect(await runTask(TASK)).toBe('ran');

    expect(opsOf(wire, REREAD_OP)).toEqual(['a1', 'a2']);
    expect((await storedFor('a1')).map((r) => r.status)).toEqual(['complete']);
    expect((await storedFor('a2')).map((r) => r.status)).toEqual(['pending']);
    expect((await storedFor('a9')).map((r) => r.status)).toEqual(['pending']);
    expect(logs()).toEqual(['reconciled asked fact checks, 1 still waiting']);
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
    expect(await lastRunPersisted(TASK)).toBe(lastRunInStore(TASK));
  });

  it('with nothing asked it makes no request, logs zero waiting, and still stamps lastRun (no markNoOp)', async () => {
    const wire = serveChecks({ reread: () => checkRow() });
    const logs = captureTaskLogs(TASK);

    await runTask(TASK);

    expect(wire).toEqual([]);
    expect(logs()).toEqual(['reconciled asked fact checks, 0 still waiting']);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
  });

  it('a failing read does not fail the job: the check counts as still waiting', async () => {
    serveChecks({ reread: () => checkRow() });
    server.use(
      graphql.operation(({ operationName }) =>
        operationName === REREAD_OP
          ? HttpResponse.json({ errors: [{ message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] })
          : undefined,
      ),
    );
    await ask('a1');
    const logs = captureTaskLogs(TASK);

    await runTask(TASK);

    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(logs()).toEqual(['reconciled asked fact checks, 1 still waiting']);
    expect(await storedFor('a1')).toEqual([]);
  });
});

describe('what starts it', () => {
  it('never runs on the tick, however long the app is open', async () => {
    serveChecks({ reread: () => checkRow() });
    await ask('a1');

    await initScheduler();
    await settle(30 * MIN);

    expect(await jobRows(TASK)).toHaveLength(0);
    expect(await storedFor('a1')).toEqual([]);
  });

  it('runs on EVERY foreground return (frequency 0 has no floor), and re-reads then', async () => {
    const wire = serveChecks({ reread: () => pendingRow() });
    await ask('a1');
    await initScheduler();

    for (let i = 1; i <= 3; i++) {
      setAppState('background');
      setAppState('active');
      await advanceUntil(() => opsOf(wire, REREAD_OP).length === i, `foreground ${i} to re-read`, 5_000);
    }

    expect(await jobStatuses(TASK)).toEqual(['completed', 'completed', 'completed']);
  });

  it('runs on a network reconnect, and is held back by the db-ready and network conditions', async () => {
    const wire = serveChecks({ reread: () => pendingRow() });
    await ask('a1');
    useDatabaseStore.setState({ ready: false });
    await initScheduler();

    setAppState('background');
    setAppState('active');
    await settle(500);
    expect(opsOf(wire, REREAD_OP)).toHaveLength(0);

    useDatabaseStore.setState({ ready: true });
    useNetworkStore.setState({ isConnected: false });
    setAppState('background');
    setAppState('active');
    await settle(500);
    expect(opsOf(wire, REREAD_OP)).toHaveLength(0);

    useNetworkStore.setState({ isConnected: true });
    await advanceUntil(() => opsOf(wire, REREAD_OP).length === 1, 'the reconnect to re-read', 5_000);
  });
});
