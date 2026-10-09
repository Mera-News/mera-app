// The edges notification-service talks to: expo-notifications, expo-device, the logger and the
// Intercom wrapper's token hand-off.
// One instance per Jest environment, kept on globalThis, because a "reload" in these tests is a
// fresh module registry (jest.isolateModules, see support.ts) and a registry-local mock would be a
// DIFFERENT jest.fn in the reloaded graph than the one the test asserts on.
//
// Not a test file. Loaded by the `jest.mock` factories in each test file.
type Listener = (payload: any) => void;

interface Edge {
  /** What `expo-device` reports. */
  device: { isDevice: boolean };
  /** The foreground handler the service handed to `setNotificationHandler`. */
  handler: { current: ((n: any) => Promise<any>) | null };
  responseListeners: Set<Listener>;
  receivedListeners: Set<Listener>;
  tokenListeners: Set<Listener>;
  /** What `getLastNotificationResponseAsync` resolves to (the cold-boot path). */
  lastResponse: { current: unknown };
  notifications: Record<string, any>;
  deviceModule: Record<string, unknown>;
  logger: Record<string, jest.Mock>;
  /** The Intercom wrapper's token hand-off (lib/intercom.ts sendIntercomPushToken). */
  sendIntercomPushToken: jest.Mock;
  loggerModule: Record<string, unknown>;
}

function build(): Edge {
  const device = { isDevice: true };
  const handler: Edge['handler'] = { current: null };
  const responseListeners = new Set<Listener>();
  const receivedListeners = new Set<Listener>();
  const tokenListeners = new Set<Listener>();
  const lastResponse: Edge['lastResponse'] = { current: null };

  const subscribe = (set: Set<Listener>) =>
    jest.fn((cb: Listener) => {
      set.add(cb);
      return { remove: jest.fn(() => void set.delete(cb)) };
    });

  const notifications = {
    setNotificationHandler: jest.fn((h: any) => {
      handler.current = h?.handleNotification ?? null;
    }),
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
    getExpoPushTokenAsync: jest.fn(),
    getDevicePushTokenAsync: jest.fn(),
    setNotificationChannelAsync: jest.fn(),
    getLastNotificationResponseAsync: jest.fn(async () => lastResponse.current),
    addNotificationReceivedListener: subscribe(receivedListeners),
    addNotificationResponseReceivedListener: subscribe(responseListeners),
    addPushTokenListener: subscribe(tokenListeners),
    IosAuthorizationStatus: { PROVISIONAL: 3 },
    AndroidImportance: { MAX: 5 },
  };

  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  };

  return {
    device,
    handler,
    responseListeners,
    receivedListeners,
    tokenListeners,
    lastResponse,
    notifications,
    deviceModule: {
      get isDevice() {
        return device.isDevice;
      },
      osVersion: '18.0',
    },
    logger,
    sendIntercomPushToken: jest.fn(async () => undefined),
    loggerModule: { __esModule: true, default: logger },
  };
}

const g = globalThis as unknown as { __notificationEdge?: Edge };
export const edge: Edge = (g.__notificationEdge ??= build());

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

/** Back to a granted, token-holding physical iPhone with nothing delivered. Run in beforeEach. */
export function resetEdge(): void {
  edge.device.isDevice = true;
  edge.responseListeners.clear();
  edge.receivedListeners.clear();
  edge.tokenListeners.clear();
  edge.lastResponse.current = null;
  const n = edge.notifications;
  n.getPermissionsAsync.mockReset().mockImplementation(async () => ({ status: 'granted' }));
  n.requestPermissionsAsync.mockReset().mockImplementation(async () => ({ status: 'granted' }));
  n.getExpoPushTokenAsync.mockReset().mockImplementation(async () => ({ data: 'ExponentPushToken[test-token]' }));
  n.getDevicePushTokenAsync.mockReset().mockImplementation(async () => ({ data: 'raw-device-token' }));
  n.setNotificationChannelAsync.mockReset().mockImplementation(async () => undefined);
  n.getLastNotificationResponseAsync.mockReset().mockImplementation(async () => edge.lastResponse.current);
  for (const fn of Object.values(edge.logger)) fn.mockReset();
  edge.sendIntercomPushToken.mockReset().mockImplementation(async () => undefined);
}

export const setPermission = (status: PermissionStatus, ios?: { status: number }) =>
  edge.notifications.getPermissionsAsync.mockImplementation(async () => ({ status, ios }));

export const setRequestResult = (status: PermissionStatus) =>
  edge.notifications.requestPermissionsAsync.mockImplementation(async () => ({ status }));

/** A tap response as expo-notifications delivers it. */
export function tapResponse(identifier: string | undefined, data: Record<string, unknown> = {}, date = 1_700_000_000) {
  return {
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: { date, request: { identifier, content: { data } } },
  };
}

/** The warm path: a tap while the app runs, delivered to every registered response listener. */
export function deliverTap(response: unknown): void {
  for (const cb of [...edge.responseListeners]) cb(response);
}

/** The cold-boot path: the tap `getLastNotificationResponseAsync` keeps returning. */
export function setLastTap(response: unknown): void {
  edge.lastResponse.current = response;
}

/** The OS rotating the native device token. */
export function rotateDeviceToken(data: string): void {
  for (const cb of [...edge.tokenListeners]) cb({ type: 'ios', data });
}
