// The restart authority's gate chain, the marker round trip, and the two
// properties that are easy to get wrong and impossible to see fail on a device:
// the marker write is AWAITED before the reload, and the 10-second floor
// survives the reload (module state does not).

const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn((..._a: any[]) => Promise.resolve());
const mockDeleteSetting = jest.fn((..._a: any[]) => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (...a: any[]) => mockGetSetting(...a),
  setSetting: (...a: any[]) => mockSetSetting(...a),
  deleteSetting: (...a: any[]) => mockDeleteSetting(...a),
}));

const mockFlushPersist = jest.fn();
jest.mock('@/lib/stores/feed-order-store', () => ({
  useFeedOrderStore: { getState: () => ({ flushPersist: mockFlushPersist }) },
}));

const mockReloadAsync = jest.fn((..._a: any[]) => Promise.resolve());
let mockUpdatesEnabled = true;
jest.mock('expo-updates', () => ({
  get isEnabled() {
    return mockUpdatesEnabled;
  },
  reloadAsync: (...a: any[]) => mockReloadAsync(...a),
}));

// Built INSIDE the factory, not captured from a const above it. `logger` is a
// STATIC import in app-restart.ts, so its factory runs while this file's own
// top-level consts are still uninitialised — a captured one arrives undefined
// and every assertion fails on `logger` rather than on the behaviour.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    addBreadcrumb: jest.fn(),
    captureException: jest.fn(),
  },
}));

// blockedBy() now reads the live route through nav-state's module mirror.
let mockPathname = '/logged-in/app_container/feed';
jest.mock('@/lib/nav-state', () => ({
  getCurrentPathname: () => mockPathname,
}));

const mockAddEventListener = jest.fn((..._a: any[]) => ({ remove: jest.fn() }));
const mockAppState: { currentState: string } = { currentState: 'active' };
jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (...a: any[]) => (mockAddEventListener as any)(...a),
    get currentState() {
      return mockAppState.currentState;
    },
  },
}));

import {
  MIN_RESTART_INTERVAL_MS,
  OTA_RESTART_GUARD_KEY,
  RESTART_BLOCKED_ROUTES,
  RESTART_MARKER_KEY,
  __resetAppRestartForTests,
  activeHolds,
  holdRestart,
  initRestartContext,
  requestRestart,
  restartContext,
  isRestartBlockedRoute,
  markOtaRestartAttempted,
  otaRestartAlreadyAttempted,
  restartIsAvailable,
  restartWouldReload,
  wasJsRestartSync,
} from '../app-restart';
import loggerDefault from '@/lib/logger';

const mockLogger = loggerDefault as unknown as {
  info: jest.Mock;
  debug: jest.Mock;
  addBreadcrumb: jest.Mock;
  captureException: jest.Mock;
};

const NOW = 1_700_000_000_000;

/** Production shape: `__DEV__` is false and updates are enabled. jest.config
 *  pins `__DEV__: true` globally, which alone makes every restart inert. */
const asProductionBuild = () => {
  (globalThis as any).__DEV__ = false;
  mockUpdatesEnabled = true;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  __resetAppRestartForTests();
  mockGetSetting.mockResolvedValue(null);
  mockSetSetting.mockResolvedValue(undefined);
  mockDeleteSetting.mockResolvedValue(undefined);
  mockReloadAsync.mockResolvedValue(undefined);
  mockAppState.currentState = 'active';
  mockPathname = '/logged-in/app_container/feed';
  delete process.env.EXPO_PUBLIC_RESTART_DEBUG;
  (globalThis as any).__DEV__ = true;
  mockUpdatesEnabled = true;
});

afterEach(() => {
  jest.useRealTimers();
  (globalThis as any).__DEV__ = true;
});

describe('restartContext', () => {
  it('reports a cold start when no marker row exists', async () => {
    const ctx = await restartContext();
    expect(ctx).toEqual({
      wasJsRestart: false,
      backgroundedAt: null,
      lastForegroundAt: null,
    });
    expect(mockDeleteSetting).not.toHaveBeenCalled();
  });

  it('reads the marker, deletes it, and carries both stamps', async () => {
    mockGetSetting.mockResolvedValue(
      JSON.stringify({
        reason: 'foreground',
        at: NOW - 1_000,
        backgroundedAt: NOW - 4_000,
        lastForegroundAt: NOW - 90_000,
      }),
    );

    const ctx = await restartContext();

    expect(mockGetSetting).toHaveBeenCalledWith(RESTART_MARKER_KEY);
    expect(mockDeleteSetting).toHaveBeenCalledWith(RESTART_MARKER_KEY);
    expect(ctx).toEqual({
      wasJsRestart: true,
      backgroundedAt: NOW - 4_000,
      lastForegroundAt: NOW - 90_000,
    });
  });

  it('is memoised: many callers, one read', async () => {
    mockGetSetting.mockResolvedValue(
      JSON.stringify({ reason: 'ota', at: NOW, backgroundedAt: null, lastForegroundAt: null }),
    );

    const [a, b, c] = await Promise.all([
      restartContext(),
      initRestartContext(),
      restartContext(),
    ]);

    expect(mockGetSetting).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('falls back to a cold start on an unreadable marker and reports it', async () => {
    mockGetSetting.mockResolvedValue('{ not json');

    const ctx = await restartContext();

    expect(ctx.wasJsRestart).toBe(false);
    expect(mockLogger.captureException).toHaveBeenCalled();
  });

  it('tolerates a marker missing its stamps', async () => {
    mockGetSetting.mockResolvedValue(JSON.stringify({ reason: 'restore' }));

    const ctx = await restartContext();

    expect(ctx).toEqual({
      wasJsRestart: true,
      backgroundedAt: null,
      lastForegroundAt: null,
    });
  });

  it('installs the departure listener once', async () => {
    await restartContext();
    await restartContext();
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockAddEventListener.mock.calls[0][0]).toBe('change');
  });
});

describe('wasJsRestartSync', () => {
  it('is false before the context resolves and true after a restart boot', async () => {
    mockGetSetting.mockResolvedValue(
      JSON.stringify({ reason: 'ota', at: NOW, backgroundedAt: null, lastForegroundAt: null }),
    );

    expect(wasJsRestartSync()).toBe(false);
    await initRestartContext();
    expect(wasJsRestartSync()).toBe(true);
  });

  it('stays false on a real cold start', async () => {
    await initRestartContext();
    expect(wasJsRestartSync()).toBe(false);
  });
});

describe('holdRestart', () => {
  it('releases idempotently and does not disturb a second hold sharing the label', () => {
    const releaseA = holdRestart('purchase');
    const releaseB = holdRestart('purchase');
    expect(activeHolds()).toEqual(['purchase', 'purchase']);

    releaseA();
    releaseA();
    expect(activeHolds()).toEqual(['purchase']);

    releaseB();
    expect(activeHolds()).toEqual([]);
  });
});

describe('requestRestart', () => {
  it('reloads, flushing the feed order and awaiting the marker write first', async () => {
    asProductionBuild();
    const order: string[] = [];
    mockFlushPersist.mockImplementation(() => order.push('flush'));
    mockSetSetting.mockImplementation(() => {
      order.push('marker');
      return Promise.resolve();
    });
    mockReloadAsync.mockImplementation(() => {
      order.push('reload');
      return Promise.resolve();
    });

    await requestRestart('ota');

    expect(order).toEqual(['flush', 'marker', 'reload']);
    const [key, value] = mockSetSetting.mock.calls[0];
    expect(key).toBe(RESTART_MARKER_KEY);
    expect(JSON.parse(value as string)).toMatchObject({ reason: 'ota', at: NOW });
  });

  it('carries the background stamp recorded by the departure listener', async () => {
    asProductionBuild();
    await initRestartContext();
    const handler = mockAddEventListener.mock.calls[0][1] as unknown as (s: string) => void;

    handler('background');
    jest.setSystemTime(NOW + 3_000);
    handler('active');

    await requestRestart('ota');

    const payload = JSON.parse(mockSetSetting.mock.calls[0][1] as string);
    expect(payload.backgroundedAt).toBe(NOW);
    expect(payload.lastForegroundAt).toBe(NOW + 3_000);
  });

  it('ignores `inactive`, so the app switcher never counts as a departure', async () => {
    asProductionBuild();
    await initRestartContext();
    const handler = mockAddEventListener.mock.calls[0][1] as unknown as (s: string) => void;

    handler('inactive');
    await requestRestart('ota');

    const payload = JSON.parse(mockSetSetting.mock.calls[0][1] as string);
    expect(payload.backgroundedAt).toBeNull();
  });

  it('does nothing in a dev build', async () => {
    (globalThis as any).__DEV__ = true;
    await requestRestart('ota');
    expect(mockReloadAsync).not.toHaveBeenCalled();
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('does nothing when updates are disabled', async () => {
    asProductionBuild();
    mockUpdatesEnabled = false;
    await requestRestart('ota');
    expect(mockReloadAsync).not.toHaveBeenCalled();
  });

  it('does nothing unless the app is active', async () => {
    asProductionBuild();
    mockAppState.currentState = 'background';
    await requestRestart('ota');
    expect(mockReloadAsync).not.toHaveBeenCalled();
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('bails while a hold is live and does not retry when the hold releases', async () => {
    asProductionBuild();
    const release = holdRestart('purchase');

    await requestRestart('ota');
    expect(mockReloadAsync).not.toHaveBeenCalled();

    release();
    // Releasing is not a trigger. Nothing may fire without a fresh request.
    await Promise.resolve();
    expect(mockReloadAsync).not.toHaveBeenCalled();
  });

  it('latches after a successful reload, whatever the clock says', async () => {
    // `reloadAsync()` can resolve before the JS context is torn down, so the
    // latch is deliberately never released on success: this process is going
    // away and nothing in it may start a second reload.
    asProductionBuild();
    await requestRestart('ota');
    expect(mockReloadAsync).toHaveBeenCalledTimes(1);

    jest.setSystemTime(NOW + MIN_RESTART_INTERVAL_MS + 1);
    await requestRestart('ota');
    expect(mockReloadAsync).toHaveBeenCalledTimes(1);
  });

  it('enforces the interval ACROSS a reload, seeded from the marker', async () => {
    // The loop this closes: module state dies with the reload, so without the
    // marker's own stamp a restart-on-boot path is bounded by nothing.
    asProductionBuild();
    mockGetSetting.mockResolvedValue(
      JSON.stringify({
        reason: 'ota',
        at: NOW - 2_000,
        backgroundedAt: null,
        lastForegroundAt: null,
      }),
    );
    await initRestartContext();

    await requestRestart('ota');
    expect(mockReloadAsync).not.toHaveBeenCalled();

    jest.setSystemTime(NOW + MIN_RESTART_INTERVAL_MS);
    await requestRestart('ota');
    expect(mockReloadAsync).toHaveBeenCalledTimes(1);
  });

  it('clears the marker and reports when the reload throws', async () => {
    asProductionBuild();
    mockReloadAsync.mockRejectedValue(new Error('reload failed'));

    await requestRestart('restore');

    expect(mockDeleteSetting).toHaveBeenCalledWith(RESTART_MARKER_KEY);
    expect(mockLogger.captureException).toHaveBeenCalled();

    // The latch is released, so a later attempt is possible.
    jest.setSystemTime(NOW + MIN_RESTART_INTERVAL_MS + 1);
    mockReloadAsync.mockResolvedValue(undefined);
    await requestRestart('restore');
    expect(mockReloadAsync).toHaveBeenCalledTimes(2);
  });

  it('survives a failed flush and still restarts', async () => {
    asProductionBuild();
    mockFlushPersist.mockImplementation(() => {
      throw new Error('flush failed');
    });

    await requestRestart('ota');

    expect(mockLogger.captureException).toHaveBeenCalled();
    expect(mockReloadAsync).toHaveBeenCalledTimes(1);
  });
});

describe('EXPO_PUBLIC_RESTART_DEBUG', () => {
  it('logs the verdict instead of reloading, even on a production build', async () => {
    asProductionBuild();
    process.env.EXPO_PUBLIC_RESTART_DEBUG = 'true';

    await requestRestart('ota');

    expect(mockReloadAsync).not.toHaveBeenCalled();
    expect(mockSetSetting).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[app-restart] would restart (ota, blocked-by: none)',
    );
  });

  it('names the blocker, which is the only way the sim can tell blocked from silent', async () => {
    process.env.EXPO_PUBLIC_RESTART_DEBUG = 'true';
    holdRestart('purchase');

    await requestRestart('ota');

    expect(mockLogger.info).toHaveBeenCalledWith(
      '[app-restart] would restart (ota, blocked-by: hold:purchase)',
    );
  });

  it('runs in a dev build, where the feature is otherwise inert', async () => {
    (globalThis as any).__DEV__ = true;
    mockUpdatesEnabled = false;
    process.env.EXPO_PUBLIC_RESTART_DEBUG = 'true';

    await requestRestart('language');

    expect(mockLogger.info).toHaveBeenCalledWith(
      '[app-restart] would restart (language, blocked-by: none)',
    );
  });
});

describe('route blocking', () => {
  // THE LIST LIVES IN THE AUTHORITY so every reason is covered. It used to be
  // checked by the foreground restart alone, which left `requestRestart('ota')`
  // route-blind: a user returning from their mail app to /verify-otp had the
  // foreground restart skipped and was then restarted by the OTA check on the
  // same transition, wiping the code that return delivered.
  it('blocks exactly these five routes, no more and no fewer', () => {
    expect([...RESTART_BLOCKED_ROUTES]).toEqual([
      '/login',
      '/verify-otp',
      '/pin-setup',
      '/pin-lock',
      '/logged-in/onboarding',
    ]);
    expect(RESTART_BLOCKED_ROUTES).toHaveLength(5);
  });

  it('isRestartBlockedRoute matches on prefix and nothing else', () => {
    expect(isRestartBlockedRoute('/verify-otp?email=x')).toBe(true);
    expect(isRestartBlockedRoute('/logged-in/onboarding/step-2')).toBe(true);
    expect(isRestartBlockedRoute('/logged-in/app_container/feed')).toBe(false);
    expect(isRestartBlockedRoute('/logged-in/notifications')).toBe(false);
  });

  it.each([...RESTART_BLOCKED_ROUTES])('refuses an OTA restart on %s', async (route) => {
    asProductionBuild();
    mockPathname = route;

    await requestRestart('ota');

    expect(mockReloadAsync).not.toHaveBeenCalled();
  });

  it.each(['language', 'restore'] as const)('refuses a %s restart on a blocked route', async (reason) => {
    asProductionBuild();
    mockPathname = '/pin-lock';

    await requestRestart(reason);

    expect(mockReloadAsync).not.toHaveBeenCalled();
  });

  it('names the route as the blocker, so the sim log says which one', async () => {
    process.env.EXPO_PUBLIC_RESTART_DEBUG = 'true';
    mockPathname = '/verify-otp';

    await requestRestart('ota');

    expect(mockLogger.info).toHaveBeenCalledWith(
      '[app-restart] would restart (ota, blocked-by: route:/verify-otp)',
    );
  });

  it('restarts on an ordinary route', async () => {
    asProductionBuild();
    mockPathname = '/logged-in/app_container/feed';

    await requestRestart('ota');

    expect(mockReloadAsync).toHaveBeenCalledTimes(1);
  });

  it('does not block when the route cannot be read', async () => {
    // A language change or a restore is a restart the user asked for; an
    // unreadable route must not swallow it.
    asProductionBuild();
    const navState = jest.requireMock('@/lib/nav-state') as { getCurrentPathname: () => string };
    const spy = jest
      .spyOn(navState, 'getCurrentPathname')
      .mockImplementation(() => {
        throw new Error('no router yet');
      });

    await requestRestart('language');

    expect(mockReloadAsync).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('the per-update-id OTA restart guard', () => {
  // The OTA check is the only restart trigger left and it runs on every return,
  // so a bundle that downloads, reloads and fails to launch would restart on
  // every return. MIN_RESTART_INTERVAL_MS spaces that cycle; this bounds it.
  it('is a settings row keyed on the update id', async () => {
    await markOtaRestartAttempted('update-abc');
    expect(mockSetSetting).toHaveBeenCalledWith(OTA_RESTART_GUARD_KEY, 'update-abc');
  });

  it('reports an id it has already seen, and only that id', async () => {
    mockGetSetting.mockResolvedValue('update-abc');
    await expect(otaRestartAlreadyAttempted('update-abc')).resolves.toBe(true);
    await expect(otaRestartAlreadyAttempted('update-def')).resolves.toBe(false);
  });

  it('reports false when nothing has been attempted', async () => {
    mockGetSetting.mockResolvedValue(null);
    await expect(otaRestartAlreadyAttempted('update-abc')).resolves.toBe(false);
  });

  // Fails to "already attempted": an unreadable guard must not license an
  // unbounded reload loop. The update still launches at the next cold start.
  it('fails CLOSED on an unreadable guard', async () => {
    mockGetSetting.mockRejectedValue(new Error('db gone'));
    await expect(otaRestartAlreadyAttempted('update-abc')).resolves.toBe(true);
    expect(mockLogger.captureException).toHaveBeenCalled();
  });

  // It must NOT ride on the restart marker, which is deleted on first read: the
  // boot that proves a bundle failed to launch would erase its own guard.
  it('is a different row from the restart marker', () => {
    expect(OTA_RESTART_GUARD_KEY).not.toBe(RESTART_MARKER_KEY);
  });

  it('survives reading the marker, which deletes only the marker', async () => {
    mockGetSetting.mockImplementation((key: string) =>
      Promise.resolve(
        key === RESTART_MARKER_KEY
          ? JSON.stringify({ reason: 'ota', at: NOW, backgroundedAt: null, lastForegroundAt: null })
          : 'update-abc',
      ),
    );

    await restartContext();

    expect(mockDeleteSetting).toHaveBeenCalledWith(RESTART_MARKER_KEY);
    expect(mockDeleteSetting).not.toHaveBeenCalledWith(OTA_RESTART_GUARD_KEY);
    await expect(otaRestartAlreadyAttempted('update-abc')).resolves.toBe(true);
  });
});

describe('restartWouldReload', () => {
  // The OTA path spends one attempt per bundle and must only spend it on a
  // request that genuinely reloads. Every non-reloading outcome has to be
  // covered, or the attempt is consumed by something that never reloaded and the
  // bundle is stranded until a cold start.
  it('is true on a production build with nothing in the way', () => {
    asProductionBuild();
    expect(restartWouldReload()).toBe(true);
  });

  it('is false while a hold is live', () => {
    asProductionBuild();
    holdRestart('purchase');
    expect(restartWouldReload()).toBe(false);
  });

  it('is false on a blocked route', () => {
    asProductionBuild();
    mockPathname = '/verify-otp';
    expect(restartWouldReload()).toBe(false);
  });

  it('is false when the app is not active', () => {
    asProductionBuild();
    mockAppState.currentState = 'background';
    expect(restartWouldReload()).toBe(false);
  });

  it('is false inside the cooldown', async () => {
    asProductionBuild();
    await requestRestart('ota');
    jest.setSystemTime(NOW + MIN_RESTART_INTERVAL_MS - 1);
    expect(restartWouldReload()).toBe(false);
  });

  // An inert build eating the attempt is the same bug in different clothes.
  it('is false in a dev build and when updates are disabled', () => {
    (globalThis as any).__DEV__ = true;
    expect(restartWouldReload()).toBe(false);

    (globalThis as any).__DEV__ = false;
    mockUpdatesEnabled = false;
    expect(restartWouldReload()).toBe(false);
  });

  // Otherwise a simulator pass sees the decision once and then silently never
  // again, because the first run consumed the only attempt.
  it('is false under EXPO_PUBLIC_RESTART_DEBUG', () => {
    asProductionBuild();
    process.env.EXPO_PUBLIC_RESTART_DEBUG = 'true';
    expect(restartWouldReload()).toBe(false);
  });

  // It must agree with the gate it predicts. A second copy of that ladder is how
  // the two drift apart, so this pins them to the same answer.
  it('agrees with requestRestart on every blocker', async () => {
    asProductionBuild();
    for (const setUp of [
      () => { mockAppState.currentState = 'inactive'; },
      () => { holdRestart('chat-stream'); },
      () => { mockPathname = '/pin-lock'; },
    ]) {
      __resetAppRestartForTests();
      jest.clearAllMocks();
      mockAppState.currentState = 'active';
      mockPathname = '/logged-in/app_container/feed';
      setUp();

      const predicted = restartWouldReload();
      await requestRestart('ota');

      expect(predicted).toBe(false);
      expect(mockReloadAsync).not.toHaveBeenCalled();
    }
  });
});

describe('restartIsAvailable', () => {
  it('is false in a dev build and false when updates are disabled', () => {
    (globalThis as any).__DEV__ = true;
    expect(restartIsAvailable()).toBe(false);

    (globalThis as any).__DEV__ = false;
    mockUpdatesEnabled = false;
    expect(restartIsAvailable()).toBe(false);
  });

  it('is true on a production build with updates enabled', () => {
    asProductionBuild();
    expect(restartIsAvailable()).toBe(true);
  });
});
