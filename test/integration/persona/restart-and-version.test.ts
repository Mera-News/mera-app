// The restart authority (holds, gates, marker, OTA guard), the silent OTA updater's restart decisions, and
// the version floor. Real app-restart, nav-state, AppState (the drivable one), settings rows in the in-memory
// DB and the real Apollo client over MSW. Mocked: expo-updates only, an edge.
import Constants from 'expo-constants';
import { renderHook, waitFor } from '@testing-library/react-native';
import { useNativeUpdateGate } from '@/components/custom/useNativeUpdateGate';
import OTASilentUpdater from '@/components/custom/OTASilentUpdater';
import { AppVersionService } from '@/lib/app-version-service';
import {
    __resetAppRestartForTests,
    activeHolds,
    autoReloadDisabled,
    disableAutoReload,
    holdAutoRestart,
    holdRestart,
    initRestartContext,
    isRestartBlockedRoute,
    markOtaRestartAttempted,
    MIN_RESTART_INTERVAL_MS,
    OTA_RESTART_GUARD_KEY,
    otaRestartAlreadyAttempted,
    requestRestart,
    restartContext,
    restartIsAvailable,
    restartWouldReload,
    RESTART_BLOCKED_ROUTES,
    RESTART_MARKER_KEY,
    takeRestoreSpot,
    wasJsRestartSync,
} from '@/lib/app-restart';
import { BACKGROUND_LOCK_THRESHOLD_MS, usePinStore } from '@/lib/stores/pin-store';
import database from '@/lib/database';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import * as feedOrderStore from '@/lib/stores/feed-order-store';
import * as settingService from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { setCurrentPathname } from '@/lib/nav-state';
import { getAppVersion, getAppVersionLabel, getGitCommit } from '@/lib/version';
import { initI18nEn, mockGql, mockGqlError, server, setAppState, useFakeClock } from '@/test/helpers';
import { getAll, markActioned, notify } from '@/lib/database/services/notification-service';
import { tapNotification } from '@/components/custom/notifications/notification-actions';
import { toastManager } from '@/lib/toast-manager';
import {
    __resetOtaNoticeForTests,
    announceAppliedUpdate,
    APP_UPDATED,
    noticePendingUpdate,
    OTA_LAST_RUNNING_KEY,
    OTA_NOTICED_KEY,
    restartForUpdate,
    UPDATE_AVAILABLE,
    useOpenUpdateNotes,
} from '@/lib/ota-notice';

/** What `captureSpot()` returns: the reader's place, or null when it cannot be rebuilt. */
const SPOT = { v: 1, tab: 'feed', page: 'for-you' };
let mockSpot: unknown = SPOT;
// Virtual until the feed module lands; the real one reads navigation state.
jest.mock('@/lib/navigation/resume-spot', () => ({ captureSpot: () => mockSpot }), { virtual: true });

/** A decided PIN gate with the lock off: the production state of most readers. */
const pinGateOpen = () =>
    usePinStore.setState({ initialized: true, unresolved: false, locked: false, pinSet: false, lockEnabled: false });

let mockUpdatesEnabled = true;
const mockReloadAsync = jest.fn(async () => {});
const mockCheckForUpdate = jest.fn(async () => ({ isAvailable: false }));
const mockFetchUpdate = jest.fn(async () => ({ isNew: false }));
let mockLatestContext: Record<string, unknown> = {};
let mockUpdateId: string | null = null;
let mockCreatedAt: Date | null = null;
let mockEmbeddedLaunch = false;
jest.mock('expo-updates', () => ({
    get isEnabled() {
        return mockUpdatesEnabled;
    },
    get updateId() {
        return mockUpdateId;
    },
    get createdAt() {
        return mockCreatedAt;
    },
    get isEmbeddedLaunch() {
        return mockEmbeddedLaunch;
    },
    get latestContext() {
        return mockLatestContext;
    },
    reloadAsync: () => mockReloadAsync(),
    checkForUpdateAsync: () => mockCheckForUpdate(),
    fetchUpdateAsync: () => mockFetchUpdate(),
}));

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const FEED = '/logged-in/app_container/feed';

/** The production shape: `__DEV__` is false and updates are enabled. The jest config pins `__DEV__` true,
 *  which alone makes every restart inert. */
const asProductionBuild = () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    mockUpdatesEnabled = true;
};

/**
 * Lets background work land before the test ends. Settings writes are fired without awaiting, and a write
 * started under the fake clock needs the fake clock to finish: if the clock is restored first, the write never
 * completes and the next test's DB reset waits on it forever. This must run BEFORE the setup's own afterEach
 * (which restores real timers), which is why every test sits inside a describe: a nested afterEach runs first.
 */
async function settleBackgroundWork() {
    if ('clock' in (setTimeout as unknown as object)) await jest.advanceTimersByTimeAsync(200);
    else await new Promise((r) => setTimeout(r, 25));
    await database.write(async () => {});
}

describe('restarts and the version floor', () => {
    beforeEach(() => {
        __resetAppRestartForTests();
        mockUpdatesEnabled = true;
        mockLatestContext = {};
        mockUpdateId = null;
        mockCreatedAt = null;
        mockEmbeddedLaunch = false;
        delete process.env.EXPO_PUBLIC_OTA_NOTES;
        mockCheckForUpdate.mockResolvedValue({ isAvailable: false });
        mockFetchUpdate.mockResolvedValue({ isNew: false });
        setAppState('active');
        setCurrentPathname(FEED);
        delete process.env.EXPO_PUBLIC_RESTART_DEBUG;
        (globalThis as { __DEV__?: boolean }).__DEV__ = true;
        mockSpot = SPOT;
        pinGateOpen();
        __resetOtaNoticeForTests();
    });

    afterEach(async () => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = true;
        delete process.env.EXPO_PUBLIC_RESTART_DEBUG;
        jest.restoreAllMocks();
        setCurrentPathname('');
        await settleBackgroundWork();
    });

    // ---------------------------------------------------------------------------------------------
    describe('restartContext', () => {
        it('reports a cold start when no marker row exists', async () => {
            await expect(restartContext()).resolves.toEqual({ wasJsRestart: false, backgroundedAt: null, lastForegroundAt: null });
        });

        it('reads the marker, deletes it, and carries both stamps', async () => {
            await setSetting(
                RESTART_MARKER_KEY,
                JSON.stringify({ reason: 'ota', at: NOW - 1_000, backgroundedAt: NOW - 4_000, lastForegroundAt: NOW - 90_000 }),
            );

            await expect(restartContext()).resolves.toEqual({
                wasJsRestart: true,
                reason: 'ota',
                spot: null,
                backgroundedAt: NOW - 4_000,
                lastForegroundAt: NOW - 90_000,
            });
            await expect(getSetting(RESTART_MARKER_KEY)).resolves.toBeNull();
        });

        it('is memoised: many callers, one read, and a second boot read finds the marker already gone', async () => {
            await setSetting(RESTART_MARKER_KEY, JSON.stringify({ reason: 'ota', at: NOW, backgroundedAt: null, lastForegroundAt: null }));
            const reads = jest.spyOn(settingService, 'getSetting');

            const [a, b, c] = await Promise.all([restartContext(), initRestartContext(), restartContext()]);

            expect(reads).toHaveBeenCalledTimes(1);
            expect(a).toBe(b);
            expect(b).toBe(c);
        });

        it('falls back to a cold start on an unreadable marker', async () => {
            await setSetting(RESTART_MARKER_KEY, '{ not json');
            const ctx = await restartContext();
            expect(ctx.wasJsRestart).toBe(false);
        });

        it('tolerates a marker missing its stamps', async () => {
            await setSetting(RESTART_MARKER_KEY, JSON.stringify({ reason: 'restore' }));
            await expect(restartContext()).resolves.toEqual({
                wasJsRestart: true,
                reason: 'restore',
                spot: null,
                backgroundedAt: null,
                lastForegroundAt: null,
            });
        });

        it('wasJsRestartSync is false before the context resolves and true after a restart boot', async () => {
            await setSetting(RESTART_MARKER_KEY, JSON.stringify({ reason: 'ota', at: NOW, backgroundedAt: null, lastForegroundAt: null }));
            expect(wasJsRestartSync()).toBe(false);
            await initRestartContext();
            expect(wasJsRestartSync()).toBe(true);
        });

        it('wasJsRestartSync stays false on a real cold start', async () => {
            await initRestartContext();
            expect(wasJsRestartSync()).toBe(false);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('holds', () => {
        it('holdRestart / activeHolds / release: idempotent, and a second hold sharing the label is undisturbed', () => {
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

    // ---------------------------------------------------------------------------------------------
    describe('requestRestart', () => {
        it('reloads: flushes the feed order first and has the marker on disk BEFORE the reload runs', async () => {
            asProductionBuild();
            useFakeClock(NOW, { advanceTimers: true });
            const order: string[] = [];
            const realGetState = feedOrderStore.useFeedOrderStore.getState;
            jest.spyOn(feedOrderStore.useFeedOrderStore, 'getState').mockImplementationOnce(() => ({
                ...realGetState(),
                flushPersist: () => order.push('flush'),
            }));
            let markerAtReload: string | null = null;
            mockReloadAsync.mockImplementationOnce(async () => {
                order.push('reload');
                markerAtReload = await getSetting(RESTART_MARKER_KEY);
            });

            await requestRestart('ota');

            expect(order).toEqual(['flush', 'reload']);
            expect(JSON.parse(markerAtReload as unknown as string)).toMatchObject({ reason: 'ota', at: NOW });
        });

        it('carries the background stamp recorded by the departure listener', async () => {
            asProductionBuild();
            useFakeClock(NOW, { advanceTimers: true });
            await initRestartContext();

            setAppState('background');
            jest.setSystemTime(NOW + 3_000);
            setAppState('active');

            await requestRestart('ota');

            const payload = JSON.parse((await getSetting(RESTART_MARKER_KEY)) as string);
            expect(payload.backgroundedAt).toBe(NOW);
            expect(payload.lastForegroundAt).toBe(NOW + 3_000);
        });

        it('ignores `inactive`, so the app switcher never counts as a departure', async () => {
            asProductionBuild();
            await initRestartContext();

            setAppState('inactive');
            setAppState('active');
            await requestRestart('ota');

            const payload = JSON.parse((await getSetting(RESTART_MARKER_KEY)) as string);
            expect(payload.backgroundedAt).toBeNull();
        });

        it('does nothing in a dev build', async () => {
            await requestRestart('ota');
            expect(mockReloadAsync).not.toHaveBeenCalled();
            await expect(getSetting(RESTART_MARKER_KEY)).resolves.toBeNull();
        });

        it('does nothing when updates are disabled', async () => {
            asProductionBuild();
            mockUpdatesEnabled = false;
            await requestRestart('ota');
            expect(mockReloadAsync).not.toHaveBeenCalled();
        });

        it('is blocked by appstate:background', async () => {
            asProductionBuild();
            setAppState('background');
            await requestRestart('ota');
            expect(mockReloadAsync).not.toHaveBeenCalled();
            await expect(getSetting(RESTART_MARKER_KEY)).resolves.toBeNull();
        });

        it('is blocked by a hold, and releasing the hold does not retry it', async () => {
            asProductionBuild();
            const release = holdRestart('purchase');

            await requestRestart('ota');
            expect(mockReloadAsync).not.toHaveBeenCalled();

            release();
            await new Promise((r) => setTimeout(r, 20));
            expect(mockReloadAsync).not.toHaveBeenCalled();
        });

        it('latches after a successful reload, whatever the clock says', async () => {
            // reloadAsync() can resolve before the JS context is torn down, so nothing in this process may start a second.
            asProductionBuild();
            useFakeClock(NOW, { advanceTimers: true });
            await requestRestart('ota');
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);

            jest.setSystemTime(NOW + MIN_RESTART_INTERVAL_MS + 1);
            await requestRestart('ota');
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('enforces the interval ACROSS a reload, seeded from the marker', async () => {
            asProductionBuild();
            useFakeClock(NOW, { advanceTimers: true });
            await setSetting(RESTART_MARKER_KEY, JSON.stringify({ reason: 'ota', at: NOW - 2_000, backgroundedAt: null, lastForegroundAt: null }));
            await initRestartContext();

            await requestRestart('ota');
            expect(mockReloadAsync).not.toHaveBeenCalled();

            // 10s after the previous restart's own stamp.
            jest.setSystemTime(NOW - 2_000 + MIN_RESTART_INTERVAL_MS);
            await requestRestart('ota');
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('clears the marker when the reload throws, and a later attempt is possible', async () => {
            asProductionBuild();
            useFakeClock(NOW, { advanceTimers: true });
            mockReloadAsync.mockRejectedValueOnce(new Error('reload failed'));

            await requestRestart('restore');
            // The marker described a restart that did not happen; left behind it would make the next cold start read as warm.
            await expect(getSetting(RESTART_MARKER_KEY)).resolves.toBeNull();

            jest.setSystemTime(NOW + MIN_RESTART_INTERVAL_MS + 1);
            await requestRestart('restore');
            expect(mockReloadAsync).toHaveBeenCalledTimes(2);
        });

        it('survives a failed flush and still restarts', async () => {
            asProductionBuild();
            const realGetState = feedOrderStore.useFeedOrderStore.getState;
            jest.spyOn(feedOrderStore.useFeedOrderStore, 'getState').mockImplementationOnce(() => ({
                ...realGetState(),
                flushPersist: () => {
                    throw new Error('flush failed');
                },
            }));

            await requestRestart('ota');

            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        describe('EXPO_PUBLIC_RESTART_DEBUG', () => {
            it('logs the verdict instead of reloading, even on a production build', async () => {
                asProductionBuild();
                process.env.EXPO_PUBLIC_RESTART_DEBUG = 'true';
                const info = jest.spyOn(logger, 'info');

                await requestRestart('ota');

                expect(mockReloadAsync).not.toHaveBeenCalled();
                await expect(getSetting(RESTART_MARKER_KEY)).resolves.toBeNull();
                expect(info).toHaveBeenCalledWith('[app-restart] would restart (ota, blocked-by: none)');
            });

            it('names the blocker, the only way the sim can tell blocked from silent', async () => {
                process.env.EXPO_PUBLIC_RESTART_DEBUG = 'true';
                holdRestart('purchase');
                const info = jest.spyOn(logger, 'info');

                await requestRestart('ota');

                expect(info).toHaveBeenCalledWith('[app-restart] would restart (ota, blocked-by: hold:purchase)');
            });

            it('runs in a dev build with updates disabled, where the feature is otherwise inert', async () => {
                mockUpdatesEnabled = false;
                process.env.EXPO_PUBLIC_RESTART_DEBUG = 'true';
                const info = jest.spyOn(logger, 'info');

                await requestRestart('language');

                expect(info).toHaveBeenCalledWith('[app-restart] would restart (language, blocked-by: none)');
            });
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('route blocking', () => {
        it('blocks exactly these five routes, no more and no fewer', () => {
            expect([...RESTART_BLOCKED_ROUTES]).toEqual(['/login', '/verify-otp', '/pin-setup', '/pin-lock', '/logged-in/onboarding']);
        });

        it('isRestartBlockedRoute matches on prefix and nothing else', () => {
            expect(isRestartBlockedRoute('/verify-otp?email=x')).toBe(true);
            expect(isRestartBlockedRoute('/logged-in/onboarding/step-2')).toBe(true);
            expect(isRestartBlockedRoute(FEED)).toBe(false);
            expect(isRestartBlockedRoute('/logged-in/notifications')).toBe(false);
        });

        // The list lives in the authority so EVERY reason is covered, not whichever one happens to own a list.
        it.each([...RESTART_BLOCKED_ROUTES])('refuses an OTA restart on %s', async (route) => {
            asProductionBuild();
            setCurrentPathname(route);
            await requestRestart('ota');
            expect(mockReloadAsync).not.toHaveBeenCalled();
        });

        it.each(['language', 'restore'] as const)('refuses a %s restart on a blocked route', async (reason) => {
            asProductionBuild();
            setCurrentPathname('/pin-lock');
            await requestRestart(reason);
            expect(mockReloadAsync).not.toHaveBeenCalled();
        });

        it('names the route as the blocker', async () => {
            process.env.EXPO_PUBLIC_RESTART_DEBUG = 'true';
            setCurrentPathname('/verify-otp');
            const info = jest.spyOn(logger, 'info');

            await requestRestart('ota');

            expect(info).toHaveBeenCalledWith('[app-restart] would restart (ota, blocked-by: route:/verify-otp)');
        });

        it('restarts on an ordinary route', async () => {
            asProductionBuild();
            await requestRestart('ota');
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('an unreadable route counts as not blocked: a restart the user asked for is not swallowed', async () => {
            asProductionBuild();
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            jest.spyOn(require('@/lib/nav-state'), 'getCurrentPathname').mockImplementationOnce(() => {
                throw new Error('no router yet');
            });

            await requestRestart('language');

            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('the per-update-id OTA restart guard', () => {
        it('is a settings row keyed on the update id', async () => {
            await markOtaRestartAttempted('update-abc');
            await expect(getSetting(OTA_RESTART_GUARD_KEY)).resolves.toBe('update-abc');
        });

        it('reports an id it has already seen, and only that id', async () => {
            await markOtaRestartAttempted('update-abc');
            await expect(otaRestartAlreadyAttempted('update-abc')).resolves.toBe(true);
            await expect(otaRestartAlreadyAttempted('update-def')).resolves.toBe(false);
        });

        it('reports false when nothing has been attempted', async () => {
            await expect(otaRestartAlreadyAttempted('update-abc')).resolves.toBe(false);
        });

        // Fails to "already attempted": an unreadable guard must not license an unbounded reload loop.
        it('fails CLOSED on an unreadable guard', async () => {
            jest.spyOn(settingService, 'getSetting').mockRejectedValueOnce(new Error('db gone'));
            await expect(otaRestartAlreadyAttempted('update-abc')).resolves.toBe(true);
        });

        it('is a different row from the restart marker, and survives the marker being read and deleted', async () => {
            expect(OTA_RESTART_GUARD_KEY).not.toBe(RESTART_MARKER_KEY);
            await markOtaRestartAttempted('update-abc');
            await setSetting(RESTART_MARKER_KEY, JSON.stringify({ reason: 'ota', at: NOW, backgroundedAt: null, lastForegroundAt: null }));

            await restartContext();

            await expect(getSetting(RESTART_MARKER_KEY)).resolves.toBeNull();
            await expect(otaRestartAlreadyAttempted('update-abc')).resolves.toBe(true);
        });
    });

    describe('restartWouldReload and restartIsAvailable', () => {
        it('is true on a production build with nothing in the way', () => {
            asProductionBuild();
            expect(restartWouldReload('ota')).toBe(true);
        });

        it('is false while a hold is live, on a blocked route, and when the app is not active', () => {
            asProductionBuild();
            const release = holdRestart('purchase');
            expect(restartWouldReload('ota')).toBe(false);
            release();

            setCurrentPathname('/verify-otp');
            expect(restartWouldReload('ota')).toBe(false);
            setCurrentPathname(FEED);

            setAppState('background');
            expect(restartWouldReload('ota')).toBe(false);
        });

        it('is false inside the cooldown', async () => {
            asProductionBuild();
            useFakeClock(NOW, { advanceTimers: true });
            await requestRestart('ota');
            jest.setSystemTime(NOW + MIN_RESTART_INTERVAL_MS - 1);
            expect(restartWouldReload('ota')).toBe(false);
        });

        // An inert build eating the attempt is the same bug in different clothes.
        it('is false in a dev build, when updates are disabled, and under EXPO_PUBLIC_RESTART_DEBUG', () => {
            expect(restartWouldReload('ota')).toBe(false);

            asProductionBuild();
            mockUpdatesEnabled = false;
            expect(restartWouldReload('ota')).toBe(false);

            asProductionBuild();
            process.env.EXPO_PUBLIC_RESTART_DEBUG = 'true';
            expect(restartWouldReload('ota')).toBe(false);
        });

        it('agrees with requestRestart on every blocker', async () => {
            asProductionBuild();
            for (const setUp of [
                () => setAppState('inactive'),
                () => void holdRestart('chat-stream'),
                () => setCurrentPathname('/pin-lock'),
            ]) {
                __resetAppRestartForTests();
                setAppState('active');
                setCurrentPathname(FEED);
                setUp();

                const predicted = restartWouldReload('ota');
                await requestRestart('ota');

                expect(predicted).toBe(false);
                expect(mockReloadAsync).not.toHaveBeenCalled();
            }
        });

        it('restartIsAvailable: false in a dev build and when updates are disabled, true on a production build', () => {
            expect(restartIsAvailable()).toBe(false);
            asProductionBuild();
            mockUpdatesEnabled = false;
            expect(restartIsAvailable()).toBe(false);
            mockUpdatesEnabled = true;
            expect(restartIsAvailable()).toBe(true);
        });
    });

    // ---------------------------------------------------------------------------------------------
    // OTASilentUpdater renders null: it is a lifecycle, so it is driven as a hook.
    describe('the silent OTA updater', () => {
        const pendingUpdate = (id: string | null = 'update-1') => {
            mockCheckForUpdate.mockResolvedValue({ isAvailable: true });
            mockFetchUpdate.mockResolvedValue({ isNew: true });
            mockLatestContext = { isUpdatePending: true, downloadedManifest: id ? { id } : undefined };
        };
        const mount = () => renderHook(() => OTASilentUpdater());
        const flush = () => new Promise((r) => setTimeout(r, 50));
        /** A true departure and return. */
        const returnFromBackground = async () => {
            setAppState('background');
            setAppState('active');
            await flush();
        };

        beforeEach(() => {
            asProductionBuild();
        });

        it('checks and fetches on mount but NEVER restarts there', async () => {
            pendingUpdate();
            mount();
            await flush();
            expect(mockFetchUpdate).toHaveBeenCalledTimes(1);
            expect(mockReloadAsync).not.toHaveBeenCalled();
        });

        it('does nothing at all in a dev build or with updates disabled', async () => {
            pendingUpdate();
            mockUpdatesEnabled = false;
            mount();
            await flush();
            expect(mockCheckForUpdate).not.toHaveBeenCalled();
        });

        it('a return from background with a pending bundle restarts, and the attempt is on disk BEFORE the reload', async () => {
            pendingUpdate('update-1');
            mount();
            await flush();
            let guardAtReload: string | null = null;
            mockReloadAsync.mockImplementationOnce(async () => {
                guardAtReload = await getSetting(OTA_RESTART_GUARD_KEY);
            });

            await returnFromBackground();

            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
            expect(guardAtReload).toBe('update-1');
        });

        it('a return with nothing pending restarts nothing', async () => {
            mount();
            await flush();
            await returnFromBackground();
            expect(mockReloadAsync).not.toHaveBeenCalled();
        });

        it('an `inactive` transition does not arm the return', async () => {
            pendingUpdate();
            mount();
            await flush();
            setAppState('inactive');
            setAppState('active');
            await flush();
            expect(mockReloadAsync).not.toHaveBeenCalled();
        });

        it('at most one restart per update id: a second return for the same bundle does not reload', async () => {
            useFakeClock(NOW, { advanceTimers: true });
            pendingUpdate('update-1');
            mount();
            await jest.advanceTimersByTimeAsync(100);
            await returnFromBackground();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);

            // The next process, past the cooldown: the guard row is what stops it.
            __resetAppRestartForTests();
            jest.setSystemTime(NOW + 2 * MIN_RESTART_INTERVAL_MS);
            await returnFromBackground();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('a new update id gets its own attempt', async () => {
            await markOtaRestartAttempted('update-1');
            pendingUpdate('update-2');
            mount();
            await flush();
            await returnFromBackground();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
            await expect(getSetting(OTA_RESTART_GUARD_KEY)).resolves.toBe('update-2');
        });

        it('a blocked request does not spend the attempt: the next return retries', async () => {
            pendingUpdate('update-1');
            mount();
            await flush();
            const release = holdRestart('chat-stream');

            await returnFromBackground();
            expect(mockReloadAsync).not.toHaveBeenCalled();
            await expect(getSetting(OTA_RESTART_GUARD_KEY)).resolves.toBeNull();

            release();
            await returnFromBackground();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('a pending bundle with no id is left for the next cold start', async () => {
            pendingUpdate(null);
            mount();
            await flush();
            await returnFromBackground();
            expect(mockReloadAsync).not.toHaveBeenCalled();
            await expect(getSetting(OTA_RESTART_GUARD_KEY)).resolves.toBeNull();
        });

        it('on a blocked route a return restarts nothing and consumes nothing', async () => {
            pendingUpdate('update-1');
            mount();
            await flush();
            setCurrentPathname('/verify-otp');
            await returnFromBackground();
            expect(mockReloadAsync).not.toHaveBeenCalled();
            await expect(getSetting(OTA_RESTART_GUARD_KEY)).resolves.toBeNull();
        });

        // Every negative case below runs in the production setup and flips ONE thing for a positive
        // control in the same test: a blocked decision spends nothing, so the next return reloads.
        it('a reload on a return carries the departure spot and reason ota in the marker', async () => {
            pendingUpdate('update-1');
            mount();
            await flush();
            let markerAtReload: string | null = null;
            mockReloadAsync.mockImplementationOnce(async () => {
                markerAtReload = await getSetting(RESTART_MARKER_KEY);
            });
            await returnFromBackground();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
            expect(JSON.parse(markerAtReload as unknown as string)).toMatchObject({ reason: 'ota', spot: SPOT });
        });

        it('a download that completes DURING a return never reloads: it is noticed, and the next return applies it', async () => {
            mount();
            await flush();
            // Not pending before the return; the return's own check downloads it.
            mockCheckForUpdate.mockResolvedValue({ isAvailable: true });
            mockFetchUpdate.mockResolvedValue({ isNew: true, manifest: { id: 'update-1' } } as never);
            await returnFromBackground();
            expect(mockReloadAsync).not.toHaveBeenCalled();
            expect((await getAll()).filter((n) => n.type === 'update_available')).toHaveLength(1);

            await returnFromBackground();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('a place that cannot be rebuilt (null spot) does not reload; a rebuildable one does', async () => {
            pendingUpdate('update-1');
            mount();
            await flush();
            mockSpot = null;
            await returnFromBackground();
            expect(mockReloadAsync).not.toHaveBeenCalled();

            mockSpot = SPOT;
            await returnFromBackground();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('a capture that throws counts as not rebuildable', async () => {
            pendingUpdate('update-1');
            mount();
            await flush();
            jest.spyOn(logger, 'captureException').mockImplementation(() => '');
            const real = jest.requireMock('@/lib/navigation/resume-spot') as { captureSpot: () => unknown };
            const spy = jest.spyOn(real, 'captureSpot').mockImplementation(() => {
                throw new Error('nav not ready');
            });
            await returnFromBackground();
            expect(mockReloadAsync).not.toHaveBeenCalled();

            spy.mockImplementation(() => SPOT);
            await returnFromBackground();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('an auto-only hold (an open sheet) stops the automatic reload until it is released', async () => {
            pendingUpdate('update-1');
            mount();
            await flush();
            const release = holdAutoRestart('overlay:sheet');
            await returnFromBackground();
            expect(mockReloadAsync).not.toHaveBeenCalled();

            release();
            await returnFromBackground();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('after a failed restore no update reloads by itself until a cold start', async () => {
            pendingUpdate('update-1');
            mount();
            await flush();
            disableAutoReload();
            await returnFromBackground();
            expect(mockReloadAsync).not.toHaveBeenCalled();

            // A cold start clears it.
            __resetAppRestartForTests();
            await returnFromBackground();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('a return that could land on the PIN lock does not reload; a short one does', async () => {
            useFakeClock(NOW, { advanceTimers: true });
            usePinStore.setState({ pinSet: true, lockEnabled: true });
            pendingUpdate('update-1');
            mount();
            await jest.advanceTimersByTimeAsync(100);

            // Just under the threshold is inside the margin: the reload's own boot could lock.
            setAppState('background');
            jest.setSystemTime(Date.now() + BACKGROUND_LOCK_THRESHOLD_MS - 10_000);
            setAppState('active');
            await jest.advanceTimersByTimeAsync(100);
            expect(mockReloadAsync).not.toHaveBeenCalled();

            setAppState('background');
            jest.setSystemTime(Date.now() + 3_000);
            setAppState('active');
            await jest.advanceTimersByTimeAsync(100);
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('an undecided PIN gate counts as a possible lock', async () => {
            pendingUpdate('update-1');
            mount();
            await flush();
            usePinStore.setState({ unresolved: true });
            await returnFromBackground();
            expect(mockReloadAsync).not.toHaveBeenCalled();

            usePinStore.setState({ initialized: false, unresolved: false });
            await returnFromBackground();
            expect(mockReloadAsync).not.toHaveBeenCalled();

            pinGateOpen();
            await returnFromBackground();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('a departure writes nothing, and a return with nothing pending reads nothing', async () => {
            mount();
            await flush();
            const write = jest.spyOn(settingService, 'setSetting');
            const read = jest.spyOn(settingService, 'getSetting');
            await returnFromBackground();
            expect(write).not.toHaveBeenCalled();
            expect(read).not.toHaveBeenCalled();
            expect(mockReloadAsync).not.toHaveBeenCalled();
        });
    });

    // ---------------------------------------------------------------------------------------------
    // The notice (lib/ota-notice.ts): a toast plus one inbox row per pending update, one "App updated"
    // row on the first launch of a new update. Driven through the updater's lifecycle and the row tap.
    describe('the OTA notice', () => {
        const toastShow = jest.fn((_opts: unknown) => 'toast-1');
        const pendingUpdate = (id = 'update-1') => {
            mockCheckForUpdate.mockResolvedValue({ isAvailable: true });
            mockFetchUpdate.mockResolvedValue({ isNew: true, manifest: { id } } as never);
            mockLatestContext = { isUpdatePending: true, downloadedManifest: { id } };
        };
        const mount = () => renderHook(() => OTASilentUpdater());
        const flush = () => new Promise((r) => setTimeout(r, 50));
        const returnFromBackground = async () => {
            setAppState('background');
            setAppState('active');
            await flush();
        };
        const rowsOf = async (type: string) => (await getAll()).filter((n) => n.type === type);
        const day = (d: number) => new Date(Date.UTC(2026, 9, d, 9));

        // The toast card's module graph (Reanimated, the toast kit) takes seconds to load the first
        // time; pay it here so the first test's waitFor measures the notice, not the require.
        beforeAll(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('@/components/custom/notifications/NotifiedToast');
        }, 60_000);
        beforeAll(() => initI18nEn());
        beforeEach(() => {
            asProductionBuild();
            __resetOtaNoticeForTests();
            toastManager.setToastInstance({ show: toastShow, close: jest.fn() } as never);
        });
        afterEach(() => toastManager.setToastInstance(null as never));

        it('a fetched update on mount gets one toast and one row per id, and a later mount none', async () => {
            pendingUpdate('update-1');
            mount().unmount();
            await waitFor(() => expect(toastShow).toHaveBeenCalledTimes(1));
            expect(mockReloadAsync).not.toHaveBeenCalled();
            await expect(getSetting(OTA_NOTICED_KEY)).resolves.toBe('update-1');

            mount();
            await flush();
            expect(toastShow).toHaveBeenCalledTimes(1);
            const rows = await rowsOf(UPDATE_AVAILABLE);
            expect(rows).toHaveLength(1);
            expect(JSON.parse(rows[0].actionsJson!)).toEqual([{ id: 'restart-for-update', labelKey: 'notificationCenter.update.restart' }]);
        });

        it('a newer pending update replaces the row and toasts again', async () => {
            pendingUpdate('update-1');
            mount().unmount();
            await waitFor(() => expect(toastShow).toHaveBeenCalledTimes(1));
            pendingUpdate('update-2');
            mount();
            await waitFor(() => expect(toastShow).toHaveBeenCalledTimes(2));
            expect(await rowsOf(UPDATE_AVAILABLE)).toHaveLength(1);
        });

        it('a return that is about to reload shows no toast', async () => {
            mount();
            await flush();
            pendingUpdate('update-1');
            await returnFromBackground();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
            expect(toastShow).not.toHaveBeenCalled();
            expect(await rowsOf(UPDATE_AVAILABLE)).toHaveLength(0);
        });

        it('a return blocked by a hold toasts and writes the row instead', async () => {
            mount();
            await flush();
            pendingUpdate('update-1');
            const release = holdRestart('chat-stream');
            await returnFromBackground();
            expect(mockReloadAsync).not.toHaveBeenCalled();
            expect(toastShow).toHaveBeenCalledTimes(1);
            expect(await rowsOf(UPDATE_AVAILABLE)).toHaveLength(1);
            release();
        });

        it('the first launch of a new update writes ONE app_updated row with every note since the last one, and moves the marker', async () => {
            await setSetting(OTA_LAST_RUNNING_KEY, JSON.stringify({ id: 'update-1', at: day(20).toISOString() }));
            await notify({ type: UPDATE_AVAILABLE, title: 't', body: 'b', source: 'ota' });
            await notify({ type: APP_UPDATED, title: 't', body: 'b', source: 'ota' });
            mockUpdateId = 'update-3';
            mockCreatedAt = day(22);
            // update-2 was skipped; update-1's own note (equal to the marker) is not shown again.
            const notes = [
                { at: day(22).toISOString(), message: 'Three' },
                { at: day(21).toISOString(), message: 'Two' },
                { at: day(20).toISOString(), message: 'One' },
            ];
            process.env.EXPO_PUBLIC_OTA_NOTES = JSON.stringify(notes);

            mount();
            await flush();

            expect(await rowsOf(UPDATE_AVAILABLE)).toHaveLength(0);
            const rows = await rowsOf(APP_UPDATED);
            expect(rows).toHaveLength(1);
            expect(rows[0].status).toBe('unread');
            expect(JSON.parse(rows[0].contextJson!).notes).toEqual(notes.slice(0, 2));
            expect(JSON.parse((await getSetting(OTA_LAST_RUNNING_KEY))!)).toEqual({ id: 'update-3', at: day(22).toISOString() });

            // The same update on the next launch: nothing new.
            mount();
            await flush();
            expect(await rowsOf(APP_UPDATED)).toHaveLength(1);
        });

        it('a first marker (fresh install, a wipe) only records the running update and drops a dead Update ready row', async () => {
            await notify({ type: UPDATE_AVAILABLE, title: 't', body: 'b', source: 'ota' });
            mockUpdateId = 'update-3';
            mockCreatedAt = day(22);
            mount();
            await flush();
            expect(await rowsOf(APP_UPDATED)).toHaveLength(0);
            expect(await rowsOf(UPDATE_AVAILABLE)).toHaveLength(0);
            expect(JSON.parse((await getSetting(OTA_LAST_RUNNING_KEY))!).id).toBe('update-3');
        });

        it('an embedded launch (a store build, a rollback) only records the running update and drops a dead Update ready row', async () => {
            await setSetting(OTA_LAST_RUNNING_KEY, JSON.stringify({ id: 'update-1', at: day(20).toISOString() }));
            await notify({ type: UPDATE_AVAILABLE, title: 't', body: 'b', source: 'ota' });
            mockUpdateId = 'embedded-1';
            mockEmbeddedLaunch = true;
            mount();
            await flush();
            expect(await rowsOf(APP_UPDATED)).toHaveLength(0);
            expect(await rowsOf(UPDATE_AVAILABLE)).toHaveLength(0);
            expect(JSON.parse((await getSetting(OTA_LAST_RUNNING_KEY))!).id).toBe('embedded-1');
        });

        it('a download on the PIN lock writes the row but no toast, and a later return toasts', async () => {
            setCurrentPathname('/pin-lock');
            pendingUpdate('update-1');
            mount();
            await waitFor(async () => expect(await rowsOf(UPDATE_AVAILABLE)).toHaveLength(1));
            expect(toastShow).not.toHaveBeenCalled();
            await expect(getSetting(OTA_NOTICED_KEY)).resolves.toBeNull();

            setCurrentPathname(FEED);
            const release = holdRestart('chat-stream');
            await returnFromBackground();
            expect(toastShow).toHaveBeenCalledTimes(1);
            expect(await rowsOf(UPDATE_AVAILABLE)).toHaveLength(1);
            release();
        });

        it('the inbox holds one update row: an unopened App updated row is replaced, and its notes come back with the next one', async () => {
            await setSetting(OTA_LAST_RUNNING_KEY, JSON.stringify({ id: 'update-1', at: day(20).toISOString() }));
            const notes = [
                { at: day(22).toISOString(), message: 'Three' },
                { at: day(21).toISOString(), message: 'Two' },
            ];
            process.env.EXPO_PUBLIC_OTA_NOTES = JSON.stringify(notes);
            mockUpdateId = 'update-2';
            mockCreatedAt = day(21);
            pendingUpdate('update-3');
            mount().unmount();
            await waitFor(() => expect(toastShow).toHaveBeenCalledTimes(1));
            expect((await getAll()).map((n) => n.type)).toEqual([UPDATE_AVAILABLE]);

            // update-3 launches before anyone opened update-2's row: one row, both notes.
            mockUpdateId = 'update-3';
            mockCreatedAt = day(22);
            mockCheckForUpdate.mockResolvedValue({ isAvailable: false });
            mockLatestContext = {};
            mount();
            await flush();
            const rows = await getAll();
            expect(rows.map((n) => n.type)).toEqual([APP_UPDATED]);
            expect(JSON.parse(rows[0].contextJson!).notes).toEqual(notes);
        });

        it('an App updated row already opened passes nothing on', async () => {
            await setSetting(OTA_LAST_RUNNING_KEY, JSON.stringify({ id: 'update-2', at: day(21).toISOString() }));
            const opened = await notify({ type: APP_UPDATED, title: 't', body: 'b', source: 'ota', context: { notes: [], since: day(20).toISOString() } });
            await markActioned(opened!.id);
            process.env.EXPO_PUBLIC_OTA_NOTES = JSON.stringify([
                { at: day(22).toISOString(), message: 'Three' },
                { at: day(21).toISOString(), message: 'Two' },
            ]);
            mockUpdateId = 'update-3';
            mockCreatedAt = day(22);
            mount();
            await flush();
            const rows = await getAll();
            expect(rows).toHaveLength(1);
            expect(JSON.parse(rows[0].contextJson!).notes.map((n: { message: string }) => n.message)).toEqual(['Three']);
        });

        it("the row's Restart honours a hold: no reload, and the row stays", async () => {
            pendingUpdate('update-1');
            mount();
            await waitFor(async () => expect(await rowsOf(UPDATE_AVAILABLE)).toHaveLength(1));
            const release = holdRestart('chat-stream');

            await tapNotification((await rowsOf(UPDATE_AVAILABLE))[0]);

            expect(mockReloadAsync).not.toHaveBeenCalled();
            await expect(getSetting(OTA_RESTART_GUARD_KEY)).resolves.toBeNull();
            expect(await rowsOf(UPDATE_AVAILABLE)).toHaveLength(1);
            release();
        });

        it('Restart reloads with no departure stamp (a tap must not PIN-lock) and spends the attempt first', async () => {
            useFakeClock(NOW, { advanceTimers: true });
            await initRestartContext();
            setAppState('background');
            jest.setSystemTime(NOW + 3_000);
            setAppState('active');
            mockLatestContext = { isUpdatePending: true, downloadedManifest: { id: 'update-1' } };
            let markerAtReload: string | null = null;
            let guardAtReload: string | null = null;
            mockReloadAsync.mockImplementationOnce(async () => {
                markerAtReload = await getSetting(RESTART_MARKER_KEY);
                guardAtReload = await getSetting(OTA_RESTART_GUARD_KEY);
            });

            await restartForUpdate();

            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
            expect(JSON.parse(markerAtReload as unknown as string)).toMatchObject({ reason: 'update', backgroundedAt: null });
            expect(guardAtReload).toBe('update-1');
        });

        it('Restart works before the context catches up with the download it was told about', async () => {
            mockLatestContext = {};
            await noticePendingUpdate('update-1');

            await restartForUpdate();

            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
            await expect(getSetting(OTA_RESTART_GUARD_KEY)).resolves.toBe('update-1');
        });

        it('Restart with nothing pending (an old row) does nothing', async () => {
            await restartForUpdate();
            expect(mockReloadAsync).not.toHaveBeenCalled();
        });

        it('a download that finishes in the background writes the row with no toast; the next return that does not reload toasts once', async () => {
            let finish: (v: unknown) => void = () => {};
            mockCheckForUpdate.mockResolvedValue({ isAvailable: true });
            mockFetchUpdate.mockImplementationOnce(() => new Promise((r) => (finish = r)) as never);
            mount();
            await flush();
            mockSpot = null; // the place left cannot be rebuilt, so this return cannot reload
            setAppState('background');
            finish({ isNew: true, manifest: { id: 'update-1' } });
            await waitFor(async () => expect(await rowsOf(UPDATE_AVAILABLE)).toHaveLength(1));
            expect(toastShow).not.toHaveBeenCalled();
            await expect(getSetting(OTA_NOTICED_KEY)).resolves.toBeNull();

            mockCheckForUpdate.mockResolvedValue({ isAvailable: false });
            setAppState('active');
            await flush();
            expect(mockReloadAsync).not.toHaveBeenCalled();
            expect(toastShow).toHaveBeenCalledTimes(1);
            expect(await rowsOf(UPDATE_AVAILABLE)).toHaveLength(1);
        });

        it('a download that finishes in the background and is applied on the return shows no Update ready toast', async () => {
            let finish: (v: unknown) => void = () => {};
            mockCheckForUpdate.mockResolvedValue({ isAvailable: true });
            mockFetchUpdate.mockImplementationOnce(() => new Promise((r) => (finish = r)) as never);
            mount();
            await flush();
            setAppState('background');
            finish({ isNew: true, manifest: { id: 'update-1' } });
            await waitFor(async () => expect(await rowsOf(UPDATE_AVAILABLE)).toHaveLength(1));

            setAppState('active');
            await flush();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
            expect(toastShow).not.toHaveBeenCalled();
        });

        it('a Restart tap carries the spot at the tap in the marker', async () => {
            mockLatestContext = { isUpdatePending: true, downloadedManifest: { id: 'update-1' } };
            mockSpot = { v: 1, tab: 'feed', page: 'notifications' };
            let markerAtReload: string | null = null;
            mockReloadAsync.mockImplementationOnce(async () => {
                markerAtReload = await getSetting(RESTART_MARKER_KEY);
            });
            await restartForUpdate();
            expect(JSON.parse(markerAtReload as unknown as string)).toMatchObject({
                reason: 'update',
                spot: { page: 'notifications' },
            });
        });

        it('a Restart tap with nothing rebuildable still reloads, with no spot', async () => {
            mockLatestContext = { isUpdatePending: true, downloadedManifest: { id: 'update-1' } };
            mockSpot = null;
            let markerAtReload: string | null = null;
            mockReloadAsync.mockImplementationOnce(async () => {
                markerAtReload = await getSetting(RESTART_MARKER_KEY);
            });
            await restartForUpdate();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
            expect(JSON.parse(markerAtReload as unknown as string).spot).toBeUndefined();
        });

        it('a Restart tap goes through an auto-only hold (an open sheet, the chat panel)', async () => {
            mockLatestContext = { isUpdatePending: true, downloadedManifest: { id: 'update-1' } };
            const release = holdAutoRestart('chat-open');
            await restartForUpdate();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
            release();
        });

        it.each([
            [['draft:chat'], 'Send or clear what you typed, then tap Restart.'],
            [['draft:search'], 'Send or clear what you typed, then tap Restart.'],
            [['chat-stream'], 'Mera will be ready to restart when this reply finishes.'],
            [['purchase'], "Finish what you're doing, then tap Restart."],
            [['chat-stream', 'draft:show-less'], 'Send or clear what you typed, then tap Restart.'],
        ])('a Restart tap held by %j does nothing and says why', async (labels, text) => {
            mockLatestContext = { isUpdatePending: true, downloadedManifest: { id: 'update-1' } };
            const info = jest.spyOn(toastManager, 'showInfo').mockImplementation(() => {});
            const releases = labels.map((l) => holdRestart(l));
            await restartForUpdate();
            expect(mockReloadAsync).not.toHaveBeenCalled();
            expect(info).toHaveBeenCalledWith(text);
            releases.forEach((r) => r());

            // Control: the same tap with the holds gone reloads.
            await restartForUpdate();
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('a Restart tap on a blocked route does nothing and says nothing', async () => {
            mockLatestContext = { isUpdatePending: true, downloadedManifest: { id: 'update-1' } };
            const info = jest.spyOn(toastManager, 'showInfo').mockImplementation(() => {});
            setCurrentPathname('/pin-lock');
            await restartForUpdate();
            expect(mockReloadAsync).not.toHaveBeenCalled();
            expect(info).not.toHaveBeenCalled();
        });

        describe('the Mera updated toast', () => {
            const notes = [{ at: day(22).toISOString(), message: 'Three' }];
            /** A boot that a reload for `reason` started, running update-3 after update-1. */
            const bootAfter = async (reason: string | null) => {
                if (reason) await setSetting(RESTART_MARKER_KEY, JSON.stringify({ reason, at: 1, backgroundedAt: null, lastForegroundAt: null }));
                await setSetting(OTA_LAST_RUNNING_KEY, JSON.stringify({ id: 'update-1', at: day(20).toISOString() }));
                process.env.EXPO_PUBLIC_OTA_NOTES = JSON.stringify(notes);
                mockUpdateId = 'update-3';
                mockCreatedAt = day(22);
                mount();
                await flush();
            };
            /** Past the announcement's delay (it waits for the restored screen to settle). */
            const announce = async (missing?: 'story' | 'publication') => {
                const p = announceAppliedUpdate(missing);
                await new Promise((r) => setTimeout(r, 600));
                await p;
            };
            const cardProps = (call = 0) =>
                (toastShow.mock.calls[call][0] as unknown as { render: () => { props: Record<string, unknown> } }).render().props;

            it.each(['ota', 'update'])('after a %s reload: one toast, no second row, and See what\'s new opens the notes and marks the row seen', async (reason) => {
                await bootAfter(reason);
                await announce();
                expect(toastShow).toHaveBeenCalledTimes(1);
                const props = cardProps();
                expect(props.title).toBe('Mera updated');
                expect((props.button as { label: string }).label).toBe("See what's new");
                expect(await rowsOf(APP_UPDATED)).toHaveLength(1);

                (props.button as { onPress: () => void }).onPress();
                await flush();
                expect(useOpenUpdateNotes.getState()).toMatchObject({ open: true, notes });
                expect((await rowsOf(APP_UPDATED))[0].status).toBe('actioned');

                // Once per process: the gate can run again.
                await announceAppliedUpdate();
                expect(toastShow).toHaveBeenCalledTimes(1);
            });

            it('a cold launch gets the row and no toast', async () => {
                await bootAfter(null);
                await announce();
                expect(toastShow).not.toHaveBeenCalled();
                expect(await rowsOf(APP_UPDATED)).toHaveLength(1);
            });

            it('a reload that did not change the running update (no row written) gets no toast', async () => {
                await setSetting(OTA_LAST_RUNNING_KEY, JSON.stringify({ id: 'update-3', at: day(22).toISOString() }));
                await setSetting(RESTART_MARKER_KEY, JSON.stringify({ reason: 'ota', at: 1, backgroundedAt: null, lastForegroundAt: null }));
                mockUpdateId = 'update-3';
                mount();
                await flush();
                await announce();
                expect(toastShow).not.toHaveBeenCalled();
            });

            it('with no notes the toast says so and has no button', async () => {
                await bootAfter('update');
                process.env.EXPO_PUBLIC_OTA_NOTES = '';
                __resetOtaNoticeForTests();
                await setSetting(OTA_LAST_RUNNING_KEY, JSON.stringify({ id: 'update-1', at: day(20).toISOString() }));
                mount();
                await flush();
                await announce();
                expect(cardProps().body).toBe('Fixes and improvements.');
                expect(cardProps().button).toBeUndefined();
            });

            it('a restored story that is gone replaces the toast', async () => {
                await bootAfter('ota');
                await announce('story');
                expect(toastShow).toHaveBeenCalledTimes(1);
                expect(cardProps().title).toBe('That story is no longer available.');
            });
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('the spot in the marker, and the two hold kinds', () => {
        const writeMarker = (payload: Record<string, unknown>) =>
            setSetting(RESTART_MARKER_KEY, JSON.stringify({ at: 1, backgroundedAt: null, lastForegroundAt: null, ...payload }));

        it('restartContext reads the reason and the spot, and takeRestoreSpot hands it out once', async () => {
            await writeMarker({ reason: 'ota', spot: SPOT });
            await expect(restartContext()).resolves.toMatchObject({ wasJsRestart: true, reason: 'ota', spot: SPOT });
            await expect(takeRestoreSpot()).resolves.toEqual(SPOT);
            await expect(takeRestoreSpot()).resolves.toBeNull();
        });

        it('a malformed spot, or one on a language or restore restart, is null', async () => {
            await writeMarker({ reason: 'ota', spot: 'feed' });
            await expect(takeRestoreSpot()).resolves.toBeNull();
            __resetAppRestartForTests();
            await writeMarker({ reason: 'language', spot: SPOT });
            await expect(takeRestoreSpot()).resolves.toBeNull();
            __resetAppRestartForTests();
            await expect(takeRestoreSpot()).resolves.toBeNull(); // cold start
        });

        it('a failed restore is carried across a later reload, and seeds the next process', async () => {
            asProductionBuild();
            disableAutoReload();
            let markerAtReload: string | null = null;
            mockReloadAsync.mockImplementationOnce(async () => {
                markerAtReload = await getSetting(RESTART_MARKER_KEY);
            });
            await requestRestart('update');
            expect(JSON.parse(markerAtReload as unknown as string).noAutoReload).toBe(true);

            __resetAppRestartForTests();
            expect(autoReloadDisabled()).toBe(false);
            await setSetting(RESTART_MARKER_KEY, markerAtReload as unknown as string);
            await restartContext();
            expect(autoReloadDisabled()).toBe(true);
        });

        it('an auto-only hold blocks only the automatic reload; a hard hold blocks every reason', () => {
            asProductionBuild();
            const releaseAuto = holdAutoRestart('overlay:dialog');
            expect(restartWouldReload('ota')).toBe(false);
            expect(restartWouldReload('update')).toBe(true);
            expect(restartWouldReload('language')).toBe(true);
            expect(restartWouldReload('restore')).toBe(true);
            expect(activeHolds('update')).toEqual([]);
            expect(activeHolds()).toEqual(['overlay:dialog']);
            releaseAuto();

            const releaseHard = holdRestart('draft:chat');
            for (const reason of ['ota', 'update', 'language', 'restore'] as const) expect(restartWouldReload(reason)).toBe(false);
            releaseHard();
            expect(restartWouldReload('ota')).toBe(true);
        });

        it('a language restart confirmed while its dialog still holds goes through', async () => {
            asProductionBuild();
            const release = holdAutoRestart('overlay:dialog');
            await requestRestart('language');
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
            release();
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('the version floor', () => {
        const expo = Constants as unknown as { expoConfig: Record<string, unknown> | null };
        const originalConfig = expo.expoConfig;

        afterEach(() => {
            expo.expoConfig = originalConfig;
        });

        /** The update gate's own hook: its status once the check settles. */
        async function gateVerdict(): Promise<'blocked' | 'allowed'> {
            (globalThis as { __DEV__?: boolean }).__DEV__ = false;
            const hook = renderHook(() => useNativeUpdateGate());
            await waitFor(() => expect(hook.result.current.status).not.toBe('checking'));
            const verdict = hook.result.current.status;
            hook.unmount();
            return verdict as 'blocked' | 'allowed';
        }

        beforeEach(() => {
            expo.expoConfig = { ...originalConfig, version: '1.2.0' };
        });

        const floor = (minSupportedVersion: string | null) =>
            server.use(mockGql('AppVersionInfo', { appVersionInfo: { __typename: 'AppVersionInfo', minSupportedVersion, storeUrl: 'https://example.com/store' } }));

        it('asks for the current platform and returns the floor and the store url', async () => {
            let variables: Record<string, unknown> = {};
            server.use(
                mockGql('AppVersionInfo', (v) => {
                    variables = v;
                    return { appVersionInfo: { __typename: 'AppVersionInfo', minSupportedVersion: '1.0.0', storeUrl: 'https://example.com/store' } };
                }),
            );
            await expect(AppVersionService.getVersionInfo()).resolves.toMatchObject({ minSupportedVersion: '1.0.0', storeUrl: 'https://example.com/store' });
            expect(variables).toEqual({ platform: 'IOS' });
        });

        it('a floor above the running version is blocked', async () => {
            floor('1.3.0');
            await expect(gateVerdict()).resolves.toBe('blocked');
            floor('1.2.1');
            await expect(gateVerdict()).resolves.toBe('blocked');
            floor('2');
            await expect(gateVerdict()).resolves.toBe('blocked');
        });

        it('a floor at or below the running version is allowed', async () => {
            floor('1.2.0');
            await expect(gateVerdict()).resolves.toBe('allowed');
            floor('1.2');
            await expect(gateVerdict()).resolves.toBe('allowed');
            floor('1.1.9');
            await expect(gateVerdict()).resolves.toBe('allowed');
        });

        it('no floor, or an unparseable one, is allowed: an unparseable version never forces an update', async () => {
            floor(null);
            await expect(gateVerdict()).resolves.toBe('allowed');
            floor('latest');
            await expect(gateVerdict()).resolves.toBe('allowed');
            floor('1.x.0');
            await expect(gateVerdict()).resolves.toBe('allowed');
        });

        it('a floor above the running version hands the blocked screen the store url', async () => {
            floor('9.0.0');
            (globalThis as { __DEV__?: boolean }).__DEV__ = false;
            const hook = renderHook(() => useNativeUpdateGate());
            await waitFor(() => expect(hook.result.current.status).toBe('blocked'));
            expect(hook.result.current.storeUrl).toBe('https://example.com/store');
            hook.unmount();
        });

        it('a GraphQL error is allowed (the check is best-effort)', async () => {
            server.use(mockGqlError('AppVersionInfo', 'INTERNAL_SERVER_ERROR'));
            await expect(AppVersionService.getVersionInfo()).rejects.toBeDefined();
            await expect(gateVerdict()).resolves.toBe('allowed');
        });

        it('an unreadable running version is never blocked', async () => {
            expo.expoConfig = null;
            floor('9.9.9');
            await expect(gateVerdict()).resolves.toBe('allowed');
        });
    });

    // The converted version-fallback cases: version.ts with an expo config that has no version or commit.
    describe('version module with a null expoConfig', () => {
        const expo = Constants as unknown as { expoConfig: Record<string, unknown> | null };
        const originalConfig = expo.expoConfig;

        beforeEach(() => {
            expo.expoConfig = null;
        });
        afterEach(() => {
            expo.expoConfig = originalConfig;
        });

        it('getGitCommit returns "unknown" when expoConfig is null', () => {
            expect(getGitCommit()).toBe('unknown');
        });

        it('getAppVersion returns an empty string when expoConfig is null', () => {
            expect(getAppVersion()).toBe('');
        });

        it('getAppVersionLabel returns only "unknown" (no version prefix) when the version is empty', () => {
            expect(getAppVersionLabel()).toBe('unknown');
        });

        it('with a version and a commit the label is "v<version> · <commit>"', () => {
            expo.expoConfig = { version: '1.2.0', extra: { gitCommit: 'abc123' } };
            expect(getAppVersionLabel()).toBe('v1.2.0 · abc123');
        });
    });
});
