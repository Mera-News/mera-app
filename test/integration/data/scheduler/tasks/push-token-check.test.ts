// The push-token-check scheduler task on the REAL AppScheduler, driving the real checkPushTokenRevocation
// (lib/notification-service.ts), the real Apollo client over MSW and the user store. The notifications
// SDK (expo-notifications) is the one mocked edge: the OS permission and the Expo token are what a test
// scripts. Replaces lib/scheduler/tasks/__tests__/push-token-check-task.test.ts.
//
// What the check does: signed in, permission denied and the persona holds a token -> clear it
// server-side; permission granted (or not yet asked) and the persona holds NO token -> register and post
// it. A persona that already holds a token is left alone, whether or not it still matches the device's
// (a rotation is handled by the token listener, not by this hourly check).
import { FIXTURE_ACCOUNT, mockGqlError, server, setAppState } from '@/test/helpers';
import '@/lib/scheduler/tasks/push-token-check-task';

import * as Notifications from 'expo-notifications';

import logger from '@/lib/logger';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';

import {
  HOUR,
  MIN,
  T0,
  advanceUntil,
  conditionTypes,
  endTest,
  initScheduler,
  jobRows,
  jobStatuses,
  lastRunInStore,
  lastRunPersisted,
  recordOps,
  registeredDefinition,
  runTask,
  seedLocalUser,
  settle,
  startTest,
} from './support';

jest.setTimeout(30_000); // the tick tests step minutes of fake time, which an instrumented run can stretch

// The setup's expo-notifications mock has no IosAuthorizationStatus, which registerForPushNotificationsAsync
// reads on iOS before it asks for anything, so every real registration throws under it. This file carries
// the same mock plus that enum (the notifications SDK is a mockable edge). Reported to the harness owner.
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  scheduleNotificationAsync: jest.fn(() => Promise.resolve('notification-id')),
  setBadgeCountAsync: jest.fn(() => Promise.resolve()),
  getBadgeCountAsync: jest.fn(() => Promise.resolve(0)),
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: 'ExponentPushToken[test-token]' })),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  IosAuthorizationStatus: { NOT_DETERMINED: 0, DENIED: 1, AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4 },
  AndroidImportance: { MAX: 5 },
}));

const TASK = 'push-token-check';
const DEVICE_TOKEN = 'ExponentPushToken[test-token]';
const UPDATE = 'UpdateExpoPushToken';
const DELETE = 'DeleteExpoPushToken';
const USER = FIXTURE_ACCOUNT.userId;

/** The OS permission as the check reads it, then again as the registration that follows reads it. */
const permission = (status: 'granted' | 'denied' | 'undetermined', reads = 1) => {
  for (let i = 0; i < reads; i++) (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status });
};
const storedToken = () => useUserStore.getState().userPersona?.expoPushToken ?? null;

let captured: jest.SpyInstance;
let breadcrumbs: jest.SpyInstance;
beforeEach(async () => {
  await startTest(TASK, { signedIn: true });
  captured = jest.spyOn(logger, 'captureException').mockImplementation(() => '');
  breadcrumbs = jest.spyOn(logger, 'addBreadcrumb').mockImplementation(() => {});
});
afterEach(() => {
  endTest();
  jest.restoreAllMocks();
});

describe('registration', () => {
  it('is an hourly foreground task gated on exactly network and authenticated, exclusive, 10s, 2 attempts', () => {
    const def = registeredDefinition('@/lib/scheduler/tasks/push-token-check-task');

    expect(def).toMatchObject({
      name: TASK,
      frequency: HOUR,
      triggers: ['app-foreground'],
      exclusive: true,
      timeout: 10_000,
      maxAttempts: 2,
    });
    expect(conditionTypes(def)).toEqual(['network', 'authenticated']);
  });
});

describe('the handler', () => {
  it('permission granted and the persona holds no token: registers and posts the Expo token, and the store keeps the answer', async () => {
    seedLocalUser({}, USER);
    const sent = recordOps();

    expect(await runTask(TASK)).toBe('ran');

    expect(sent.of(UPDATE)).toEqual([{ input: { userId: USER, expoPushToken: DEVICE_TOKEN } }]);
    expect(sent.of(DELETE)).toEqual([]);
    expect(storedToken()).toBe(DEVICE_TOKEN);
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBe(T0);
    expect(await lastRunPersisted(TASK)).toBe(T0);
  });

  it('permission not yet asked behaves the same: the app asks, and posts the token it is given', async () => {
    seedLocalUser({}, USER);
    const sent = recordOps();
    permission('undetermined', 2);

    await runTask(TASK);

    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(sent.of(UPDATE)).toHaveLength(1);
  });

  it('a persona that already holds the device token is not posted again', async () => {
    seedLocalUser({ expoPushToken: DEVICE_TOKEN }, USER);
    const sent = recordOps();

    await runTask(TASK);

    expect(sent.of(UPDATE)).toEqual([]);
    expect(sent.of(DELETE)).toEqual([]);
    expect(storedToken()).toBe(DEVICE_TOKEN);
  });

  // The brief asked for "a changed Expo token is posted". The hourly check only registers when the
  // persona carries NO token (notification-service.ts, the `!cachedToken` branch); a rotation is the
  // token listener's job. Pinned as today's behaviour; escalated to the data lead rather than decided here.
  it('today: a persona holding a DIFFERENT token than the device is left alone by the hourly check', async () => {
    seedLocalUser({ expoPushToken: 'ExponentPushToken[stale]' }, USER);
    const sent = recordOps();

    await runTask(TASK);

    expect(sent.of(UPDATE)).toEqual([]);
    expect(storedToken()).toBe('ExponentPushToken[stale]');
  });

  it('permission denied in OS settings with a token on the persona: clears it server-side', async () => {
    seedLocalUser({ expoPushToken: DEVICE_TOKEN }, USER);
    const sent = recordOps();
    permission('denied');

    await runTask(TASK);

    expect(sent.of(DELETE)).toEqual([{ input: { userId: USER } }]);
    expect(sent.of(UPDATE)).toEqual([]);
    expect(storedToken()).toBeNull();
  });

  it('permission denied and no token on the persona: nothing to clear, nothing sent', async () => {
    seedLocalUser({}, USER);
    const sent = recordOps();
    permission('denied');

    await runTask(TASK);

    expect(sent.of(DELETE)).toEqual([]);
    expect(sent.of(UPDATE)).toEqual([]);
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('a refused permission prompt posts nothing', async () => {
    seedLocalUser({}, USER);
    const sent = recordOps();
    permission('undetermined', 2);
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'denied' });

    await runTask(TASK);

    expect(sent.of(UPDATE)).toEqual([]);
    expect(storedToken()).toBeNull();
  });

  it('with no signed-in user id it sends nothing', async () => {
    useUserStore.setState({ userId: null, userPersona: null });
    const sent = recordOps();

    await runTask(TASK);

    expect(sent.of(UPDATE)).toEqual([]);
    expect(sent.of(DELETE)).toEqual([]);
  });

  it('a server error on the post is reported once and swallowed: the job completes, nothing is stored, lastRun is stamped', async () => {
    seedLocalUser({}, USER);
    const sent = recordOps();
    server.use(mockGqlError(UPDATE, 'INTERNAL_SERVER_ERROR'));

    expect(await runTask(TASK)).toBe('ran');

    expect(sent.of(UPDATE)).toHaveLength(1);
    expect(storedToken()).toBeNull();
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
    const methods = captured.mock.calls.map((c) => (c[1] as { tags?: { method?: string } }).tags?.method);
    expect(methods).toContain('checkPushTokenRevocation');
    expect(breadcrumbs).not.toHaveBeenCalledWith(expect.stringContaining('network request failed'), expect.anything(), expect.anything(), expect.anything());
  });
});

describe('what starts it', () => {
  it('the tick runs it once, then not again until an hour (jittered at most +20%) has passed', async () => {
    seedLocalUser({ expoPushToken: DEVICE_TOKEN }, USER);

    await initScheduler();
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the first run', 10_000);
    await settle(30 * MIN);
    expect(await jobRows(TASK)).toHaveLength(1);

    await settle(45 * MIN);
    expect((await jobRows(TASK)).length).toBeGreaterThanOrEqual(2);
  });

  it('is held back offline and signed out, and runs once both hold', async () => {
    useNetworkStore.setState({ isConnected: false });
    seedLocalUser({ expoPushToken: DEVICE_TOKEN }, USER);
    await initScheduler();
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);

    useNetworkStore.setState({ isConnected: true });
    useUserStore.setState({ userPersona: null });
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);

    seedLocalUser({ expoPushToken: DEVICE_TOKEN }, USER);
    await settle(10_000);

    expect(await jobStatuses(TASK)).toEqual(['completed']);
  });

  it('a foreground return re-runs it past the 60s floor, and is not re-run by a network reconnect (foreground only)', async () => {
    seedLocalUser({ expoPushToken: DEVICE_TOKEN }, USER);
    await initScheduler();
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the first run', 10_000);
    const first = (await jobRows(TASK)).length;

    setAppState('background');
    setAppState('active');
    await settle(500);
    expect(await jobRows(TASK)).toHaveLength(first); // inside the floor

    await settle(2 * MIN);
    useNetworkStore.setState({ isConnected: false });
    useNetworkStore.setState({ isConnected: true });
    await settle(500);
    expect(await jobRows(TASK)).toHaveLength(first);

    setAppState('background');
    setAppState('active');
    await settle(500);
    expect(await jobRows(TASK)).toHaveLength(first + 1);
  });
});
