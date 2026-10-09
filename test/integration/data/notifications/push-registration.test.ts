/* eslint-disable import/first, @typescript-eslint/no-require-imports -- the jest.mock factories sit above the imports and load the shared edge lazily */
// registerForPushNotificationsAsync, the foreground handler, setupNotifications and its listeners,
// and the permission-driven entry points (hasUserDeniedPermissions, setVisibleNotificationsEnabled,
// checkPushTokenRevocation), against the real settings table, user store, account service, Apollo
// client and the mock backend. Edges faked: expo-notifications, expo-device, the logger, and the
// OS pieces (Platform, the expo-constants project id).
// Replaces the matching blocks of lib/__tests__/notification-service.test.ts (which mocked
// account-service, setting-service, user-store and network-store).
jest.mock('expo-notifications', () => require('./edge').edge.notifications);
jest.mock('expo-device', () => require('./edge').edge.deviceModule);
jest.mock('@/lib/logger', () => require('./edge').edge.loggerModule);

import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { AccountService } from '@/lib/account-service';
import { getSetting } from '@/lib/database/services/setting-service';
import {
  checkPushTokenRevocation,
  cleanupNotificationListeners,
  hasUserDeniedPermissions,
  registerForPushNotificationsAsync,
  setupNotifications,
  setVisibleNotificationsEnabled,
} from '@/lib/notification-service';
import { useUserStore } from '@/lib/stores/user-store';
import { advanceUntilDone, mockGqlError, server, useStrictClock } from '@/test/helpers';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';
import { edge, resetEdge, setPermission, setRequestResult } from './edge';
import { recordOperation, settle } from './support';

const NOW = Date.parse('2026-10-09T10:00:00.000Z');
const STREAK_KEY = 'push_token_fail_streak';
const PROJECT_ID = '00000000-0000-0000-0000-000000000000';
const TOKEN = 'ExponentPushToken[test-token]';
const n = edge.notifications;
const logger = edge.logger;

type Persona = ReturnType<typeof personaFor>;
const persona = (over: Partial<Persona> = {}) => personaFor(NOW, { userId: 'user-1', ...over });
const signedIn = (over: Partial<Persona> = {}) =>
  useUserStore.setState({ userId: 'user-1', userPersona: persona(over) });
/** Runs a call that may wait on timers or the network, on the strict clock. */
const run = <T,>(p: Promise<T>) => advanceUntilDone(p);
/** Tag `method` of every logger.captureException call (the Apollo error link also reports). */
const capturedMethods = () => logger.captureException.mock.calls.map((c) => c[1]?.tags?.method);

const eas = Constants.expoConfig?.extra?.eas as { projectId?: string };

beforeEach(() => {
  resetEdge();
  useStrictClock(NOW);
  useUserStore.setState(useUserStore.getInitialState(), true);
});
const spies: jest.SpyInstance[] = [];
afterEach(async () => {
  for (const s of spies.splice(0)) s.mockRestore();
  cleanupNotificationListeners();
  (Platform as { OS: string }).OS = 'ios';
  eas.projectId = PROJECT_ID;
  // Fire-and-forget persona writes still in flight would block the next test's database reset.
  jest.useRealTimers();
  await settle();
});

describe('registerForPushNotificationsAsync', () => {
  it('returns the Expo token, asking Expo for the app project id', async () => {
    await expect(run(registerForPushNotificationsAsync())).resolves.toBe(TOKEN);
    expect(n.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: PROJECT_ID });
  });

  it('on a simulator or emulator: null, and no permission is read or asked', async () => {
    edge.device.isDevice = false;
    await expect(run(registerForPushNotificationsAsync())).resolves.toBeNull();
    expect(n.getPermissionsAsync).not.toHaveBeenCalled();
    expect(n.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(n.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  describe('permission states', () => {
    it('granted: never re-asks', async () => {
      await run(registerForPushNotificationsAsync());
      expect(n.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('undetermined: asks with the provisional iOS option on the boot path, then registers', async () => {
      setPermission('undetermined');
      await expect(run(registerForPushNotificationsAsync(true))).resolves.toBe(TOKEN);
      expect(n.requestPermissionsAsync).toHaveBeenCalledWith({ ios: { provisional: true } });
    });

    it('undetermined: asks with no options when the settings toggle wants full permission', async () => {
      setPermission('undetermined');
      await expect(run(registerForPushNotificationsAsync(false))).resolves.toBe(TOKEN);
      expect(n.requestPermissionsAsync).toHaveBeenCalledWith(undefined);
    });

    it('denied and the OS still declines: null, no token requested', async () => {
      setPermission('denied');
      setRequestResult('denied');
      await expect(run(registerForPushNotificationsAsync())).resolves.toBeNull();
      expect(n.requestPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(n.getExpoPushTokenAsync).not.toHaveBeenCalled();
    });

    it('iOS provisional authorisation counts as enough: no prompt, token returned', async () => {
      setPermission('undetermined', { status: 3 });
      await expect(run(registerForPushNotificationsAsync())).resolves.toBe(TOKEN);
      expect(n.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('provisional status is not recognised on Android: it asks as for any undetermined state', async () => {
      (Platform as { OS: string }).OS = 'android';
      setPermission('undetermined', { status: 3 });
      await run(registerForPushNotificationsAsync());
      expect(n.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    });
  });

  it('without an EAS project id: null, no token requested', async () => {
    eas.projectId = undefined;
    await expect(run(registerForPushNotificationsAsync())).resolves.toBeNull();
    expect(n.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('a null token from Expo comes back as null', async () => {
    n.getExpoPushTokenAsync.mockImplementation(async () => null);
    await expect(run(registerForPushNotificationsAsync())).resolves.toBeNull();
  });

  describe('Android channel', () => {
    it('sets up the default channel', async () => {
      (Platform as { OS: string }).OS = 'android';
      await run(registerForPushNotificationsAsync());
      expect(n.setNotificationChannelAsync).toHaveBeenCalledWith('default', {
        name: 'Default',
        importance: 5,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
      });
    });

    it('iOS has no channel', async () => {
      await run(registerForPushNotificationsAsync());
      expect(n.setNotificationChannelAsync).not.toHaveBeenCalled();
    });

    it('is skipped when the token could not be fetched', async () => {
      (Platform as { OS: string }).OS = 'android';
      n.getExpoPushTokenAsync.mockImplementation(async () => {
        throw new Error('FCM unavailable');
      });
      await run(registerForPushNotificationsAsync());
      expect(n.setNotificationChannelAsync).not.toHaveBeenCalled();
    });
  });

  describe('token retrieval failure streak (persisted in the settings table)', () => {
    const failToken = () =>
      n.getExpoPushTokenAsync.mockImplementation(async () => {
        throw new Error('APNs hang');
      });
    const lastCapture = () => logger.captureException.mock.calls.at(-1)!;

    it('the first failure is a warning with streak 1, and returns null', async () => {
      failToken();
      await expect(run(registerForPushNotificationsAsync())).resolves.toBeNull();
      expect(await getSetting(STREAK_KEY)).toBe('1');
      expect(lastCapture()[1]).toMatchObject({
        level: 'warning',
        tags: { service: 'notification-service', method: 'registerForPushNotificationsAsync' },
        extra: { failStreak: 1 },
      });
    });

    it('the third consecutive failure escalates to error', async () => {
      failToken();
      for (let i = 0; i < 3; i++) await run(registerForPushNotificationsAsync());
      expect(await getSetting(STREAK_KEY)).toBe('3');
      expect(lastCapture()[1]).toMatchObject({ level: 'error', extra: { failStreak: 3 } });
      // the two before it were still warnings
      expect(logger.captureException.mock.calls.map((c) => c[1].level)).toEqual(['warning', 'warning', 'error']);
    });

    it('a success clears the streak', async () => {
      failToken();
      await run(registerForPushNotificationsAsync());
      await run(registerForPushNotificationsAsync());
      expect(await getSetting(STREAK_KEY)).toBe('2');

      n.getExpoPushTokenAsync.mockImplementation(async () => ({ data: TOKEN }));
      await expect(run(registerForPushNotificationsAsync())).resolves.toBe(TOKEN);
      expect(await getSetting(STREAK_KEY)).toBe('0');
    });

    it('a token request that never answers is abandoned after 30 seconds and counts as a failure', async () => {
      n.getExpoPushTokenAsync.mockImplementation(() => new Promise(() => {}));
      const started = Date.now();
      await expect(run(registerForPushNotificationsAsync())).resolves.toBeNull();
      expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
      expect(Date.now() - started).toBeLessThan(31_000);
      expect((lastCapture()[0] as Error).message).toBe('Push token retrieval timed out after 30 seconds');
      expect(await getSetting(STREAK_KEY)).toBe('1');
    });
  });
});

describe('the foreground notification handler (set when the module loads)', () => {
  const handle = (data: Record<string, unknown> | undefined) =>
    edge.handler.current!({ request: { content: { data } } });
  const SHOWN = { shouldPlaySound: true, shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true };
  const SILENT = { shouldPlaySound: false, shouldSetBadge: false, shouldShowBanner: false, shouldShowList: false };

  it('was installed at import', () => {
    expect(typeof edge.handler.current).toBe('function');
  });

  it.each(['process-clusters', 'inference-done', 'phase1-done', 'phase2-done'])(
    'a silent %s push shows nothing',
    async (type) => {
      await expect(handle({ type })).resolves.toEqual(SILENT);
    },
  );

  it.each([['feedback_request'], ['fact-check'], ['fact_check_done'], ['something-new']])(
    'a %s push is shown normally',
    async (type) => {
      await expect(handle({ type })).resolves.toEqual(SHOWN);
    },
  );

  it('a push with no data is shown normally', async () => {
    await expect(handle(undefined)).resolves.toEqual(SHOWN);
  });
});

describe('setupNotifications and cleanupNotificationListeners', () => {
  it('with permission granted: adds the received and response listeners, returns null, asks for nothing', async () => {
    await expect(setupNotifications()).resolves.toBeNull();
    expect(edge.receivedListeners.size).toBe(1);
    expect(edge.responseListeners.size).toBe(1);
    expect(n.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it.each(['denied', 'undetermined'] as const)('with permission %s: no listeners', async (status) => {
    setPermission(status);
    await expect(setupNotifications()).resolves.toBeNull();
    expect(edge.receivedListeners.size).toBe(0);
    expect(edge.responseListeners.size).toBe(0);
  });

  it('calling it again replaces the listeners rather than stacking them', async () => {
    await setupNotifications();
    await setupNotifications();
    expect(n.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(2);
    expect(edge.receivedListeners.size).toBe(1);
    expect(edge.responseListeners.size).toBe(1);
  });

  it('cleanup removes both, and a second cleanup is harmless', async () => {
    await setupNotifications();
    cleanupNotificationListeners();
    expect(edge.receivedListeners.size).toBe(0);
    expect(edge.responseListeners.size).toBe(0);
    expect(() => cleanupNotificationListeners()).not.toThrow();
  });

  it('cleanup with nothing set up does not throw', () => {
    expect(() => cleanupNotificationListeners()).not.toThrow();
  });

  it('a notification received in the foreground does nothing: no navigation, no report', async () => {
    await setupNotifications();
    for (const cb of edge.receivedListeners) cb({ request: { content: { data: { type: 'process-clusters' } } } });
    expect(router.push).not.toHaveBeenCalled();
    expect(logger.captureException).not.toHaveBeenCalled();
  });

  it('a failing permission read is reported and still resolves null', async () => {
    n.getPermissionsAsync.mockImplementation(async () => {
      throw new Error('native module gone');
    });
    await expect(setupNotifications()).resolves.toBeNull();
    expect(capturedMethods()).toEqual(['setupNotifications']);
    expect(edge.responseListeners.size).toBe(0);
  });
});

describe('hasUserDeniedPermissions', () => {
  it.each([
    ['denied', true],
    ['granted', false],
    ['undetermined', false],
  ] as const)('%s -> %s', async (status, expected) => {
    setPermission(status);
    await expect(hasUserDeniedPermissions()).resolves.toBe(expected);
  });

  it('false, and reported, when the permission read throws', async () => {
    n.getPermissionsAsync.mockImplementation(async () => {
      throw new Error('boom');
    });
    await expect(hasUserDeniedPermissions()).resolves.toBe(false);
    expect(capturedMethods()).toEqual(['hasUserDeniedPermissions']);
  });
});

describe('setVisibleNotificationsEnabled', () => {
  it('no user id: false, no prompt, no request', async () => {
    const seen = recordOperation('UpdateNotificationsEnabled');
    await expect(run(setVisibleNotificationsEnabled('', true))).resolves.toBe(false);
    expect(n.getPermissionsAsync).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('on, permission already granted: no prompt, flag sent, persona cached', async () => {
    signedIn();
    const seen = recordOperation('UpdateNotificationsEnabled');
    await expect(run(setVisibleNotificationsEnabled('user-1', true))).resolves.toBe(true);
    expect(n.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(seen).toEqual([{ input: { userId: 'user-1', enabled: true } }]);
    expect(useUserStore.getState().userPersona?.notificationsEnabled).toBe(true);
  });

  it('on, permission undetermined and the user grants: asks for FULL permission, then sends', async () => {
    signedIn();
    setPermission('undetermined');
    const seen = recordOperation('UpdateNotificationsEnabled');
    await expect(run(setVisibleNotificationsEnabled('user-1', true))).resolves.toBe(true);
    expect(n.requestPermissionsAsync).toHaveBeenCalledWith(); // no provisional option here
    expect(seen).toHaveLength(1);
  });

  it('on, and the OS declines: false, nothing sent, persona untouched', async () => {
    signedIn({ notificationsEnabled: false });
    setPermission('denied');
    setRequestResult('denied');
    const seen = recordOperation('UpdateNotificationsEnabled');
    await expect(run(setVisibleNotificationsEnabled('user-1', true))).resolves.toBe(false);
    expect(seen).toEqual([]);
    expect(useUserStore.getState().userPersona?.notificationsEnabled).toBe(false);
  });

  it('off: never touches permissions, sends the flag', async () => {
    signedIn({ notificationsEnabled: true });
    const seen = recordOperation('UpdateNotificationsEnabled');
    await expect(run(setVisibleNotificationsEnabled('user-1', false))).resolves.toBe(true);
    expect(n.getPermissionsAsync).not.toHaveBeenCalled();
    expect(n.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(seen).toEqual([{ input: { userId: 'user-1', enabled: false } }]);
    expect(useUserStore.getState().userPersona?.notificationsEnabled).toBe(false);
  });

  // DA41. expo reports iOS PROVISIONAL authorisation as status 'granted' (the file's own comment in
  // registerForPushNotificationsAsync says so), and setVisibleNotificationsEnabled only prompts when
  // status !== 'granted'. Its doc promises "provisional -> full", but a provisional user never sees the
  // prompt, so visible alerts stay quiet. To be confirmed on a device before the P3 fix.
  test.failing('DA41: turning on visible notifications from provisional asks for full permission', async () => {
    signedIn();
    setPermission('granted', { status: 3 });
    await run(setVisibleNotificationsEnabled('user-1', true));
    expect(n.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('DA41 today: turning on visible notifications from provisional makes no permission request', async () => {
    signedIn();
    setPermission('granted', { status: 3 });
    const seen = recordOperation('UpdateNotificationsEnabled');
    await expect(run(setVisibleNotificationsEnabled('user-1', true))).resolves.toBe(true);
    expect(n.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });

  it('a server error: false, reported, persona untouched', async () => {
    signedIn({ notificationsEnabled: false });
    server.use(mockGqlError('UpdateNotificationsEnabled', 'INTERNAL_SERVER_ERROR'));
    await expect(run(setVisibleNotificationsEnabled('user-1', true))).resolves.toBe(false);
    expect(capturedMethods()).toContain('setVisibleNotificationsEnabled');
    expect(useUserStore.getState().userPersona?.notificationsEnabled).toBe(false);
  });
});

describe('checkPushTokenRevocation', () => {
  const OLD = 'ExponentPushToken[old]';

  it('no signed-in user: does nothing, even with permission denied', async () => {
    setPermission('denied');
    const seen = recordOperation('DeleteExpoPushToken');
    await run(checkPushTokenRevocation());
    expect(seen).toEqual([]);
  });

  describe('permission denied', () => {
    it('with a cached token: deletes it server-side and clears it from the persona', async () => {
      signedIn({ expoPushToken: OLD });
      setPermission('denied');
      const seen = recordOperation('DeleteExpoPushToken');
      await run(checkPushTokenRevocation());
      expect(seen).toEqual([{ input: { userId: 'user-1' } }]);
      expect(useUserStore.getState().userPersona?.expoPushToken).toBeNull();
    });

    it('with no cached token: nothing to delete', async () => {
      signedIn({ expoPushToken: null });
      setPermission('denied');
      const seen = recordOperation('DeleteExpoPushToken');
      await run(checkPushTokenRevocation());
      expect(seen).toEqual([]);
    });
  });

  describe('permission granted or undetermined, persona holds no token', () => {
    it.each(['granted', 'undetermined'] as const)('%s: registers and sends the new token', async (status) => {
      signedIn({ expoPushToken: null });
      setPermission(status);
      const seen = recordOperation('UpdateExpoPushToken');
      await run(checkPushTokenRevocation());
      expect(seen).toEqual([{ input: { userId: 'user-1', expoPushToken: TOKEN } }]);
      expect(useUserStore.getState().userPersona?.expoPushToken).toBe(TOKEN);
    });

    it('registration yields no token (simulator): nothing is sent', async () => {
      signedIn({ expoPushToken: null });
      edge.device.isDevice = false;
      const seen = recordOperation('UpdateExpoPushToken');
      await run(checkPushTokenRevocation());
      expect(seen).toEqual([]);
      expect(useUserStore.getState().userPersona?.expoPushToken).toBeNull();
    });
  });

  it('granted and a token is already cached: asks nothing of Expo, sends nothing', async () => {
    signedIn({ expoPushToken: OLD });
    const seen = recordOperation('UpdateExpoPushToken');
    await run(checkPushTokenRevocation());
    expect(n.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('a permission state that is neither denied, granted nor undetermined: leaves the token alone', async () => {
    signedIn({ expoPushToken: null });
    n.getPermissionsAsync.mockImplementation(async () => ({ status: 'blocked' }));
    const seen = recordOperation('UpdateExpoPushToken');
    await run(checkPushTokenRevocation());
    expect(n.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  describe('failures', () => {
    it('a server error is reported with the method tag', async () => {
      signedIn({ expoPushToken: OLD });
      setPermission('denied');
        server.use(mockGqlError('DeleteExpoPushToken', 'INTERNAL_SERVER_ERROR'));
      await run(checkPushTokenRevocation());
      expect(capturedMethods()).toContain('checkPushTokenRevocation');
      expect(useUserStore.getState().userPersona?.expoPushToken).toBe(OLD);
    });

    // A React Native fetch failure reads exactly "Network request failed"; Node's fetch words it
    // differently, so the one failing call is injected on the real AccountService (R23).
    it('a bare "Network request failed" is a breadcrumb, not a report', async () => {
      signedIn({ expoPushToken: OLD });
      setPermission('denied');
      spies.push(
        jest.spyOn(AccountService, 'deleteExpoPushToken').mockRejectedValueOnce(new Error('Network request failed')),
      );
      await run(checkPushTokenRevocation());
      expect(capturedMethods()).not.toContain('checkPushTokenRevocation');
      expect(logger.addBreadcrumb).toHaveBeenCalledWith(
        'checkPushTokenRevocation: network request failed — will retry next tick',
        'notification-service',
        { message: 'Network request failed' },
        'warning',
      );
    });

    it('a permission read that throws is reported', async () => {
      signedIn();
      n.getPermissionsAsync.mockImplementation(async () => {
        throw new Error('boom');
      });
      await run(checkPushTokenRevocation());
      expect(capturedMethods()).toEqual(['checkPushTokenRevocation']);
    });
  });
});
