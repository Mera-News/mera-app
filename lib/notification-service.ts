import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import logger from './logger';
import { AccountService } from './account-service';
import { useUserStore } from './stores/user-store';
import { getSetting, setSetting } from './database/services/setting-service';
import { ArticleSuggestionStatus } from './database/article-suggestion-status';

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

/**
 * Handles navigation from notification tap. Awaits a DB-backed cache refresh
 * before navigating so the For You screen never renders against a half-cleared
 * cache.
 */
async function handleNotificationNavigation(data: NotificationDeepLinkData): Promise<void> {
    try {
        await refreshForYouCacheFromDb();

        router.push('/logged-in/app_container/for_you');
    } catch (error) {
        logger.captureException(error, {
            tags: { service: 'notification-service', method: 'handleNotificationNavigation' },
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
            void handleNotificationNavigation(data);
        }
    );
}

/**
 * Checks for and handles notifications that launched the app (when app was not running)
 * Should be called once during app initialization after the router is ready
 */
export async function handleInitialNotification(): Promise<void> {
    try {
        const response = await Notifications.getLastNotificationResponseAsync();

        if (response) {
            const data = response.notification.request.content.data as NotificationDeepLinkData;
            await handleNotificationNavigation(data);
        }
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
            pushTokenListener = Notifications.addPushTokenListener(() => {
                void (async () => {
                    if (tokenRotationInFlight) return;
                    tokenRotationInFlight = true;
                    try {
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
        logger.captureException(err, {
            tags: { service: 'notification-service', method: 'checkPushTokenRevocation' },
        });
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

