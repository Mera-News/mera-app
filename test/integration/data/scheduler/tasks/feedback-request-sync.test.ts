// The feedback-request-sync scheduler task on the REAL AppScheduler, driving the real sync, the real
// Apollo client over MSW, the settings state row and the notifications table. Replaces
// lib/scheduler/tasks/__tests__/feedback-request-sync-task.test.ts.
//
// What the task must keep true: "no live requests" is the NORMAL state, so an empty list and a failed
// fetch both end as an ordinary completed run that arms the hourly cadence (a markNoOp, or a throw
// that fails the job, would re-fire it every tick); new requests become a state entry and ONE drawer
// row each; the question is asked in the app language, mapped to the server's locale list.
import { mockGql, mockGqlError, server, setAppState } from '@/test/helpers';
import '@/lib/scheduler/tasks/feedback-request-sync-task';

import { getAll as getNotifications } from '@/lib/database/services/notification-service';
import { readFeedbackRequestsState } from '@/lib/feedback-requests/feedback-request-state';
import logger from '@/lib/logger';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';

import {
  HOUR,
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
  seedLocalUser,
  settle,
  startTest,
} from './support';

const TASK = 'feedback-request-sync';
const OP = 'ActiveFeedbackRequests';
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const view = (id: string, over: Record<string, unknown> = {}) => ({
  __typename: 'FeedbackRequestView',
  id,
  question: `Question ${id.slice(0, 1)}?`,
  endsAt: new Date(T0 + 2 * HOUR).toISOString(),
  createdAt: new Date(T0 - HOUR).toISOString(),
  answered: false,
  ...over,
});

/** Serves the live list; `asked` collects the locale of every request. */
function serve(...views: ReturnType<typeof view>[]): { locales: string[] } {
  const asked: { locales: string[] } = { locales: [] };
  server.use(
    mockGql(OP, (variables) => {
      asked.locales.push(String(variables.locale));
      return { activeFeedbackRequests: views };
    }),
  );
  return asked;
}

const drawerRows = async () =>
  (await getNotifications()).map((n) => ({ type: n.type, title: n.title, body: n.body, source: n.source }));

let captured: jest.SpyInstance;
beforeEach(async () => {
  await startTest(TASK, { signedIn: true });
  seedLocalUser();
  useAppLanguageStore.setState({ appLanguage: 'en' });
  captured = jest.spyOn(logger, 'captureException').mockImplementation(() => '');
});
afterEach(() => {
  endTest();
  jest.restoreAllMocks();
});

describe('registration', () => {
  it('is hourly plus foreground and reconnect, gated on exactly network, authenticated and db-ready, one attempt', () => {
    const def = registeredDefinition('@/lib/scheduler/tasks/feedback-request-sync-task');

    expect(def).toMatchObject({
      name: TASK,
      frequency: HOUR,
      triggers: ['app-foreground', 'network-reconnect'],
      exclusive: true,
      timeout: 30_000,
      maxAttempts: 1,
    });
    expect(conditionTypes(def)).toEqual(['network', 'authenticated', 'db-ready']);
  });
});

describe('the handler', () => {
  it('records each live request as device state and writes ONE drawer row each, in the app language mapped to the server locale', async () => {
    useAppLanguageStore.setState({ appLanguage: 'zh-Hant' });
    const asked = serve(view(A), view(B));
    const logs = captureTaskLogs(TASK);

    expect(await runTask(TASK)).toBe('ran');

    expect(logs()).toEqual(['feedback requests: 2 live, 2 new, 0 answered elsewhere']);
    expect(asked.locales).toEqual(['zh-TW']);
    const state = await readFeedbackRequestsState();
    expect(Object.keys(state).sort()).toEqual([A, B]);
    expect(state[A]).toMatchObject({ question: 'Question a?', endsAt: T0 + 2 * HOUR });
    expect((await drawerRows()).sort((x, y) => x.source.localeCompare(y.source))).toEqual([
      { type: 'feedback_request', title: 'feedbackRequest.title', body: 'Question a?', source: `feedback_request:${A}` },
      { type: 'feedback_request', title: 'feedbackRequest.title', body: 'Question b?', source: `feedback_request:${B}` },
    ]);
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBe(T0);
    expect(await lastRunPersisted(TASK)).toBe(T0);
  });

  it('a second sync of the same list adds no row and keeps the entries', async () => {
    serve(view(A));
    await runTask(TASK);
    await settle(5_000);

    await runTask(TASK);

    expect(await drawerRows()).toHaveLength(1);
    expect(Object.keys(await readFeedbackRequestsState())).toEqual([A]);
  });

  it('an empty list is a normal run: nothing is written and lastRun IS stamped (no markNoOp)', async () => {
    serve();

    await runTask(TASK);

    expect(await readFeedbackRequestsState()).toEqual({});
    expect(await drawerRows()).toEqual([]);
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBe(T0);
    expect(await lastRunPersisted(TASK)).toBe(T0);
  });

  it('a request missing from a later list is closed locally: its endsAt is clamped to now', async () => {
    serve(view(A));
    await runTask(TASK);
    await settle(5_000);
    serve();

    await runTask(TASK);

    const state = await readFeedbackRequestsState();
    expect(state[A].endsAt).toBeGreaterThanOrEqual(T0 + 5_000);
    expect(state[A].endsAt).toBeLessThan(T0 + HOUR);
  });

  it('a request the server says is answered elsewhere is stamped answered, and its drawer row is actioned', async () => {
    serve(view(A));
    await runTask(TASK);
    await settle(5_000);
    serve(view(A, { answered: true }));

    await runTask(TASK);

    expect((await readFeedbackRequestsState())[A].answeredAt).toBeGreaterThanOrEqual(T0 + 5_000);
    const [row] = await getNotifications();
    expect({ source: row.source, status: row.status }).toEqual({ source: `feedback_request:${A}`, status: 'actioned' });
  });

  it('a request already answered on first sight gets state but no drawer row', async () => {
    serve(view(A, { answered: true }));

    await runTask(TASK);

    expect((await readFeedbackRequestsState())[A].answeredAt).toBeDefined();
    expect(await drawerRows()).toEqual([]);
  });

  it('a failed fetch neither throws nor fails the job nor markNoOps: the run completes and lastRun is stamped', async () => {
    server.use(mockGqlError(OP, 'INTERNAL_SERVER_ERROR'));
    const logs = captureTaskLogs(TASK);

    expect(await runTask(TASK)).toBe('ran');

    expect(logs()).toEqual(['feedback requests: fetch failed, next foreground retries']);
    expect(await readFeedbackRequestsState()).toEqual({});
    expect(await drawerRows()).toEqual([]);
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
    // The task adds no second report of its own: any capture came from the Apollo link, not the runner.
    expect(captured.mock.calls.filter((c) => (c[1] as { tags?: { scheduler?: unknown } } | undefined)?.tags?.scheduler)).toEqual([]);
  });
});

describe('what starts it', () => {
  it('an empty hour arms the cadence: an hour of 5s ticks runs it exactly once', async () => {
    serve();

    await initScheduler();
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the first run', 10_000);
    await settle(30 * MIN);

    expect(await jobRows(TASK)).toHaveLength(1);
  });

  it('a failed fetch arms the cadence too: the tick does not re-fire it every 5 seconds', async () => {
    server.use(mockGqlError(OP, 'INTERNAL_SERVER_ERROR'));

    await initScheduler();
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the first run', 10_000);
    await settle(30 * MIN);

    expect(await jobRows(TASK)).toHaveLength(1);
  });

  it('is held back offline, signed out and before the database is ready, and runs when all three hold', async () => {
    serve(view(A));
    useNetworkStore.setState({ isConnected: false });
    await initScheduler();
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);

    useNetworkStore.setState({ isConnected: true });
    useUserStore.setState({ userPersona: null });
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);

    seedLocalUser();
    useDatabaseStore.setState({ ready: false });
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);

    useDatabaseStore.setState({ ready: true });
    await settle(10_000);

    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(Object.keys(await readFeedbackRequestsState())).toEqual([A]);
  });

  it('a foreground return runs it, and so does a reconnect once a minute has passed', async () => {
    serve();
    await initScheduler();
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the first run', 10_000);
    const first = (await jobRows(TASK)).length;

    setAppState('background');
    setAppState('active');
    await settle(500);
    expect(await jobRows(TASK)).toHaveLength(first); // inside the 60s warm floor

    await settle(2 * MIN);
    useNetworkStore.setState({ isConnected: false });
    useNetworkStore.setState({ isConnected: true });
    await settle(500);

    expect((await jobRows(TASK)).length).toBe(first + 1);
  });
});
