// Which scheduled tasks skip the Mera sign-in check while the person uses their own servers.
import { _getBreakerState, _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import { forgetPairing, podState } from '@/lib/own-services/pod-state';
import { ownAiState } from '@/lib/own-services/own-ai-state';
import { ownNewsState } from '@/lib/own-services/own-news-state';
import { taskNeedsMeraSignIn } from '@/lib/own-services/sign-in-need';
import { wipeAllLocalUserData } from '@/lib/security/local-wipe';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import type { TaskDefinition } from '@/lib/scheduler/scheduler-types';
import { useUserStore } from '@/lib/stores/user-store';
import {
  advanceUntilDone,
  http,
  HttpResponse,
  server,
  useFakeClock as freezeClock,
} from '@/test/helpers';

import { resetScheduler, settle } from './core/support';

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const CONFIRMED = { at: 1, privacyVersion: null };
const NAMES = ['feed-sync', 'persona-hygiene', 'feedback-request-sync'] as const;

const ai = (on: boolean) =>
  ownAiState.save({
    v: 1, baseUrl: 'https://ai.own.test/v1', model: 'm1', key: 'ai-key-12345678',
    on, checkedAt: 1, status: 'connected', confirmed: CONFIRMED,
  });
const news = (on: boolean) =>
  ownNewsState.save({
    v: 1, baseUrl: 'https://news.own.test', key: 'news-key-12345678',
    on, checkedAt: 1, status: 'connected', fields: null, confirmed: CONFIRMED,
  });
const pair = (state: 'pending' | 'active' = 'active') =>
  podState.save({
    v: 1, baseUrl: 'https://pod.own.test', deviceId: 'd1', token: 'pod-token-12345678', podName: 'pod', pairedAt: 1,
    confirmed: CONFIRMED, state, pendingAt: state === 'pending' ? 1 : undefined,
  });

beforeEach(async () => {
  freezeClock(T0);
  resetScheduler();
  resetBreaker();
  ownAiState.resetMemory();
  ownNewsState.resetMemory();
  podState.resetMemory();
  await Promise.all([ownAiState.hydrate(), ownNewsState.hydrate(), podState.hydrate()]);
  // A persona with no session, so the check has to ask Mera's sign-in server, which refuses.
  useUserStore.setState({ userPersona: {} as never });
});

afterEach(() => {
  for (const name of NAMES) AppScheduler.pauseTask(name);
  AppScheduler.dispose();
  server.events.removeAllListeners();
});

describe('taskNeedsMeraSignIn', () => {
  const answers = () => NAMES.map((n) => taskNeedsMeraSignIn(n));

  it('keeps every check with no mode', () => {
    expect(answers()).toEqual([true, true, true]);
  });

  it('keeps every check with only one own service on', async () => {
    await ai(true);
    expect(answers()).toEqual([true, true, true]);
    await ai(false);
    await news(true);
    expect(answers()).toEqual([true, true, true]);
  });

  it('keeps every check when both are saved but one is off', async () => {
    await ai(true);
    await news(false);
    expect(answers()).toEqual([true, true, true]);
  });

  it('skips the check for feed sync and profile tidying with both on, never for the feedback sync', async () => {
    await ai(true);
    await news(true);
    expect(answers()).toEqual([false, false, true]);
  });

  it('skips the same two while paired, and restores them when unpaired', async () => {
    await pair();
    expect(answers()).toEqual([false, false, true]);
    await forgetPairing();
    expect(answers()).toEqual([true, true, true]);
  });
});

describe('scheduler', () => {
  const authPaths: string[] = [];

  function register(name: string) {
    const runs: number[] = [];
    const def: TaskDefinition<unknown> = {
      name,
      displayName: name,
      frequency: 600_000,
      conditions: [{ type: 'authenticated' }],
      handler: async () => {
        runs.push(Date.now());
      },
    };
    AppScheduler.register(def);
    AppScheduler.resumeTask(name);
    return runs;
  }

  /** One tick of a task registered under `name`, with Mera's sign-in server refusing. */
  async function tick(name: string): Promise<number> {
    // A later tick in one test starts an hour on, past every cooldown the earlier one left.
    freezeClock(Date.now() + 3_600_000);
    const runs = register(name);
    await advanceUntilDone(AppScheduler.init());
    await settle(11_000);
    AppScheduler.dispose();
    return runs.length;
  }

  beforeEach(() => {
    authPaths.length = 0;
    server.events.on('request:start', ({ request }) => {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith('/api/auth/')) authPaths.push(pathname);
    });
    server.use(
      http.get('*/api/auth/get-session', () => HttpResponse.json({ error: 'down' }, { status: 500 })),
      http.get('*/api/auth/token', () => HttpResponse.json({ error: 'down' }, { status: 500 })),
    );
  });

  it('does not start the task when signed out and no mode is on', async () => {
    expect(await tick('feed-sync')).toBe(0);
    // Everyone with no mode on keeps asking Mera's sign-in server before the task.
    expect(authPaths.length).toBeGreaterThan(0);
  });

  it('does not start the task with only one own service on', async () => {
    await ai(true);
    expect(await tick('feed-sync')).toBe(0);
  });

  it.each(['feed-sync', 'persona-hygiene'])('starts %s with both own services on, asking Mera nothing', async (name) => {
    await ai(true);
    await news(true);
    expect(await tick(name)).toBe(1);
    expect(authPaths).toEqual([]);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('starts feed sync while paired, asking Mera nothing', async () => {
    await pair();
    expect(await tick('feed-sync')).toBe(1);
    expect(authPaths).toEqual([]);
  });

  it('does not start feed sync for a pending pairing, signed out', async () => {
    await pair('pending');
    expect(taskNeedsMeraSignIn('feed-sync')).toBe(true);
    expect(await tick('feed-sync')).toBe(0);
    expect(authPaths.length).toBeGreaterThan(0);
  });

  it('keeps the check on the feedback sync with both own services on', async () => {
    await ai(true);
    await news(true);
    expect(await tick('feedback-request-sync')).toBe(0);
  });

  it('restores the check at once when a mode is turned off, unpaired, or the device is wiped', async () => {
    await ai(true);
    await news(true);
    expect(await tick('feed-sync')).toBe(1);

    await news(false);
    expect(await tick('feed-sync')).toBe(0);

    await pair();
    expect(await tick('feed-sync')).toBe(1);
    await forgetPairing();
    expect(await tick('feed-sync')).toBe(0);

    await ai(true);
    await news(true);
    await wipeAllLocalUserData();
    expect(await tick('feed-sync')).toBe(0);
  });
});
