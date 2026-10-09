/* eslint-disable import/first, @typescript-eslint/no-require-imports -- the jest.mock factories sit above the imports and load the shared edge lazily */
// The push-token lifecycle across JS reloads: ensurePushTokenRegistered (boot registration), the
// native token-rotation listener, E2E mode, and the Intercom hand-off. Every test starts a FRESH
// module graph (a JS reload, see support.ts) because the rotation listener, its in-flight latch
// and the Intercom latch are module memory with no reset. Real user store, account service,
// Apollo client and settings over the mock backend; edges faked: expo-notifications, expo-device,
// the logger, and the Intercom wrapper's token hand-off.
// Replaces the ensurePushTokenRegistered, rotation and E2E blocks of
// lib/__tests__/notification-service.test.ts.
jest.mock('expo-notifications', () => require('./edge').edge.notifications);
jest.mock('expo-device', () => require('./edge').edge.deviceModule);
jest.mock('@/lib/logger', () => require('./edge').edge.loggerModule);
jest.mock('@/lib/intercom', () => ({
  ...jest.requireActual('@/lib/intercom'),
  sendIntercomPushToken: require('./edge').edge.sendIntercomPushToken,
}));

import { advanceUntil, advanceUntilDone, mockGqlError, server, useStrictClock } from '@/test/helpers';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';
import { edge, resetEdge, rotateDeviceToken, setPermission } from './edge';
import { freshGraph, recordOperation, settle, signIn, type Graph } from './support';

const NOW = Date.parse('2026-10-09T10:00:00.000Z');
const TOKEN = 'ExponentPushToken[test-token]';
const ROTATED = 'ExponentPushToken[rotated]';
const OLD = 'ExponentPushToken[old]';
const n = edge.notifications;
const logger = edge.logger;
const sendToIntercom = edge.sendIntercomPushToken;

let g: Graph;
const personaWith = (expoPushToken: string | null) => personaFor(NOW, { userId: 'user-1', expoPushToken });
const cachedToken = () => g.user.useUserStore.getState().userPersona?.expoPushToken ?? null;
const cache = (token: string | null) => g.user.useUserStore.setState({ userPersona: personaWith(token) });
const run = <T,>(p: Promise<T>) => advanceUntilDone(p);
const capturedMethods = () => logger.captureException.mock.calls.map((c) => c[1]?.tags?.method);

beforeEach(() => {
  resetEdge();
  useStrictClock(NOW);
  g = freshGraph();
  signIn(g);
});
afterEach(async () => {
  jest.useRealTimers();
  await settle();
});

describe('ensurePushTokenRegistered', () => {
  it('no user id: does nothing at all', async () => {
    const seen = recordOperation('UpdateExpoPushToken');
    await run(g.service.ensurePushTokenRegistered(''));
    expect(n.getPermissionsAsync).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('a new token is sent through the persona mutation and cached on the persona', async () => {
    cache(null);
    const seen = recordOperation('UpdateExpoPushToken');
    await run(g.service.ensurePushTokenRegistered('user-1'));
    expect(seen).toEqual([{ input: { userId: 'user-1', expoPushToken: TOKEN } }]);
    expect(cachedToken()).toBe(TOKEN);
  });

  it('a token the persona already holds is not sent again', async () => {
    cache(TOKEN);
    const seen = recordOperation('UpdateExpoPushToken');
    await run(g.service.ensurePushTokenRegistered('user-1'));
    expect(n.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it('a different token (rotated since the last boot) replaces the cached one', async () => {
    cache(OLD);
    const seen = recordOperation('UpdateExpoPushToken');
    await run(g.service.ensurePushTokenRegistered('user-1'));
    expect(seen).toEqual([{ input: { userId: 'user-1', expoPushToken: TOKEN } }]);
    expect(cachedToken()).toBe(TOKEN);
  });

  it('no token (permission refused): nothing sent, no rotation listener attached', async () => {
    setPermission('denied');
    n.requestPermissionsAsync.mockImplementation(async () => ({ status: 'denied' }));
    const seen = recordOperation('UpdateExpoPushToken');
    await run(g.service.ensurePushTokenRegistered('user-1'));
    expect(seen).toEqual([]);
    expect(n.addPushTokenListener).not.toHaveBeenCalled();
  });

  describe('offline', () => {
    it('a device known to be offline skips the round trip and leaves a breadcrumb', async () => {
      g.network.useNetworkStore.setState({ isConnected: false });
      const seen = recordOperation('UpdateExpoPushToken');
      await run(g.service.ensurePushTokenRegistered('user-1'));
      expect(n.getPermissionsAsync).not.toHaveBeenCalled();
      expect(n.getExpoPushTokenAsync).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
      expect(logger.addBreadcrumb).toHaveBeenCalledWith(
        'ensurePushTokenRegistered skipped — device offline',
        'notification-service',
        { userId: 'user-1' },
        'info',
      );
    });

    it('connectivity not yet known (the store seeds optimistically) still attempts', async () => {
      expect(g.network.useNetworkStore.getState().isConnected).not.toBe(false);
      cache(null);
      await run(g.service.ensurePushTokenRegistered('user-1'));
      expect(n.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    });
  });

  it('a server failure does not throw: it is reported with the user id and the persona is left alone', async () => {
    cache(OLD);
    server.use(mockGqlError('UpdateExpoPushToken', 'INTERNAL_SERVER_ERROR'));
    await expect(run(g.service.ensurePushTokenRegistered('user-1'))).resolves.toBeUndefined();
    expect(capturedMethods()).toContain('ensurePushTokenRegistered');
    expect(logger.captureException.mock.calls.find((c) => c[1]?.tags?.method === 'ensurePushTokenRegistered')![1].extra)
      .toEqual({ userId: 'user-1' });
    expect(cachedToken()).toBe(OLD);
  });

  it('attaches the rotation listener once, however often it is called', async () => {
    cache(TOKEN);
    await run(g.service.ensurePushTokenRegistered('user-1'));
    await run(g.service.ensurePushTokenRegistered('user-1'));
    expect(n.addPushTokenListener).toHaveBeenCalledTimes(1);
    expect(edge.tokenListeners.size).toBe(1);
  });

  it('after a JS reload the listener is attached again (module memory is gone)', async () => {
    cache(TOKEN);
    await run(g.service.ensurePushTokenRegistered('user-1'));
    const second = freshGraph();
    signIn(second);
    await run(second.service.ensurePushTokenRegistered('user-1'));
    expect(n.addPushTokenListener).toHaveBeenCalledTimes(2);
  });
});

describe('the token-rotation listener', () => {
  /** Boots a registered device (so the rotation listener is attached) with `cached` on the persona. */
  async function boot(cached: string | null = TOKEN) {
    cache(cached);
    await run(g.service.ensurePushTokenRegistered('user-1'));
    expect(edge.tokenListeners.size).toBe(1);
    n.getExpoPushTokenAsync.mockClear();
  }

  it('re-registers with Expo and sends the rotated token', async () => {
    await boot(TOKEN);
    n.getExpoPushTokenAsync.mockImplementation(async () => ({ data: ROTATED }));
    const seen = recordOperation('UpdateExpoPushToken');

    rotateDeviceToken('raw-rotated');
    await advanceUntil(() => cachedToken() === ROTATED);

    expect(seen).toEqual([{ input: { userId: 'user-1', expoPushToken: ROTATED } }]);
  });

  it('hands Intercom the RAW token the listener carries, without a second native token call', async () => {
    await boot(TOKEN);
    n.getExpoPushTokenAsync.mockImplementation(async () => ({ data: ROTATED }));

    rotateDeviceToken('raw-rotated');
    await advanceUntil(() => cachedToken() === ROTATED);

    expect(sendToIntercom).toHaveBeenCalledWith('raw-rotated');
    expect(n.getDevicePushTokenAsync).not.toHaveBeenCalled();
  });

  it('a rotation that lands on the same Expo token sends nothing', async () => {
    await boot(TOKEN);
    const seen = recordOperation('UpdateExpoPushToken');

    rotateDeviceToken('raw-rotated');
    await advanceUntil(() => n.getExpoPushTokenAsync.mock.calls.length === 1);
    await advanceUntilDone(settle());

    expect(seen).toEqual([]);
    expect(cachedToken()).toBe(TOKEN);
  });

  it('an Intercom failure is not fatal: the Expo token is still sent', async () => {
    await boot(TOKEN);
    n.getExpoPushTokenAsync.mockImplementation(async () => ({ data: ROTATED }));
    sendToIntercom.mockImplementation(async () => {
      throw new Error('intercom down');
    });

    rotateDeviceToken('raw-rotated');
    await advanceUntil(() => cachedToken() === ROTATED);

    expect(capturedMethods()).not.toContain('pushTokenRotation');
  });

  it('an event with no token data skips Intercom but still re-registers', async () => {
    await boot(TOKEN);
    n.getExpoPushTokenAsync.mockImplementation(async () => ({ data: ROTATED }));
    for (const cb of edge.tokenListeners) cb(undefined);

    await advanceUntil(() => cachedToken() === ROTATED);
    expect(sendToIntercom).not.toHaveBeenCalled();
  });

  it('signed out by the time it fires: no registration, nothing sent', async () => {
    await boot(TOKEN);
    g.user.useUserStore.setState({ userId: null });
    const seen = recordOperation('UpdateExpoPushToken');

    rotateDeviceToken('raw-rotated');
    await advanceUntilDone(settle());

    expect(n.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('registration yielding no token (permission revoked meanwhile): nothing sent', async () => {
    await boot(TOKEN);
    setPermission('denied');
    n.requestPermissionsAsync.mockImplementation(async () => ({ status: 'denied' }));
    const seen = recordOperation('UpdateExpoPushToken');

    rotateDeviceToken('raw-rotated');
    await advanceUntil(() => n.requestPermissionsAsync.mock.calls.length === 1);
    await advanceUntilDone(settle());

    expect(seen).toEqual([]);
    expect(cachedToken()).toBe(TOKEN);
  });

  it('a server failure is reported as pushTokenRotation and does not break the next rotation', async () => {
    await boot(TOKEN);
    n.getExpoPushTokenAsync.mockImplementation(async () => ({ data: ROTATED }));
    server.use(mockGqlError('UpdateExpoPushToken', 'INTERNAL_SERVER_ERROR'));

    rotateDeviceToken('raw-1');
    await advanceUntil(() => capturedMethods().includes('pushTokenRotation'));
    expect(cachedToken()).toBe(TOKEN);

    server.resetHandlers();
    rotateDeviceToken('raw-2');
    await advanceUntil(() => cachedToken() === ROTATED);
  });

  it('a rotation arriving while one is in flight is ignored', async () => {
    await boot(TOKEN);
    let release!: (v: { data: string }) => void;
    n.getExpoPushTokenAsync.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const seen = recordOperation('UpdateExpoPushToken');

    rotateDeviceToken('raw-1');
    await advanceUntil(() => n.getExpoPushTokenAsync.mock.calls.length === 1);
    rotateDeviceToken('raw-2');
    await advanceUntilDone(settle());
    expect(n.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);

    release({ data: ROTATED });
    await advanceUntil(() => cachedToken() === ROTATED);
    expect(seen).toEqual([{ input: { userId: 'user-1', expoPushToken: ROTATED } }]);
    // the intercom hand-off of the ignored event never happened either
    expect(sendToIntercom).toHaveBeenCalledTimes(1);
  });
});

describe('E2E mode', () => {
  // The flag only counts when every endpoint is loopback, which the integration setup guarantees.
  beforeEach(() => {
    g = freshGraph({ EXPO_PUBLIC_E2E: '1' });
    signIn(g);
  });

  it('registration makes no permission read, no prompt and no token request', async () => {
    await expect(run(g.service.registerForPushNotificationsAsync())).resolves.toBeNull();
    expect(n.getPermissionsAsync).not.toHaveBeenCalled();
    expect(n.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(n.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('boot registration sends nothing and attaches no rotation listener', async () => {
    cache(null);
    const seen = recordOperation('UpdateExpoPushToken');
    await run(g.service.ensurePushTokenRegistered('user-1'));
    expect(n.getPermissionsAsync).not.toHaveBeenCalled();
    expect(n.addPushTokenListener).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

describe('registerIntercomPushToken', () => {
  it('forwards the raw device token to the Intercom wrapper', async () => {
    await run(g.service.registerIntercomPushToken());
    expect(sendToIntercom).toHaveBeenCalledTimes(1);
    expect(sendToIntercom).toHaveBeenCalledWith('raw-device-token');
  });

  it('a numeric token is sent as a string', async () => {
    n.getDevicePushTokenAsync.mockImplementation(async () => ({ data: 12345 }));
    await run(g.service.registerIntercomPushToken());
    expect(sendToIntercom).toHaveBeenCalledWith('12345');
  });

  it.each([
    ['null', null],
    ['empty data', { data: '' }],
    ['no data', {}],
  ])('a missing token (%s) is a no-op', async (_label, token) => {
    n.getDevicePushTokenAsync.mockImplementation(async () => token);
    await run(g.service.registerIntercomPushToken());
    expect(sendToIntercom).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('on a simulator: does not even ask for the device token', async () => {
    edge.device.isDevice = false;
    await run(g.service.registerIntercomPushToken());
    expect(n.getDevicePushTokenAsync).not.toHaveBeenCalled();
    expect(sendToIntercom).not.toHaveBeenCalled();
  });

  it('a device token that never arrives is abandoned after 10 seconds with a warning, never an exception', async () => {
    n.getDevicePushTokenAsync.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    await run(g.service.registerIntercomPushToken());
    expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
    expect(Date.now() - started).toBeLessThan(11_000);
    expect(sendToIntercom).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('[notification-service] Intercom push token registration failed', {
      error: 'Error: device push token timed out after 10s',
    });
    expect(logger.captureException).not.toHaveBeenCalled();
  });

  it('a native rejection (permission never granted) is a warning, and the next call can retry', async () => {
    n.getDevicePushTokenAsync.mockImplementationOnce(async () => {
      throw new Error('E_PROMISE_REJECTED');
    });
    await run(g.service.registerIntercomPushToken());
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(sendToIntercom).not.toHaveBeenCalled();

    await run(g.service.registerIntercomPushToken());
    expect(sendToIntercom).toHaveBeenCalledWith('raw-device-token');
  });

  it('a failure inside the Intercom hand-off is a warning, not a throw', async () => {
    sendToIntercom.mockImplementation(async () => {
      throw new Error('not logged in');
    });
    await expect(run(g.service.registerIntercomPushToken())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a second call while one is waiting on the native token is ignored', async () => {
    let release!: (v: { data: string }) => void;
    n.getDevicePushTokenAsync.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const first = g.service.registerIntercomPushToken();
    await advanceUntil(() => n.getDevicePushTokenAsync.mock.calls.length === 1);

    await run(g.service.registerIntercomPushToken());
    expect(n.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);

    release({ data: 'raw-device-token' });
    await run(first);
    expect(sendToIntercom).toHaveBeenCalledTimes(1);
  });
});
