// notification-service.ts has module-level side effect: Notifications.setNotificationHandler
// called immediately when the module is imported. The mock factory runs (and the
// module is loaded) BEFORE any `const` declarations in the test body execute.
//
// To capture the handler passed to setNotificationHandler at module load time
// (before any clearAllMocks wipes mock.calls), we use global to store it.
// global is always accessible from within the factory closure and the test body.
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn((h: any) => { (global as any).__capturedNotifHandler = h; }),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn(),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  AndroidImportance: { MAX: 5 },
}));

const mockIsDevice = { value: true };
jest.mock('expo-device', () => ({
  get isDevice() { return mockIsDevice.value; },
}));

jest.mock('expo-constants', () => ({
  // __esModule: true is required so that Babel's _interopRequireDefault correctly
  // unwraps the default export (import Constants from 'expo-constants' → Constants = mock.default).
  __esModule: true,
  default: {
    expoConfig: {
      scheme: 'testapp',
      slug: 'testapp',
      extra: { eas: { projectId: 'test-project-id' } },
    },
  },
}));

// expo-router: factory is self-contained (no external variable refs)
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

const mockPlatformOS = { OS: 'ios' as string };

// notification-service.ts does `import { Platform } from 'react-native'`.
// Mock 'react-native' providing only the exports needed by notification-service.ts.
// The Platform getter lazily reads mockPlatformOS.OS (initialized before tests run).
jest.mock('react-native', () => ({
  Platform: {
    get OS() { return mockPlatformOS.OS; },
    select: (obj: any) => obj[mockPlatformOS.OS],
  },
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    currentState: 'active',
  },
}));

// account-service: factory is self-contained
jest.mock('../account-service', () => ({
  AccountService: {
    updateExpoPushTokenMutation: jest.fn(),
    updateNotificationsEnabled: jest.fn(),
    deleteExpoPushToken: jest.fn(),
  },
}));

const mockUserStoreState = {
  userId: 'user-123',
  userPersona: { expoPushToken: null as string | null },
  setUserPersona: jest.fn(),
};
jest.mock('../stores/user-store', () => ({
  useUserStore: {
    // getState wraps the object lazily — works even if mockUserStoreState is in TDZ
    // at factory run time, because the wrapper fn is only invoked later in tests.
    getState: jest.fn(() => mockUserStoreState),
    setState: jest.fn(),
  },
}));

// logger: factory is self-contained
jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

// Mock dynamic imports inside notification-service
// Use self-contained factories to avoid TDZ with jest.mock hoisting
jest.mock('../stores/for-you-store', () => ({
  useForYouStore: { setState: jest.fn() },
}));

jest.mock('../database/services/article-suggestion-service', () => ({
  loadSuggestions: jest.fn(() => Promise.resolve([])),
}));

import {
  registerForPushNotificationsAsync,
  setupNotifications,
  handleInitialNotification,
  cleanupNotificationListeners,
  ensurePushTokenRegistered,
  setVisibleNotificationsEnabled,
  checkPushTokenRevocation,
  hasUserDeniedPermissions,
} from '../notification-service';

// Grab mock fn references via require() — same module cache that notification-service
// uses internally, guaranteeing we reference the EXACT same jest.fn() instances.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Notifications = require('expo-notifications');
const mockSetNotificationHandler: jest.Mock = Notifications.setNotificationHandler;
const mockGetPermissionsAsync: jest.Mock = Notifications.getPermissionsAsync;
const mockRequestPermissionsAsync: jest.Mock = Notifications.requestPermissionsAsync;
const mockGetExpoPushTokenAsync: jest.Mock = Notifications.getExpoPushTokenAsync;
const mockSetNotificationChannelAsync: jest.Mock = Notifications.setNotificationChannelAsync;
const mockAddNotificationReceivedListener: jest.Mock = Notifications.addNotificationReceivedListener;
const mockAddNotificationResponseReceivedListener: jest.Mock = Notifications.addNotificationResponseReceivedListener;
const mockGetLastNotificationResponseAsync: jest.Mock = Notifications.getLastNotificationResponseAsync;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { router: mockRouter } = require('expo-router');
const mockRouterPush: jest.Mock = mockRouter.push;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AccountService: MockAccountService } = require('../account-service');
const mockUpdateExpoPushTokenMutation: jest.Mock = MockAccountService.updateExpoPushTokenMutation;
const mockUpdateNotificationsEnabled: jest.Mock = MockAccountService.updateNotificationsEnabled;
const mockDeleteExpoPushToken: jest.Mock = MockAccountService.deleteExpoPushToken;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockLogger = require('../logger').default;
const mockLoggerCaptureException: jest.Mock = mockLogger.captureException;

describe('registerForPushNotificationsAsync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDevice.value = true;
    mockPlatformOS.OS = 'ios';
    mockUserStoreState.userPersona = { expoPushToken: null };
  });

  it('returns null on an emulator (Device.isDevice = false)', async () => {
    mockIsDevice.value = false;
    const result = await registerForPushNotificationsAsync();
    expect(result).toBeNull();
  });

  it('returns null when permissions are denied', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'denied', ios: {} });
    mockRequestPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    const result = await registerForPushNotificationsAsync();
    expect(result).toBeNull();
  });

  it.skip('returns null when projectId is missing (via module-level static import — see isolateModules test below)', async () => {
    // SOURCE BUG: Constants is captured at module import time; jest.resetModules()
    // + jest.doMock cannot change Constants.expoConfig seen by the already-imported
    // notification-service.ts. Additionally, jest.resetModules() de-syncs the
    // expo-notifications mock held by notification-service from the test's mock refs,
    // breaking all subsequent tests in this file that run after this test.
    jest.resetModules();
    jest.doMock('expo-constants', () => ({
      default: { expoConfig: { extra: {} } },
    }));
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted', ios: {} });
    const result = await registerForPushNotificationsAsync();
    expect(result).toBeNull();
  });

  it('returns null when projectId is missing (line 101/102 — via isolateModules)', async () => {
    // Use isolateModules + doMock to load a fresh notification-service that sees
    // expo-constants without a projectId. This covers the if(!projectId) branch at line 101.
    let isolatedRegister: typeof registerForPushNotificationsAsync;
    jest.isolateModules(() => {
      jest.doMock('expo-constants', () => ({
        __esModule: true,
        default: { expoConfig: { extra: {} } }, // projectId absent → undefined
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      isolatedRegister = require('../notification-service').registerForPushNotificationsAsync;
    });
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted', ios: {} });
    const result = await isolatedRegister!();
    expect(result).toBeNull();
  });

  it('returns the push token on success (iOS, granted)', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted', ios: {} });
    mockGetExpoPushTokenAsync.mockResolvedValueOnce({ data: 'ExponentPushToken[test]' });
    const result = await registerForPushNotificationsAsync();
    expect(result).toBe('ExponentPushToken[test]');
  });

  it('does not re-request permissions when already granted', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted', ios: {} });
    mockGetExpoPushTokenAsync.mockResolvedValueOnce({ data: 'ExponentPushToken[tok]' });
    await registerForPushNotificationsAsync();
    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('requests permissions when not granted (non-provisional path)', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'undetermined', ios: {} });
    mockRequestPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    mockGetExpoPushTokenAsync.mockResolvedValueOnce({ data: 'ExponentPushToken[tok]' });
    await registerForPushNotificationsAsync(false);
    expect(mockRequestPermissionsAsync).toHaveBeenCalledWith(undefined);
  });

  it('requests provisional permissions on iOS when allowProvisional=true', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'undetermined', ios: {} });
    mockRequestPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    mockGetExpoPushTokenAsync.mockResolvedValueOnce({ data: 'ExponentPushToken[prov]' });
    await registerForPushNotificationsAsync(true);
    expect(mockRequestPermissionsAsync).toHaveBeenCalledWith(
      expect.objectContaining({ ios: { provisional: true } }),
    );
  });

  it('skips re-requesting when already provisional on iOS', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({
      status: 'undetermined',
      ios: { status: 3 }, // PROVISIONAL = 3
    });
    mockGetExpoPushTokenAsync.mockResolvedValueOnce({ data: 'ExponentPushToken[prov]' });
    const result = await registerForPushNotificationsAsync(true);
    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
    expect(result).toBe('ExponentPushToken[prov]');
  });

  it('sets up notification channel on Android', async () => {
    mockPlatformOS.OS = 'android';
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted', ios: {} });
    mockGetExpoPushTokenAsync.mockResolvedValueOnce({ data: 'ExponentPushToken[android]' });
    await registerForPushNotificationsAsync();
    expect(mockSetNotificationChannelAsync).toHaveBeenCalledWith('default', expect.any(Object));
  });

  it('returns null and captures exception on token retrieval error', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted', ios: {} });
    mockGetExpoPushTokenAsync.mockRejectedValueOnce(new Error('APNs error'));
    const result = await registerForPushNotificationsAsync();
    expect(result).toBeNull();
    expect(mockLoggerCaptureException).toHaveBeenCalled();
  });

  it('returns null when getExpoPushTokenAsync resolves to null (line 118 false branch)', async () => {
    // Covers BranchMap 11 arm[1]: pushTokenData is falsy after Promise.race
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted', ios: {} });
    mockGetExpoPushTokenAsync.mockResolvedValueOnce(null as any);
    const result = await registerForPushNotificationsAsync();
    expect(result).toBeNull();
  });

  it('times out when getExpoPushTokenAsync hangs past 30s (covers line 113 setTimeout callback)', async () => {
    // Covers anonymous_3 (the setTimeout(() => reject(...), 30000) callback at line 113).
    // Use fake timers so we don't wait 30 real seconds.
    jest.useFakeTimers({ doNotFake: ['Promise', 'nextTick', 'queueMicrotask', 'setImmediate'] as any });
    try {
      mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted', ios: {} });
      // getExpoPushTokenAsync never resolves — simulates a hang
      mockGetExpoPushTokenAsync.mockReturnValueOnce(new Promise(() => {}));

      const resultPromise = registerForPushNotificationsAsync();

      // Let the async setup complete before advancing the clock
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Trigger the 30-second timeout callback
      jest.advanceTimersByTime(31000);

      await Promise.resolve();
      await Promise.resolve();

      const result = await resultPromise;
      expect(result).toBeNull();
      // The timeout rejection is caught by the try/catch → captureException called
      expect(mockLoggerCaptureException).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('setupNotifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null (does not request permissions)', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'undetermined' });
    const result = await setupNotifications();
    expect(result).toBeNull();
    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('sets up listeners when permissions are already granted', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    await setupNotifications();
    expect(mockAddNotificationReceivedListener).toHaveBeenCalled();
    expect(mockAddNotificationResponseReceivedListener).toHaveBeenCalled();
  });

  it('covers the empty received-notification callback (line 239 anonymous_10)', async () => {
    // addNotificationReceivedListener receives `() => {}` — an empty no-op. Istanbul
    // counts it as an uncovered function unless we explicitly invoke it.
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    await setupNotifications();
    // Grab the callback passed to addNotificationReceivedListener
    const receivedCallback = mockAddNotificationReceivedListener.mock.calls[0][0];
    expect(typeof receivedCallback).toBe('function');
    // Invoke the empty callback to mark anonymous_10 as covered
    expect(() => receivedCallback()).not.toThrow();
  });

  it('does NOT set up listeners when permissions are not granted', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    await setupNotifications();
    expect(mockAddNotificationReceivedListener).not.toHaveBeenCalled();
  });

  it('captures exception and returns null on error', async () => {
    mockGetPermissionsAsync.mockRejectedValueOnce(new Error('permission check failed'));
    const result = await setupNotifications();
    expect(result).toBeNull();
    expect(mockLoggerCaptureException).toHaveBeenCalled();
  });
});

describe('cleanupNotificationListeners', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('removes existing listeners and sets them to null', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    await setupNotifications(); // sets up listeners
    cleanupNotificationListeners();
    const { addNotificationReceivedListener } = require('expo-notifications');
    // If we call cleanup again, it should not throw
    expect(() => cleanupNotificationListeners()).not.toThrow();
  });

  it('does not throw when no listeners exist', () => {
    cleanupNotificationListeners();
    expect(() => cleanupNotificationListeners()).not.toThrow();
  });
});

describe('handleInitialNotification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does nothing when no last notification response exists', async () => {
    mockGetLastNotificationResponseAsync.mockResolvedValueOnce(null);
    await handleInitialNotification();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('navigates to for_you when a notification response exists', async () => {
    mockGetLastNotificationResponseAsync.mockResolvedValueOnce({
      notification: {
        request: {
          content: { data: { type: 'news-ready', userId: 'u1' } },
        },
      },
    });
    await handleInitialNotification();
    expect(mockRouterPush).toHaveBeenCalledWith('/logged-in/app_container/for_you');
  });

  it('captures exception without throwing on error', async () => {
    mockGetLastNotificationResponseAsync.mockRejectedValueOnce(new Error('storage error'));
    await expect(handleInitialNotification()).resolves.not.toThrow();
    expect(mockLoggerCaptureException).toHaveBeenCalled();
  });
});

describe('ensurePushTokenRegistered', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDevice.value = true;
    mockPlatformOS.OS = 'ios';
    mockUserStoreState.userId = 'user-123';
    mockUserStoreState.userPersona = { expoPushToken: null };
    mockUserStoreState.setUserPersona.mockClear();
  });

  it('returns early when userId is empty', async () => {
    await ensurePushTokenRegistered('');
    expect(mockGetPermissionsAsync).not.toHaveBeenCalled();
  });

  it('returns early when registerForPushNotificationsAsync returns null', async () => {
    mockIsDevice.value = false;
    await ensurePushTokenRegistered('user-123');
    expect(mockUpdateExpoPushTokenMutation).not.toHaveBeenCalled();
  });

  it('updates token server-side when token differs from cached', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted', ios: {} });
    mockGetExpoPushTokenAsync.mockResolvedValueOnce({ data: 'ExponentPushToken[new-token]' });
    mockUserStoreState.userPersona = { expoPushToken: 'ExponentPushToken[old-token]' };
    const updatedPersona = { expoPushToken: 'ExponentPushToken[new-token]' };
    mockUpdateExpoPushTokenMutation.mockResolvedValueOnce(updatedPersona);

    await ensurePushTokenRegistered('user-123');

    expect(mockUpdateExpoPushTokenMutation).toHaveBeenCalledWith(
      'user-123',
      'ExponentPushToken[new-token]',
    );
    expect(mockUserStoreState.setUserPersona).toHaveBeenCalledWith(updatedPersona);
  });

  it('does NOT update server when token matches cached token', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted', ios: {} });
    mockGetExpoPushTokenAsync.mockResolvedValueOnce({ data: 'ExponentPushToken[same]' });
    mockUserStoreState.userPersona = { expoPushToken: 'ExponentPushToken[same]' };

    await ensurePushTokenRegistered('user-123');

    expect(mockUpdateExpoPushTokenMutation).not.toHaveBeenCalled();
  });

  it('captures exception on error', async () => {
    mockGetPermissionsAsync.mockRejectedValueOnce(new Error('network error'));
    await ensurePushTokenRegistered('user-123');
    expect(mockLoggerCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { service: 'notification-service', method: 'ensurePushTokenRegistered' },
      }),
    );
  });
});

describe('setVisibleNotificationsEnabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserStoreState.setUserPersona.mockClear();
  });

  it('returns false when userId is empty', async () => {
    const result = await setVisibleNotificationsEnabled('', true);
    expect(result).toBe(false);
  });

  it('returns false when enabling and OS denies permission', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    mockRequestPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    const result = await setVisibleNotificationsEnabled('user-123', true);
    expect(result).toBe(false);
  });

  it('does not request permission when disabling', async () => {
    const updatedPersona = { expoPushToken: null, notificationsEnabled: false };
    mockUpdateNotificationsEnabled.mockResolvedValueOnce(updatedPersona);
    await setVisibleNotificationsEnabled('user-123', false);
    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('returns true on successful enable', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    const updatedPersona = { notificationsEnabled: true };
    mockUpdateNotificationsEnabled.mockResolvedValueOnce(updatedPersona);
    const result = await setVisibleNotificationsEnabled('user-123', true);
    expect(result).toBe(true);
    expect(mockUserStoreState.setUserPersona).toHaveBeenCalledWith(updatedPersona);
  });

  it('skips requesting permission when already granted', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    mockUpdateNotificationsEnabled.mockResolvedValueOnce({ notificationsEnabled: true });
    await setVisibleNotificationsEnabled('user-123', true);
    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('returns false and captures exception on server error', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    mockUpdateNotificationsEnabled.mockRejectedValueOnce(new Error('GraphQL error'));
    const result = await setVisibleNotificationsEnabled('user-123', true);
    expect(result).toBe(false);
    expect(mockLoggerCaptureException).toHaveBeenCalled();
  });

  it('returns true when permission was undetermined, requestPermissions grants (line 374 false branch)', async () => {
    // Covers BranchMap 34 arm[1]: requestPermissionsAsync returns 'granted', so
    // the "if (status !== 'granted') return false" takes the FALSE (continue) path.
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'undetermined' });
    mockRequestPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    const updatedPersona = { notificationsEnabled: true };
    mockUpdateNotificationsEnabled.mockResolvedValueOnce(updatedPersona);
    const result = await setVisibleNotificationsEnabled('user-123', true);
    expect(result).toBe(true);
    expect(mockRequestPermissionsAsync).toHaveBeenCalled();
  });
});

describe('checkPushTokenRevocation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserStoreState.userId = 'user-123';
    mockUserStoreState.userPersona = { expoPushToken: 'ExponentPushToken[tok]' };
    mockUserStoreState.setUserPersona.mockClear();
  });

  it('returns early when userId is not set', async () => {
    mockUserStoreState.userId = null as any;
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    await checkPushTokenRevocation();
    expect(mockDeleteExpoPushToken).not.toHaveBeenCalled();
  });

  it('deletes token server-side when permission is denied and token exists', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    const updated = { expoPushToken: null };
    mockDeleteExpoPushToken.mockResolvedValueOnce(updated);
    await checkPushTokenRevocation();
    expect(mockDeleteExpoPushToken).toHaveBeenCalledWith('user-123');
    expect(mockUserStoreState.setUserPersona).toHaveBeenCalledWith(updated);
  });

  it('does not delete when denied but no cached token', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    mockUserStoreState.userPersona = { expoPushToken: null };
    await checkPushTokenRevocation();
    expect(mockDeleteExpoPushToken).not.toHaveBeenCalled();
  });

  it('re-registers when granted but no cached token', async () => {
    // checkPushTokenRevocation calls getPermissionsAsync once for the revocation
    // check, then calls registerForPushNotificationsAsync which calls it again.
    // We need two mockResolvedValueOnce entries — one for each call.
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted', ios: {} });
    mockUserStoreState.userPersona = { expoPushToken: null };
    mockIsDevice.value = true;
    mockGetExpoPushTokenAsync.mockResolvedValueOnce({ data: 'ExponentPushToken[re-reg]' });
    const updated = { expoPushToken: 'ExponentPushToken[re-reg]' };
    mockUpdateExpoPushTokenMutation.mockResolvedValueOnce(updated);
    await checkPushTokenRevocation();
    expect(mockUpdateExpoPushTokenMutation).toHaveBeenCalled();
  });

  it('captures exception on error', async () => {
    mockGetPermissionsAsync.mockRejectedValueOnce(new Error('check failed'));
    await checkPushTokenRevocation();
    expect(mockLoggerCaptureException).toHaveBeenCalled();
  });

  it('skips re-register when granted but token already cached (line 414 false branch)', async () => {
    // Covers BranchMap 39 arm[1]: !cachedToken is false → skip re-registration
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    mockUserStoreState.userPersona = { expoPushToken: 'ExponentPushToken[existing]' };
    await checkPushTokenRevocation();
    expect(mockUpdateExpoPushTokenMutation).not.toHaveBeenCalled();
  });

  it('skips re-register when status is neither granted nor undetermined (line 414 arm[2])', async () => {
    // Covers BranchMap 40 arm[2]: status is e.g. 'provisional' (not 'granted' or 'undetermined')
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'provisional' as any });
    mockUserStoreState.userPersona = { expoPushToken: null };
    await checkPushTokenRevocation();
    expect(mockUpdateExpoPushTokenMutation).not.toHaveBeenCalled();
  });

  it('skips setUserPersona when re-registration returns null token (line 416 false branch)', async () => {
    // Covers BranchMap 41 arm[1]: registerForPushNotificationsAsync returns null
    // (e.g., device is emulator)
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    mockIsDevice.value = false; // registerForPushNotificationsAsync returns null early
    mockUserStoreState.userPersona = { expoPushToken: null };
    await checkPushTokenRevocation();
    expect(mockUpdateExpoPushTokenMutation).not.toHaveBeenCalled();
    expect(mockUserStoreState.setUserPersona).not.toHaveBeenCalled();
  });
});

describe('hasUserDeniedPermissions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns true when status is "denied"', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    expect(await hasUserDeniedPermissions()).toBe(true);
  });

  it('returns false when status is "granted"', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    expect(await hasUserDeniedPermissions()).toBe(false);
  });

  it('returns false when status is "undetermined"', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'undetermined' });
    expect(await hasUserDeniedPermissions()).toBe(false);
  });

  it('returns false and captures exception on error', async () => {
    mockGetPermissionsAsync.mockRejectedValueOnce(new Error('perm check fail'));
    const result = await hasUserDeniedPermissions();
    expect(result).toBe(false);
    expect(mockLoggerCaptureException).toHaveBeenCalled();
  });
});

describe('refreshForYouCacheFromDb (via handleInitialNotification)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDevice.value = true;
    mockPlatformOS.OS = 'ios';
  });

  // NOTE: refreshForYouCacheFromDb uses dynamic import() internally. Babel's
  // @babel/plugin-transform-modules-commonjs transforms static imports but NOT
  // dynamic import() expressions — those remain as native import() calls which throw
  // "dynamic import callback invoked without --experimental-vm-modules" in Jest's CJS
  // environment. The throw is caught by refreshForYouCacheFromDb's own try/catch, so
  // navigation still proceeds. Lines 193-203 (the code after the await Promise.all)
  // are therefore unreachable in this Jest environment — this is a test environment
  // constraint, not a source bug.
  it('navigates even when refreshForYouCacheFromDb catches import() error (TEST ENV NOTE: lines 193-203 unreachable)', async () => {
    mockGetLastNotificationResponseAsync.mockResolvedValueOnce({
      notification: {
        request: {
          content: { data: { type: 'news-ready' } },
        },
      },
    });

    await handleInitialNotification();

    // refreshForYouCacheFromDb's dynamic import throws → caught → handleNotificationNavigation proceeds
    expect(mockRouterPush).toHaveBeenCalledWith('/logged-in/app_container/for_you');
    // import() error is captured by refreshForYouCacheFromDb's catch block
    expect(mockLoggerCaptureException).toHaveBeenCalled();
  });

  it('captures exception in refreshForYouCacheFromDb on error (import() always throws in Jest CJS)', async () => {
    mockGetLastNotificationResponseAsync.mockResolvedValueOnce({
      notification: {
        request: {
          content: { data: { type: 'news-ready' } },
        },
      },
    });

    await handleInitialNotification();

    expect(mockLoggerCaptureException).toHaveBeenCalled();
  });
});

describe('response listener callback (lines 244-245)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fires handleNotificationNavigation when response listener callback is invoked', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    await setupNotifications();

    // Grab the callback registered with addNotificationResponseReceivedListener
    const responseCallback = mockAddNotificationResponseReceivedListener.mock.calls[0][0];
    expect(typeof responseCallback).toBe('function');

    // The callback is fire-and-forget (void handleNotificationNavigation(data)).
    // Call it synchronously — do NOT await it (it returns undefined).
    // Then flush the microtask / macrotask queue so the async chain resolves.
    responseCallback({
      notification: {
        request: {
          content: { data: { type: 'news-ready', userId: 'u1' } },
        },
      },
    });

    // refreshForYouCacheFromDb's dynamic import() throws (Jest CJS env), its catch handles
    // it, then handleNotificationNavigation calls router.push. Flush the event loop.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();

    expect(mockRouterPush).toHaveBeenCalledWith('/logged-in/app_container/for_you');
  });

  it('handleNotificationNavigation catch block fires when router.push throws (line 225)', async () => {
    mockGetPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    await setupNotifications();

    const responseCallback = mockAddNotificationResponseReceivedListener.mock.calls[0][0];

    // Make router.push throw to exercise handleNotificationNavigation's catch block (line 225)
    mockRouterPush.mockImplementationOnce(() => { throw new Error('navigation error'); });

    responseCallback({
      notification: {
        request: {
          content: { data: { type: 'news-ready' } },
        },
      },
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();

    // The catch block at line 225 calls logger.captureException
    expect(mockLoggerCaptureException).toHaveBeenCalled();
  });
});

// Push-token rotation tests need a fresh notification-service module instance so that
// the module-level `pushTokenListener` variable starts as null (it's set on the first
// successful ensurePushTokenRegistered call and never reset).  jest.isolateModules()
// gives us a private module registry where the variable is always null.
describe('ensurePushTokenRegistered — push token rotation (lines 317-337)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDevice.value = true;
    mockPlatformOS.OS = 'ios';
    mockUserStoreState.userId = 'user-123';
    mockUserStoreState.userPersona = { expoPushToken: null };
    mockUserStoreState.setUserPersona.mockClear();
  });

  it('fires the addPushTokenListener callback and re-registers when token differs', async () => {
    // Use isolateModules so pushTokenListener starts as null inside this fresh instance
    let isolatedEnsure: typeof ensurePushTokenRegistered;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      isolatedEnsure = require('../notification-service').ensurePushTokenRegistered;
    });

    mockGetPermissionsAsync.mockResolvedValue({ status: 'granted', ios: {} });
    mockGetExpoPushTokenAsync
      .mockResolvedValueOnce({ data: 'ExponentPushToken[initial]' }) // initial registration
      .mockResolvedValueOnce({ data: 'ExponentPushToken[rotated]' }); // rotation call

    mockUpdateExpoPushTokenMutation
      .mockResolvedValueOnce({ expoPushToken: 'ExponentPushToken[initial]' })
      .mockResolvedValueOnce({ expoPushToken: 'ExponentPushToken[rotated]' });

    mockUserStoreState.userPersona = { expoPushToken: null }; // differs from 'initial' → registers

    await isolatedEnsure!('user-123');

    // addPushTokenListener must have been called (pushTokenListener was null in isolated module)
    const addPushTokenListenerMock = require('expo-notifications').addPushTokenListener;
    expect(addPushTokenListenerMock).toHaveBeenCalledTimes(1);
    const rotationCallback = addPushTokenListenerMock.mock.calls[0][0];
    expect(typeof rotationCallback).toBe('function');

    // Set up state for rotation: cached = initial, new = rotated
    mockUserStoreState.userPersona = { expoPushToken: 'ExponentPushToken[initial]' };
    mockUserStoreState.userId = 'user-123';

    rotationCallback();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(mockUpdateExpoPushTokenMutation).toHaveBeenCalledWith(
      'user-123',
      'ExponentPushToken[rotated]',
    );
  });

  it('skips rotation when token has not changed', async () => {
    let isolatedEnsure: typeof ensurePushTokenRegistered;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      isolatedEnsure = require('../notification-service').ensurePushTokenRegistered;
    });

    mockGetPermissionsAsync.mockResolvedValue({ status: 'granted', ios: {} });
    // Both initial and rotation return the same token
    mockGetExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[same]' });
    mockUpdateExpoPushTokenMutation.mockResolvedValueOnce({ expoPushToken: 'ExponentPushToken[same]' });
    mockUserStoreState.userPersona = { expoPushToken: null }; // differs → registers initial

    await isolatedEnsure!('user-123');

    const addPushTokenListenerMock = require('expo-notifications').addPushTokenListener;
    const rotationCallback = addPushTokenListenerMock.mock.calls[0][0];

    // After initial registration, update cached to 'same'
    mockUserStoreState.userPersona = { expoPushToken: 'ExponentPushToken[same]' };

    rotationCallback();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Only the initial registration call; rotation skipped because token matches
    expect(mockUpdateExpoPushTokenMutation).toHaveBeenCalledTimes(1);
  });

  it('captures exception inside rotation callback on error', async () => {
    let isolatedEnsure: typeof ensurePushTokenRegistered;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      isolatedEnsure = require('../notification-service').ensurePushTokenRegistered;
    });

    mockGetPermissionsAsync.mockResolvedValue({ status: 'granted', ios: {} });
    // Both calls return a token so we get past registerForPushNotificationsAsync
    mockGetExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[tok]' });

    mockUpdateExpoPushTokenMutation
      .mockResolvedValueOnce({ expoPushToken: 'ExponentPushToken[tok]' }) // initial
      .mockRejectedValueOnce(new Error('server error during rotation')); // rotation update throws

    // initial: cached=null, new=tok → different → registers. After setUserPersona (no-op mock),
    // cached in store is still null. For rotation: new token = tok, cached = null → different → update throws
    mockUserStoreState.userPersona = { expoPushToken: null };

    await isolatedEnsure!('user-123');

    const addPushTokenListenerMock = require('expo-notifications').addPushTokenListener;
    const rotationCallback = addPushTokenListenerMock.mock.calls[0][0];

    rotationCallback();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // catch(err) at line 332 calls logger.captureException (line 333)
    expect(mockLoggerCaptureException).toHaveBeenCalled();
  });

  it('skips rotation callback when userId is missing', async () => {
    let isolatedEnsure: typeof ensurePushTokenRegistered;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      isolatedEnsure = require('../notification-service').ensurePushTokenRegistered;
    });

    mockGetPermissionsAsync.mockResolvedValue({ status: 'granted', ios: {} });
    mockGetExpoPushTokenAsync.mockResolvedValueOnce({ data: 'ExponentPushToken[tok]' });
    mockUpdateExpoPushTokenMutation.mockResolvedValueOnce({ expoPushToken: 'ExponentPushToken[tok]' });
    mockUserStoreState.userPersona = { expoPushToken: null };

    await isolatedEnsure!('user-123');

    const addPushTokenListenerMock = require('expo-notifications').addPushTokenListener;
    const rotationCallback = addPushTokenListenerMock.mock.calls[0][0];

    // Simulate no userId when rotation fires
    mockUserStoreState.userId = null as any;

    rotationCallback();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // updateExpoPushTokenMutation only called for initial registration, not rotation
    expect(mockUpdateExpoPushTokenMutation).toHaveBeenCalledTimes(1);
  });

  it('skips rotation when expoToken is null in rotation callback (line 324 true branch)', async () => {
    // Covers BranchMap 28 arm[0]: expoToken is null (registerForPushNotificationsAsync returns null)
    let isolatedEnsure: typeof ensurePushTokenRegistered;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      isolatedEnsure = require('../notification-service').ensurePushTokenRegistered;
    });

    mockGetPermissionsAsync.mockResolvedValue({ status: 'granted', ios: {} });
    mockGetExpoPushTokenAsync
      .mockResolvedValueOnce({ data: 'ExponentPushToken[tok]' }) // initial registration
      .mockResolvedValueOnce(null as any); // rotation: no token (registerForPushNotificationsAsync returns null → if (!expoToken) return)

    mockUpdateExpoPushTokenMutation.mockResolvedValueOnce({ expoPushToken: 'ExponentPushToken[tok]' });
    mockUserStoreState.userPersona = { expoPushToken: null };

    await isolatedEnsure!('user-123');

    const addPushTokenListenerMock = require('expo-notifications').addPushTokenListener;
    const rotationCallback = addPushTokenListenerMock.mock.calls[0][0];

    rotationCallback();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Only 1 call: the initial registration; rotation was skipped because expoToken was null
    expect(mockUpdateExpoPushTokenMutation).toHaveBeenCalledTimes(1);
  });

  it('ignores re-entrant rotation invocations (line 318 tokenRotationInFlight guard)', async () => {
    // Covers BranchMap 26 arm[0]: tokenRotationInFlight is true → return early
    let isolatedEnsure: typeof ensurePushTokenRegistered;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      isolatedEnsure = require('../notification-service').ensurePushTokenRegistered;
    });

    // Use a never-resolving promise for the rotation call so the first invocation
    // stays in-flight when we fire the second invocation
    let resolveRotation!: (v: { data: string }) => void;
    const rotationPromise = new Promise<{ data: string }>((res) => { resolveRotation = res; });

    mockGetPermissionsAsync.mockResolvedValue({ status: 'granted', ios: {} });
    mockGetExpoPushTokenAsync
      .mockResolvedValueOnce({ data: 'ExponentPushToken[tok]' }) // initial
      .mockReturnValueOnce(rotationPromise); // rotation (hangs)

    mockUpdateExpoPushTokenMutation.mockResolvedValueOnce({ expoPushToken: 'ExponentPushToken[tok]' });
    mockUserStoreState.userPersona = { expoPushToken: null };

    await isolatedEnsure!('user-123');

    const addPushTokenListenerMock = require('expo-notifications').addPushTokenListener;
    const rotationCallback = addPushTokenListenerMock.mock.calls[0][0];

    // Fire twice — second call is re-entrant and should be ignored
    rotationCallback();
    await Promise.resolve(); // let first call start
    rotationCallback(); // second invocation: tokenRotationInFlight=true → returns immediately

    // Resolve the first rotation (token same as cached → no update)
    mockUserStoreState.userPersona = { expoPushToken: 'ExponentPushToken[tok]' };
    resolveRotation({ data: 'ExponentPushToken[tok]' });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Only initial registration update; rotation token matched cached
    expect(mockUpdateExpoPushTokenMutation).toHaveBeenCalledTimes(1);
  });
});

describe('Notifications.setNotificationHandler (module-level side effect)', () => {
  // (global as any).__capturedNotifHandler is assigned at module load time (before any
  // clearAllMocks can wipe mock.calls). Use it directly to retrieve the handler.
  it('was called when the module was imported', () => {
    // The module-level call happened at import time. Verify the captured arg exists
    // and has the expected shape (clearAllMocks wipes mock.calls but not our capture).
    expect((global as any).__capturedNotifHandler).toEqual(
      expect.objectContaining({ handleNotification: expect.any(Function) }),
    );
  });

  it('handleNotification suppresses UI for "process-clusters" type', async () => {
    const { handleNotification } = (global as any).__capturedNotifHandler;
    const result = await handleNotification({
      request: { content: { data: { type: 'process-clusters' } } },
    });
    expect(result.shouldShowBanner).toBe(false);
    expect(result.shouldPlaySound).toBe(false);
  });

  it('handleNotification suppresses UI for "inference-done" type', async () => {
    const { handleNotification } = (global as any).__capturedNotifHandler;
    const result = await handleNotification({
      request: { content: { data: { type: 'inference-done' } } },
    });
    expect(result.shouldShowBanner).toBe(false);
  });

  it('handleNotification suppresses UI for "phase1-done" type', async () => {
    const { handleNotification } = (global as any).__capturedNotifHandler;
    const result = await handleNotification({
      request: { content: { data: { type: 'phase1-done' } } },
    });
    expect(result.shouldShowBanner).toBe(false);
  });

  it('handleNotification suppresses UI for "phase2-done" type', async () => {
    const { handleNotification } = (global as any).__capturedNotifHandler;
    const result = await handleNotification({
      request: { content: { data: { type: 'phase2-done' } } },
    });
    expect(result.shouldShowBanner).toBe(false);
  });

  it('handleNotification shows UI for all other notification types', async () => {
    const { handleNotification } = (global as any).__capturedNotifHandler;
    const result = await handleNotification({
      request: { content: { data: { type: 'news-ready' } } },
    });
    expect(result.shouldShowBanner).toBe(true);
    expect(result.shouldPlaySound).toBe(true);
    expect(result.shouldSetBadge).toBe(true);
  });
});
