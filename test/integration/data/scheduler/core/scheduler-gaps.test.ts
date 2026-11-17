// Scheduler-core arms the other seam files do not reach: each test drives the real AppScheduler,
// runner, persistence layer and in-memory DB. Edges only: the clock, Sentry, and llama.rn for the one module-load fault.
import '@/test/helpers';

import * as Sentry from '@sentry/react-native';

import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useUserStore } from '@/lib/stores/user-store';
import {
  advanceUntilDone,
  HttpResponse,
  http,
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
});

describe('authenticated pre-flight when the credential lookup itself throws', () => {
  // getJwtToken swallows a transport failure into null, but it reports it through
  // logger.captureException first. If Sentry throws from there (an SDK fault), the rejection
  // escapes getJwtToken and the condition must read it as "not authenticated", not crash the tick.
  it('skips the task quietly and keeps ticking', async () => {
    jest.useRealTimers();
    await signInFixtureAccount();
    useFakeClock(T0);
    useUserStore.setState({ userPersona: {} as never });
    server.use(http.get('*/api/auth/get-session', () => HttpResponse.error()));
    (Sentry.captureException as jest.Mock).mockImplementationOnce(() => {
      throw new Error('sentry exploded');
    });
    const task = addTask({ frequency: 10_000, conditions: [{ type: 'authenticated' }] });

    await advanceUntilDone(AppScheduler.init());
    await settle(1_000);

    expect(Sentry.captureException).toHaveBeenCalled();
    expect(task.runs).toHaveLength(0);
  });
});
