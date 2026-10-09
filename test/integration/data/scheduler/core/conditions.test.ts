// The four TaskCondition kinds as the tick evaluates them: db-ready, network, custom and the
// authenticated pre-flight (real getJwtToken against the mock auth backend).
import '@/test/helpers';

import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import type { TaskCondition } from '@/lib/scheduler/scheduler-types';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import {
  advanceUntilDone,
  delay,
  http,
  HttpResponse,
  server,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';

import { addTask, resetScheduler, settle } from './support';

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

beforeEach(() => {
  useFakeClock(T0);
  resetScheduler();
});

afterEach(() => {
  AppScheduler.dispose();
  server.events.removeAllListeners();
});

/** A timer task behind one condition; init fires its first tick at once. */
async function startWith(condition: TaskCondition) {
  const task = addTask({ frequency: 10_000, conditions: [condition] });
  await advanceUntilDone(AppScheduler.init());
  return task;
}

describe('db-ready', () => {
  it('skips the task until the database store reports ready, then runs it on the next tick', async () => {
    const task = await startWith({ type: 'db-ready' });
    await settle(11_000);
    expect(task.runs).toHaveLength(0);

    useDatabaseStore.setState({ ready: true });
    await settle(5_100);

    expect(task.runs).toHaveLength(1);
  });
});

describe('network', () => {
  it('skips the task while the device is offline and runs it once the link is back', async () => {
    useNetworkStore.getState().setIsConnected(false);
    const task = await startWith({ type: 'network' });
    await settle(11_000);
    expect(task.runs).toHaveLength(0);

    useNetworkStore.getState().setIsConnected(true);
    await settle(5_100);

    expect(task.runs).toHaveLength(1);
  });
});

describe('custom', () => {
  it('respects a synchronous check: false skips, true runs', async () => {
    let allowed = false;
    const task = await startWith({ type: 'custom', check: () => allowed });
    await settle(11_000);
    expect(task.runs).toHaveLength(0);

    allowed = true;
    await settle(5_100);

    expect(task.runs).toHaveLength(1);
  });

  // The skill documents this as a silent kill ("a Promise is always truthy"). It is not, today:
  // `_checkCondition` is an `async` function, so returning the Promise from `check` adopts it and
  // `await _checkCondition(...)` sees the real boolean. The TYPE still forbids it, and the gate
  // only holds while that async wrapper does. Pinned as today's behaviour.
  it('awaits a check that returns a Promise, because _checkCondition is async: an async false still gates the task', async () => {
    let allowed = false;
    const asyncCheck = (async () => allowed) as unknown as () => boolean;

    const task = await startWith({ type: 'custom', check: asyncCheck });
    await settle(11_000);
    expect(task.runs).toHaveLength(0);

    allowed = true;
    await settle(5_100);

    expect(task.runs).toHaveLength(1);
  });

  it('lets a task through whose condition type is unknown to the scheduler', async () => {
    const task = await startWith({ type: 'from-the-future' } as unknown as TaskCondition);
    await settle(500);

    expect(task.runs).toHaveLength(1);
  });

  it('checks every condition, so one failing condition blocks the task', async () => {
    const task = addTask({
      frequency: 10_000,
      conditions: [{ type: 'custom', check: () => true }, { type: 'custom', check: () => false }],
    });
    await advanceUntilDone(AppScheduler.init());
    await settle(11_000);

    expect(task.runs).toHaveLength(0);
  });
});

describe('authenticated', () => {
  const authPaths: string[] = [];

  beforeEach(() => {
    authPaths.length = 0;
    server.events.on('request:start', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith('/api/auth/')) authPaths.push(pathname);
    });
    useUserStore.setState({ userPersona: {} as never });
  });

  /** Signs in on the real clock (MSW answers in real time), then goes back under the fake one. */
  async function signedIn() {
    jest.useRealTimers();
    await signInFixtureAccount();
    useFakeClock(T0);
    authPaths.length = 0;
  }

  it('passes for a signed-in account: the real getSession and token calls both succeed', async () => {
    await signedIn();

    const task = await startWith({ type: 'authenticated' });
    await settle(1_000);

    expect(task.runs).toHaveLength(1);
    expect(authPaths).toContain('/api/auth/token');
  });

  it('fails for a signed-out account, after asking the server', async () => {
    const task = await startWith({ type: 'authenticated' });
    await settle(11_000);

    expect(authPaths).toContain('/api/auth/get-session');
    expect(task.runs).toHaveLength(0);
  });

  it('fails when the token endpoint refuses the session', async () => {
    await signedIn();
    server.use(http.get('*/api/auth/token', () => HttpResponse.json({ error: 'nope' }, { status: 401 })));

    const task = await startWith({ type: 'authenticated' });
    await settle(11_000);

    expect(authPaths).toContain('/api/auth/token');
    expect(task.runs).toHaveLength(0);
  });

  it('passes optimistically when the token call outlasts the 1.5s pre-flight budget', async () => {
    await signedIn();
    server.use(
      http.get('*/api/auth/token', async () => {
        await delay(20_000);
        return HttpResponse.json({ token: 'late' });
      }),
    );

    const task = await startWith({ type: 'authenticated' });
    await settle(1_000);
    expect(task.runs).toHaveLength(0);

    await settle(1_500);

    // Ran long before the 20s answer could arrive: the timeout passed it.
    expect(task.runs).toHaveLength(1);
  });

  it('fails at once with no persona, without touching the network', async () => {
    useUserStore.setState({ userPersona: null });
    await signedIn();

    const task = await startWith({ type: 'authenticated' });
    await settle(11_000);

    expect(task.runs).toHaveLength(0);
    expect(authPaths).toEqual([]);
  });

  it('fails at once when the breaker flagged the session dead, even while offline', async () => {
    await signedIn();
    useUserStore.setState({ needsReauth: true });
    useNetworkStore.getState().setIsConnected(false);

    const task = await startWith({ type: 'authenticated' });
    await settle(11_000);

    expect(task.runs).toHaveLength(0);
    expect(authPaths).toEqual([]);
  });

  it('passes while offline without checking the credential (local identity is enough)', async () => {
    useNetworkStore.getState().setIsConnected(false);

    const task = await startWith({ type: 'authenticated' });
    await settle(500);

    expect(task.runs).toHaveLength(1);
    expect(authPaths).toEqual([]);
  });
});
