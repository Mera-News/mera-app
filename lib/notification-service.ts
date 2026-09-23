import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import logger from './logger';
import { AccountService } from './account-service';
import { useUserStore } from './stores/user-store';
import { useNetworkStore } from './stores/network-store';
import { getSetting, setSetting } from './database/services/setting-service';
import { ArticleSuggestionStatus } from './database/article-suggestion-status';
import {
    isStartupGatePassed,
    stashPendingNotificationRoute,
    takePendingNotificationRouteForNavigation,
    type NotificationHref,
} from './stores/pending-notification-route';

/** Persisted count of consecutive push-token retrieval failures. Used to keep
 *  the (expected, recoverable) iOS APNs hang at `warning` level until recovery
 *  has consistently failed, at which point it escalates to `error`. */
const PUSH_TOKEN_FAIL_STREAK_KEY = 'push_token_fail_streak';
const PUSH_TOKEN_FAIL_ERROR_THRESHOLD = 3;

/**
 * Interface for notification data payload used for deep linking
 */
export interface NotificationDeepLinkData {
    url?: string;
    userId?: string;
    userPersonaId?: string;
    [key: string]: any;
}

// Configure how notifications should be handled when app is in foreground
Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
        const data = notification.request.content.data;

        // Silent background notifications — don't show any UI. These trigger
        // the inference response-unpacking background task via
        // registerTaskAsync; the task surfaces its own local notification
        // ("X impactful articles") once reconciliation finishes.
        if (
          data?.type === 'process-clusters' ||
          data?.type === 'inference-done' ||
          data?.type === 'phase1-done' ||
          data?.type === 'phase2-done'
        ) {
            return {
                shouldPlaySound: false,
                shouldSetBadge: false,
                shouldShowBanner: false,
                shouldShowList: false,
            };
        }

        // All other notifications — show normally
        return {
            shouldPlaySound: true,
            shouldSetBadge: true,
            shouldShowBanner: true,
            shouldShowList: true,
        };
    },
});

// Global notification listeners
let notificationListener: Notifications.Subscription | null = null;
let responseListener: Notifications.Subscription | null = null;

/**
 * Internal helper: attempt to register for push notifications and return the
 * Expo token. Uses PROVISIONAL authorization on iOS (iOS 12+) so silent pushes
 * work without prompting the user — visible notifications remain off until the
 * user explicitly opts in via the settings toggle.
 *
 * @param allowProvisional true for the boot-time silent-push registration path;
 *                         false when the settings toggle requests full permission.
 */
export async function registerForPushNotificationsAsync(
    allowProvisional: boolean = true,
): Promise<string | null> {
    let token: string | null = null;

    // Check if running on physical device (push notifications don't work on emulators)
    if (!Device.isDevice) {
        return null;
    }

    // Check existing permissions. Provisional counts as "granted enough" for
    // silent delivery — don't re-prompt if we're already at that level.
    const { status: existingStatus, ios } =
        await Notifications.getPermissionsAsync();
    const alreadyProvisional =
        Platform.OS === 'ios' && ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted' && !alreadyProvisional) {
        const requestOpts = allowProvisional
            ? { ios: { provisional: true } as Notifications.IosNotificationPermissionsRequest }
            : undefined;
        const { status } = await Notifications.requestPermissionsAsync(requestOpts);
        finalStatus = status;
    }

    // 'granted' covers both full and provisional on recent Expo; treat either as OK.
    if (finalStatus !== 'granted' && !alreadyProvisional) {
        return null;
    }

    try {
        // Get the project ID from app.json via expo-constants
        const projectId = Constants.expoConfig?.extra?.eas?.projectId;

        if (!projectId) {
            return null;
        }

        // Get the Expo push token with project ID from app.json
        // On iOS, this can sometimes hang indefinitely, so we add a timeout
        const pushTokenPromise = Notifications.getExpoPushTokenAsync({
            projectId,
        });

        // Add timeout for iOS (30 seconds) - iOS token retrieval can hang
        const timeoutPromise = new Promise<null>((_, reject) => {
            setTimeout(() => reject(new Error('Push token retrieval timed out after 30 seconds')), 30000);
        });

        const pushTokenData = await Promise.race([pushTokenPromise, timeoutPromise]);

        if (pushTokenData) {
            token = pushTokenData.data;
            // Success — clear any prior failure streak.
            await setSetting(PUSH_TOKEN_FAIL_STREAK_KEY, '0').catch(() => { /* best-effort */ });
        }
    } catch (error) {
        // iOS APNs token retrieval can hang/timeout transiently. Recovery is
        // built in (boot-time, token-rotation, and revocation-check paths all
        // re-attempt), so a single failure is a `warning`. Only escalate to
        // `error` once the failure has recurred consecutively — i.e. recovery
        // is consistently failing.
        let streak = 1;
        try {
            streak = Number((await getSetting(PUSH_TOKEN_FAIL_STREAK_KEY)) ?? '0') + 1;
            await setSetting(PUSH_TOKEN_FAIL_STREAK_KEY, String(streak));
        } catch { /* settings unavailable — fall back to single-failure level */ }
        const exhausted = streak >= PUSH_TOKEN_FAIL_ERROR_THRESHOLD;
        logger.captureException(error, {
            level: exhausted ? 'error' : 'warning',
            tags: { service: 'notification-service', method: 'registerForPushNotificationsAsync' },
            extra: { failStreak: streak },
        });
        return null;
    }

    // Android specific: Set up notification channel
    if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('default', {
            name: 'Default',
            importance: Notifications.AndroidImportance.MAX,
            vibrationPattern: [0, 250, 250, 250],
            lightColor: '#FF231F7C',
        });
    }

    return token;
}

/**
 * Type definitions for notification data
 */
export interface NotificationData {
    [key: string]: any;
}

/**
 * Comprehensive notification setup function
 * - Registers for push notifications (if not already done)
 * - Sets up notification listeners
 * - Does NOT update token in backend (only done during onboarding or in settings)
 * @returns Promise<string | null> - The Expo push token or null if registration fails
 */
export async function setupNotifications(): Promise<string | null> {
    const isEmulator = !Device.isDevice;

    // Cleanup existing listeners if any
    cleanupNotificationListeners();

    try {
        // Check existing permissions first - don't request if not already granted
        const { status: existingStatus } = await Notifications.getPermissionsAsync();

        // Only set up listeners if permissions are already granted
        if (existingStatus === 'granted') {
            setupNotificationListeners();
        }

        return null;
    } catch (error) {
        logger.captureException(error, {
            tags: { service: 'notification-service', method: 'setupNotifications' },
        });
        return null;
    }
}

/**
 * Refreshes the in-memory For You cache from WatermelonDB before navigating
 * from a notification tap. WatermelonDB is the source of truth and is never
 * deleted here — we only swap the in-memory cache if the DB read succeeds and
 * returns rows. On any failure or empty result, the existing cache is left
 * untouched so the user never lands on an empty For You screen.
 */
async function refreshForYouCacheFromDb(): Promise<void> {
    try {
        const [{ useForYouStore }, { loadSuggestions }] = await Promise.all([
            import('./stores/for-you-store'),
            import('./database/services/article-suggestion-service'),
        ]);

        const rows = await loadSuggestions();
        if (!rows || rows.length === 0) return;

        rows.sort((a, b) => {
            const av = a.status !== ArticleSuggestionStatus.Unscored ? a.relevance : -Infinity;
            const bv = b.status !== ArticleSuggestionStatus.Unscored ? b.relevance : -Infinity;
            return bv - av;
        });
        const scoredCount = rows.filter(
            (s) => s.status !== ArticleSuggestionStatus.Unscored,
        ).length;

        useForYouStore.setState({
            suggestions: rows,
            unscoredCount: rows.length - scoredCount,
        });
    } catch (error) {
        logger.captureException(error, {
            tags: { service: 'notification-service', method: 'refreshForYouCacheFromDb' },
        });
    }
}

/** Settings row holding the `request.identifier` of the last notification tap
 *  this device handled. See {@link handleInitialNotification}. */
export const HANDLED_NOTIFICATION_ID_KEY = 'last_handled_notification_id';

const DASHBOARD_ROUTE: NotificationHref = '/logged-in/app_container/for_you';

function nonBlank(v: unknown): string | null {
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Where a notification opens. Shared by an OS tap and an in-app notification
 * row (NotificationsScreen), so the two can never disagree. Never throws.
 *
 * ONE typed destination: `fact_check_done`, which is an ON-DEVICE type (the
 * payload never came from a server that knows who asked about what). It opens
 * the suggestion while its row exists, else the standalone article: suggestions
 * prune at 48h while notification rows live 90 days, and the retention row that
 * keeps a fact-checked article openable is keyed by ARTICLE id, so a pruned
 * suggestion id would dead-end on "story unavailable".
 *
 * Everything else, including every server payload, opens the Dashboard. In
 * particular the server `type === 'fact-check'` push must NEVER deep-link: it
 * was removed because delivering it required the server to store which user
 * asked about which article, and since fact-check rows dedupe by article
 * fingerprint that field also amounted to a list of the users who doubted the
 * same claim, a durable record of article-level behaviour our privacy policy
 * promises we do not keep. The linkage was dropped rather than the promise
 * amended, so the name `fact-check` stays a Dashboard route forever and the
 * on-device type is spelled differently on purpose.
 */
export async function resolveNotificationRoute(
    data: NotificationDeepLinkData | null | undefined,
): Promise<NotificationHref> {
    try {
        if (data?.type === 'fact_check_done') {
            const suggestionId = nonBlank(data.suggestionId);
            const articleId = nonBlank(data.articleId);
            if (suggestionId) {
                // Lazy require, not `await import()`: the dynamic form does not
                // run under this repo's jest config (it throws
                // ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG), so a test would
                // only ever see the catch below.
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { getSuggestionByServerId } = require('./database/services/article-suggestion-service') as typeof import('./database/services/article-suggestion-service');
                if (await getSuggestionByServerId(suggestionId)) {
                    return {
                        pathname: '/logged-in/suggestion-detail',
                        params: { articleSuggestionId: suggestionId },
                    };
                }
            }
            if (articleId) {
                return { pathname: '/logged-in/article-detail', params: { articleId } };
            }
        }
    } catch (error) {
        logger.captureException(error, {
            tags: { service: 'notification-service', method: 'resolveNotificationRoute' },
        });
    }
    return DASHBOARD_ROUTE;
}

/** Past the startup gate, PIN unlocked: a tap may navigate in this JS context.
 *  pin-store is lazy-required so this module's import graph (and its suite)
 *  does not grow app-restart and the PIN service. */
function gateIsOpen(): boolean {
    if (!isStartupGatePassed()) return false;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { usePinStore } = require('./stores/pin-store') as typeof import('./stores/pin-store');
        return usePinStore.getState().locked === false;
    } catch {
        return false;
    }
}

/**
 * One notification tap, from either path (warm listener or boot). Never throws.
 *
 * ORDER IS THE WHOLE POINT:
 *   1. stash the route on disk. Every background -> active return reloads JS
 *      (lib/app-restart.ts), so a warm tap's own navigation is usually wiped a
 *      moment later; the startup gate of the NEXT context consumes the row.
 *   2. record the identifier as handled, so the restart boot (where
 *      `getLastNotificationResponseAsync()` still returns this tap) does not
 *      open it a second time. After the stash on purpose: a reload between the
 *      two re-handles the same tap, which only rewrites the same stash.
 *   3. navigate now only when the gate is open: startup gate passed in this
 *      context and the PIN unlocked. Never over the lock screen, never ahead of
 *      the startup gate; either of those consumes the stash itself (a PIN
 *      unlock goes back through /logged-in). Navigating now KEEPS the row,
 *      stamped, because the reload that follows the tap wipes this
 *      navigation and the new boot skips the handled tap: the next context's
 *      startup gate reopens it once (see pending-notification-route).
 * No signed-in user: nothing to open, nothing stashed.
 */
async function handleNotificationTap(
    data: NotificationDeepLinkData,
    identifier: string | null,
): Promise<void> {
    try {
        const userId = useUserStore.getState().userId;
        if (userId) {
            const href = await resolveNotificationRoute(data);
            await stashPendingNotificationRoute(href, userId);
        }
        if (identifier) {
            await setSetting(HANDLED_NOTIFICATION_ID_KEY, identifier).catch(() => { /* best-effort */ });
        }
        if (!userId) return;

        if (!gateIsOpen()) return;
        // Not a plain consume: the row must outlive this navigation, which the
        // tap's own foreground reload usually wipes a moment later.
        const route = await takePendingNotificationRouteForNavigation(userId);
        if (!route) return;
        // The Dashboard renders from the in-memory cache; refresh it from the DB
        // first so it never paints against a half-cleared cache.
        if (route === DASHBOARD_ROUTE) await refreshForYouCacheFromDb();
        router.push(route);
    } catch (error) {
        logger.captureException(error, {
            tags: { service: 'notification-service', method: 'handleNotificationTap' },
            extra: { data },
        });
    }
}

/**
 * Sets up notification listeners for received notifications and user interactions
 */
function setupNotificationListeners(): void {
    // Listen for notifications received while app is in foreground.
    // 'process-clusters' silent pushes are ignored client-side now — the
    // foreground auto-poll covers fetching + scoring.
    notificationListener = Notifications.addNotificationReceivedListener(() => {});

    // Listen for user interaction with notifications (taps)
    responseListener = Notifications.addNotificationResponseReceivedListener(
        (response) => {
            const data = response.notification.request.content.data as NotificationDeepLinkData;
            void handleNotificationTap(data, response.notification.request.identifier ?? null);
        }
    );
}

/**
 * Handles the notification tap that launched or foregrounded the app. Called on
 * EVERY JS boot once navigation is ready, restart boots included.
 *
 * `getLastNotificationResponseAsync()` survives a JS reload and every return to
 * the foreground is one, so this deduplicates on the tap's
 * `request.identifier`, persisted in {@link HANDLED_NOTIFICATION_ID_KEY}: a tap
 * already handled (by an earlier boot or by the warm listener just before the
 * reload) is skipped, and a new one is handled even on a restart boot. The
 * earlier rule, "skip every restart boot", dropped every tap made while the app
 * was in the background, because that tap's own return is a restart. The
 * delivery date is no substitute key: it says when the notification arrived,
 * not when it was tapped.
 *
 * Routes through the same `handleNotificationTap` as a warm tap, so there is no
 * second implementation to keep in sync.
 */
export async function handleInitialNotification(): Promise<void> {
    try {
        const response = await Notifications.getLastNotificationResponseAsync();
        if (!response) return;

        const identifier = response.notification.request.identifier ?? null;
        if (identifier && (await getSetting(HANDLED_NOTIFICATION_ID_KEY)) === identifier) return;

        const data = response.notification.request.content.data as NotificationDeepLinkData;
        await handleNotificationTap(data, identifier);
    } catch (error) {
        logger.captureException(error, {
            tags: { service: 'notification-service', method: 'handleInitialNotification' },
        });
    }
}

/**
 * Cleans up notification listeners
 */
export function cleanupNotificationListeners(): void {
    if (notificationListener) {
        notificationListener.remove();
        notificationListener = null;
    }
    if (responseListener) {
        responseListener.remove();
        responseListener = null;
    }
}

// ---------------------------------------------------------------------------
// Token lifecycle (new) — separated from the visible-notification opt-in.
// ---------------------------------------------------------------------------

let pushTokenListener: Notifications.Subscription | null = null;

/**
 * Boot-time token registration. Called unconditionally — we need the Expo
 * token registered so the inference-gateway can wake the app via silent push,
 * regardless of whether the user has enabled visible alerts.
 *
 * Idempotent: safe to call multiple times. Only POSTs to the server when the
 * token has changed vs the cached persona.
 */
export async function ensurePushTokenRegistered(userId: string): Promise<void> {
    if (!userId) return;

    // Don't spend a boot-time round trip on a device with no link.
    // `getExpoPushTokenAsync` talks to Expo's push service, so on a cold start
    // in airplane mode it fails with a bare "Network request failed"
    // (MERA-APP-78). Skipping is SAFE rather than lossy: push-token-check-task
    // runs hourly and on every foreground WITH a `{ type: 'network' }`
    // condition, and `checkPushTokenRevocation` re-registers precisely when the
    // persona carries no cached token — which is exactly the state a skipped
    // boot leaves behind.
    //
    // `=== false`, never `!isConnected`. The store seeds optimistically until
    // NetInfo's first fetch lands, so "not yet known" must still attempt. This
    // is therefore an OPTIMISATION, not the fix: at 1.5s into a cold start the
    // store may well still read `true` and let the request through. The real
    // guarantee is the suppression class in logger.captureException, which runs
    // at capture time when the store has the true answer.
    if (useNetworkStore.getState().isConnected === false) {
        logger.addBreadcrumb(
            'ensurePushTokenRegistered skipped — device offline',
            'notification-service',
            { userId },
            'info',
        );
        return;
    }

    try {
        const token = await registerForPushNotificationsAsync(true);
        if (!token) return;

        const cachedToken = useUserStore.getState().userPersona?.expoPushToken ?? null;
        if (cachedToken !== token) {
            const updated = await AccountService.updateExpoPushTokenMutation(userId, token);
            useUserStore.getState().setUserPersona(updated);
        }

        // Wire a rotation listener — silently re-register on the rare native
        // token rotation. addPushTokenListener fires with a raw APNs/FCM device
        // token, so we must re-call getExpoPushTokenAsync to get the
        // ExponentPushToken[...] form the server expects. Only attach once.
        if (!pushTokenListener) {
            let tokenRotationInFlight = false;
            pushTokenListener = Notifications.addPushTokenListener((devicePushToken) => {
                void (async () => {
                    if (tokenRotationInFlight) return;
                    tokenRotationInFlight = true;
                    try {
                        // Intercom wants the RAW token this listener already
                        // carries, so rotation costs no extra native call —
                        // and must not re-enter getDevicePushTokenAsync, which
                        // rejects E_PROMISE_REPLACED on a concurrent call.
                        // Ordering is enforced inside sendIntercomPushToken.
                        if (devicePushToken?.data) {
                            const { sendIntercomPushToken } = require('@/lib/intercom');
                            await sendIntercomPushToken(String(devicePushToken.data)).catch(
                                () => { /* Non-fatal, see registerIntercomPushToken. */ },
                            );
                        }

                        const current = useUserStore.getState().userId;
                        if (!current) return;
                        const expoToken = await registerForPushNotificationsAsync(true);
                        if (!expoToken) return;
                        const cachedToken = useUserStore.getState().userPersona?.expoPushToken ?? null;
                        if (cachedToken === expoToken) return;
                        const updated = await AccountService.updateExpoPushTokenMutation(
                            current,
                            expoToken,
                        );
                        useUserStore.getState().setUserPersona(updated);
                    } catch (err) {
                        logger.captureException(err, {
                            tags: { service: 'notification-service', method: 'pushTokenRotation' },
                        });
                    } finally {
                        tokenRotationInFlight = false;
                    }
                })();
            });
        }

    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'notification-service', method: 'ensurePushTokenRegistered' },
            extra: { userId },
        });
    }
}

// ---------------------------------------------------------------------------
// Intercom push. Separate from everything above.
// ---------------------------------------------------------------------------

/**
 * Hand Intercom the RAW APNs/FCM device token.
 *
 * This is a different token from the `ExponentPushToken[...]` the rest of this
 * file deals with. Intercom's servers push directly via APNs/FCM and know
 * nothing about Expo's push service, so both are registered and both coexist —
 * `registerForPushNotificationsAsync` above is untouched.
 *
 * iOS note: Intercom's own config plugin cannot do this. Its
 * withPushNotifications mod inserts the setDeviceToken call with
 * `insertContentsInsideObjcFunctionBlock`, which is Objective-C only, and SDK
 * 55 generates a Swift AppDelegate — so the mod silently no-ops (it returns the
 * source unchanged rather than throwing). This JS path is the replacement. Do
 * not try to patch the AppDelegate.
 *
 * Safe to call repeatedly and never throws.
 */
export async function registerIntercomPushToken(): Promise<void> {
    if (!Device.isDevice) return;
    try {
        // getDevicePushTokenAsync can NEVER SETTLE when neither APNs delegate
        // fires — no rejection, no resolution, just a promise that hangs for
        // the life of the process. It also rejects with E_PROMISE_REPLACED if a
        // second call starts while one is in flight. So it is both raced
        // against a timeout and guarded by an in-flight flag, and no caller
        // ever awaits it on a path a user is watching.
        if (intercomTokenInFlight) return;
        intercomTokenInFlight = true;
        // The timer is captured and cleared rather than left to fire. A bare
        // setTimeout inside Promise.race keeps the event loop alive for its
        // full duration even after the race is settled — which in jest surfaces
        // as "a worker process has failed to exit gracefully", and on device is
        // a needless 10s wakeup on every support tap.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const token = await Promise.race([
            Notifications.getDevicePushTokenAsync(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error('device push token timed out after 10s')),
                    10000,
                );
            }),
        ]).finally(() => {
            if (timer) clearTimeout(timer);
        });
        if (!token?.data) return;
        const { sendIntercomPushToken } = require('@/lib/intercom');
        // sendIntercomPushToken checks Intercom.isUserLoggedIn() itself, which
        // is the ordering that matters: a token sent before login resolves is
        // rejected with an identity-verification error.
        await sendIntercomPushToken(String(token.data));
    } catch (err) {
        // Non-fatal by design: the user loses push for support replies, not the
        // app. Warning rather than exception — a device that has never been
        // granted notification permission reaches here routinely.
        logger.warn('[notification-service] Intercom push token registration failed', {
            error: String(err),
        });
    } finally {
        intercomTokenInFlight = false;
    }
}

let intercomTokenInFlight = false;

/**
 * Settings toggle handler. Flips the per-user `notificationsEnabled` flag.
 * Does NOT touch the Expo push token — that stays registered for silent
 * result-ready pushes regardless of the user's visible-notifications choice.
 *
 * When turning ON, requests full (non-provisional) notification permission.
 * If the OS declines, the flag stays OFF and the caller can surface the
 * denied state via `hasUserDeniedPermissions`.
 *
 * @returns true if the server flag was updated to `enabled`; false if blocked
 *          (e.g. OS denied full permission when turning on).
 */
export async function setVisibleNotificationsEnabled(
    userId: string,
    enabled: boolean,
): Promise<boolean> {
    if (!userId) return false;

    if (enabled) {
        // Upgrade from provisional → full. If already granted, this is a no-op.
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        if (existingStatus !== 'granted') {
            const { status } = await Notifications.requestPermissionsAsync();
            if (status !== 'granted') return false;
        }
    }

    try {
        const updated = await AccountService.updateNotificationsEnabled(userId, enabled);
        useUserStore.getState().setUserPersona(updated);
        return true;
    } catch (err) {
        logger.captureException(err, {
            tags: { service: 'notification-service', method: 'setVisibleNotificationsEnabled' },
            extra: { userId, enabled },
        });
        return false;
    }
}

/**
 * Checks if push notification permission was revoked in OS settings while
 * the app was backgrounded. If so, clears the token server-side.
 * Called by push-token-check-task on a 1-hour schedule + app-foreground.
 */
export async function checkPushTokenRevocation(): Promise<void> {
    try {
        const { status } = await Notifications.getPermissionsAsync();
        const uid = useUserStore.getState().userId;
        if (!uid) return;

        if (status === 'denied') {
            const cached = useUserStore.getState().userPersona?.expoPushToken;
            if (!cached) return;
            const updated = await AccountService.deleteExpoPushToken(uid);
            useUserStore.getState().setUserPersona(updated);
            return;
        }

        // Re-register if permission is granted but token is missing on the persona.
        // Covers: boot-time registration failure, FCM transient errors, and users
        // who granted notification permission after the initial prompt was dismissed.
        const cachedToken = useUserStore.getState().userPersona?.expoPushToken ?? null;
        if (!cachedToken && (status === 'granted' || status === 'undetermined')) {
            const token = await registerForPushNotificationsAsync(true);
            if (token) {
                const updated = await AccountService.updateExpoPushTokenMutation(uid, token);
                useUserStore.getState().setUserPersona(updated);
            }
        }
    } catch (err) {
        // A bare "Network request failed" here (Sentry MERA-APP-5G) is the
        // same transient-connectivity signal `registerForPushNotificationsAsync`
        // above already treats with a fail-streak before escalating — this
        // call runs on a 1-hour schedule + app-foreground, so a lost network
        // blip is expected and self-heals on the next tick. Downgrade that
        // specific case to a breadcrumb rather than a Sentry exception; any
        // other failure (e.g. a real AccountService/GraphQL error) still gets
        // reported normally since that's a real signal.
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('Network request failed')) {
            logger.addBreadcrumb(
                'checkPushTokenRevocation: network request failed — will retry next tick',
                'notification-service',
                { message },
                'warning',
            );
        } else {
            logger.captureException(err, {
                tags: { service: 'notification-service', method: 'checkPushTokenRevocation' },
            });
        }
    }
}

/**
 * Checks if the user has previously denied notification permissions
 * Returns true if permissions were explicitly denied (not just undetermined)
 */
export async function hasUserDeniedPermissions(): Promise<boolean> {
    try {
        const { status } = await Notifications.getPermissionsAsync();
        // 'denied' means user explicitly denied in the past
        // 'undetermined' means they haven't been asked yet
        return status === 'denied';
    } catch (error) {
        logger.captureException(error, {
            tags: { service: 'notification-service', method: 'hasUserDeniedPermissions' },
        });
        return false;
    }
}

