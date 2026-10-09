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
    wasJsRestartSync,
} from '@/lib/app-restart';
import database from '@/lib/database';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import * as feedOrderStore from '@/lib/stores/feed-order-store';
import * as settingService from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { setCurrentPathname } from '@/lib/nav-state';
import { getAppVersion, getAppVersionLabel, getGitCommit } from '@/lib/version';
import { mockGql, mockGqlError, server, setAppState, useFakeClock } from '@/test/helpers';

let mockUpdatesEnabled = true;
const mockReloadAsync = jest.fn(async () => {});
const mockCheckForUpdate = jest.fn(async () => ({ isAvailable: false }));
const mockFetchUpdate = jest.fn(async () => ({ isNew: false }));
let mockLatestContext: Record<string, unknown> = {};
jest.mock('expo-updates', () => ({
    get isEnabled() {
        return mockUpdatesEnabled;
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
        mockCheckForUpdate.mockResolvedValue({ isAvailable: false });
        mockFetchUpdate.mockResolvedValue({ isNew: false });
        setAppState('active');
        setCurrentPathname(FEED);
        delete process.env.EXPO_PUBLIC_RESTART_DEBUG;
        (globalThis as { __DEV__?: boolean }).__DEV__ = true;
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
            await expect(restartContext()).resolves.toEqual({ wasJsRestart: true, backgroundedAt: null, lastForegroundAt: null });
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
            useFakeClock(NOW);
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
            useFakeClock(NOW);
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
            useFakeClock(NOW);
            await requestRestart('ota');
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);

            jest.setSystemTime(NOW + MIN_RESTART_INTERVAL_MS + 1);
            await requestRestart('ota');
            expect(mockReloadAsync).toHaveBeenCalledTimes(1);
        });

        it('enforces the interval ACROSS a reload, seeded from the marker', async () => {
            asProductionBuild();
            useFakeClock(NOW);
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
            useFakeClock(NOW);
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
            expect(restartWouldReload()).toBe(true);
        });

        it('is false while a hold is live, on a blocked route, and when the app is not active', () => {
            asProductionBuild();
            const release = holdRestart('purchase');
            expect(restartWouldReload()).toBe(false);
            release();

            setCurrentPathname('/verify-otp');
            expect(restartWouldReload()).toBe(false);
            setCurrentPathname(FEED);

            setAppState('background');
            expect(restartWouldReload()).toBe(false);
        });

        it('is false inside the cooldown', async () => {
            asProductionBuild();
            useFakeClock(NOW);
            await requestRestart('ota');
            jest.setSystemTime(NOW + MIN_RESTART_INTERVAL_MS - 1);
            expect(restartWouldReload()).toBe(false);
        });

        // An inert build eating the attempt is the same bug in different clothes.
        it('is false in a dev build, when updates are disabled, and under EXPO_PUBLIC_RESTART_DEBUG', () => {
            expect(restartWouldReload()).toBe(false);

            asProductionBuild();
            mockUpdatesEnabled = false;
            expect(restartWouldReload()).toBe(false);

            asProductionBuild();
            process.env.EXPO_PUBLIC_RESTART_DEBUG = 'true';
            expect(restartWouldReload()).toBe(false);
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

                const predicted = restartWouldReload();
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
            useFakeClock(NOW);
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
