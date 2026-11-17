// The four TaskCondition kinds as the tick evaluates them: db-ready, network, custom and the
// authenticated pre-flight (real getJwtToken against the mock auth backend).
import '@/test/helpers';

import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import type { TaskCondition } from '@/lib/scheduler/scheduler-types';
import { useUserStore } from '@/lib/stores/user-store';
import {
  advanceUntilDone,
  delay,
  http,
  HttpResponse,
  server,
  signInFixtureAccount,
  useFakeClock as freezeClock,
} from '@/test/helpers';

import { addTask, resetScheduler, settle } from './support';

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

beforeEach(() => {
  freezeClock(T0);
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
    freezeClock(T0);
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
});
