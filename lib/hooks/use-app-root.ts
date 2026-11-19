// The root layout's boot logic (app/_layout.tsx's AppRoot), as a hook. Kept out
// of app/ because expo-router treats every file there as a route. Every module
// imported here is already imported by app/_layout.tsx above its task
// registrations, so module evaluation order is unchanged.
import { router, useNavigationContainerRef, usePathname } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { Directory, Paths } from 'expo-file-system';
import { useThemeMode } from '@/lib/theme/tokens';
import { useMotionAllowed } from '@/lib/motion-gate';
import { useUserStore } from '@/lib/stores/user-store';
import { applyLanguage } from '@/lib/i18n';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import logger from '@/lib/logger';
import { ensurePushTokenRegistered, handleInitialNotification, setupNotifications } from '@/lib/notification-service';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { purgeStaleModels } from '@/lib/mera-protocol-toolkit';
import { retireLegacyModels } from '@/lib/mera-protocol-toolkit/core/retire-models';
import { useModelLifecycle } from '@/lib/hooks/useModelLifecycle';
import { useAppStateStore, useIsNavigationReady } from '@/lib/stores/app-state-store';
import { closeStartupGate } from '@/lib/stores/pending-notification-route';
import { setCurrentPathname } from '@/lib/nav-state';
import { getNavigationTheme } from '@/lib/navigation/navigation-theme';
import { initNetworkListener } from '@/lib/stores/network-store';
import {
  applySentryUser,
  startSentryScopeSync,
} from '@/lib/observability/sentry-scope';
import { usePinStore } from '@/lib/stores/pin-store';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import {
  configureRevenueCat,
  addCustomerInfoUpdateListener,
  getCustomerInfoSafe,
} from '@/lib/revenuecat';
import { ensureSilentPushTaskRegistered } from '@/lib/background/inference-task';
import { DUMP_QUERIES_ENABLED } from '@/lib/config/endpoints';
import { startClient } from '@/lib/scheduler/start-client';

export function useAppRoot() {
  const navigationRef = useNavigationContainerRef();
  // Lite: every stack push and pop is instant (no motion, owner rule).
  const motion = useMotionAllowed();

  // Install-boundary safety net (S12): app/index.tsx awaits this before its
  // identity reads on the normal path, but a deep link can mount a different
  // first screen and would otherwise leave the auth-read quarantine latched
  // forever. Latched once per process; a second call is free.
  useEffect(() => {
    void (async () => {
      const { enforceInstallBoundary } = await import('@/lib/security/install-boundary');
      await enforceInstallBoundary();
    })();
  }, []);

  // react-navigation theme, from the app's theme store (never the OS scheme).
  // Supplies the page colour so the NativeTabs per-tab wrapper never paints
  // react-navigation's default background: the flash on tab switch.
  const themeMode = useThemeMode();
  const navigationTheme = getNavigationTheme(themeMode);

  // Mirror the current route into a module variable so non-React code (the
  // Apollo error link) can avoid redundant navigations to the paywall.
  const pathname = usePathname();
  useEffect(() => {
    setCurrentPathname(pathname);
  }, [pathname]);

  // Use Zustand store for navigation readiness (accessible globally)
  const isNavigationReady = useIsNavigationReady();
  const setNavigationReady = useAppStateStore((state) => state.setNavigationReady);
  const setAppInitialized = useAppStateStore((state) => state.setAppInitialized);

  useModelLifecycle();

  // Track when navigation is ready
  useEffect(() => {
    if (navigationRef?.isReady()) {
      setNavigationReady(true);
    }
  }, [navigationRef, setNavigationReady]);

  // The root can unmount while JS lives on (Android destroys the Activity, a tap
  // recreates it). Nothing set by the old tree may vouch for the new one.
  useEffect(
    () => () => {
      closeStartupGate();
      setNavigationReady(false);
    },
    [setNavigationReady],
  );

  // Set up notification listeners + wire silent-push task wakes. Push-token
  // registration happens during onboarding (explicit consent), not at boot.
  useEffect(() => {
    setupNotifications();
    void ensureSilentPushTaskRegistered();
  }, []);

  // Set up network connectivity listener. NetInfo's reachability probe asks a
  // host on the internet; it may run only while the app is in front, never on a
  // wake (a background launch never mounts this tree, a warm one keeps it).
  useEffect(() => {
    NetInfo.configure({ reachabilityShouldRun: () => AppState.currentState === 'active' });
    initNetworkListener();
  }, []);

  // Initialise the PIN gate once (reads the on-device record, engages the lock
  // on cold start, and wires the single AppState listener that re-locks after
  // >5 min in the background).
  useEffect(() => {
    void usePinStore.getState().init();
  }, []);

  // Runtime foreground re-lock: when the gate engages while the user is inside
  // the app, push the lock screen over whatever they were on. The cold-start
  // case is handled by app/index.tsx, and the login/setup/lock routes gate
  // themselves — so we only act on protected (/logged-in) routes here.
  const pinLocked = usePinStore((s) => s.locked);
  const pinSet = usePinStore((s) => s.pinSet);
  const lockEnabled = usePinStore((s) => s.lockEnabled);
  useEffect(() => {
    if (!isNavigationReady) return;
    if (pinLocked && pinSet && lockEnabled && pathname.startsWith('/logged-in')) {
      router.replace('/pin-lock' as any);
    }
  }, [pinLocked, pinSet, lockEnabled, isNavigationReady, pathname]);

  // Configure RevenueCat once and keep the subscription store in sync with
  // entitlement changes (purchases, renewals, expirations). No-op when no
  // RevenueCat key is configured. logIn happens after auth in
  // app/logged-in/index.tsx; the server remains the source of truth for access.
  useEffect(() => {
    configureRevenueCat();
    const remove = addCustomerInfoUpdateListener((info) =>
      useSubscriptionStore.getState().setCustomerInfo(info),
    );
    void getCustomerInfoSafe().then((info) =>
      useSubscriptionStore.getState().setCustomerInfo(info),
    );
    return remove;
  }, []);

  // Keep the Sentry scope tracking app state for the life of the process. This
  // is the ONLY registration point: lib/sentry-init.ts runs before store
  // hydration and must stay store-free (see the cycle note in its header), so
  // without this mount every event would carry build tags and nothing else.
  useEffect(() => startSentryScopeSync(), []);

  // Attribute events to the signed-in user (id only — see
  // lib/observability/sentry-scope.ts for why it is the raw better-auth id and
  // not a hash). Reads the LOCAL identity rather than the better-auth session,
  // matching the rest of the app: a crash is most likely when /get-session is
  // least likely to answer, and those are the events we can least afford to
  // receive unattributed. Logout clears userId, so this also nulls the scope —
  // redundantly with the two explicit sign-out paths, which is the point.
  const sentryUserId = useUserStore((s) => s.userId);
  useEffect(() => {
    applySentryUser(sentryUserId ?? null);
  }, [sentryUserId]);

  // Hydrate Zustand stores from WatermelonDB on app start. Fire-and-forget —
  // nothing here blocks the first paint of the For You feed. The cluster
  // suggestion query inside hydrateAllStores() pushes cached rows into the
  // For You store as soon as it resolves, and the screen subscribes
  // reactively.
  useEffect(() => {
    // Purge on-device prompt dumps unless the dev flag is on.
    // Mirrors DUMP_QUERIES_ENABLED in submitInferenceJob — when the flag
    // is off, flipping it is assumed to mean "I'm done debugging", so
    // the next cold start sweeps the accumulated .md files.
    if (!DUMP_QUERIES_ENABLED) {
      try {
        const dumpsDir = new Directory(Paths.document, 'prompt-dumps');
        if (dumpsDir.exists) dumpsDir.delete();
      } catch (err) {
        logger.captureException(err, {
          tags: { component: 'RootLayout', method: 'purge-prompt-dumps' },
        });
      }
    }

    // Mark the app initialised immediately so the route tree settles into
    // the feed without waiting for any DB work.
    setAppInitialized(true);

    // The client's boot (mera-news-client, lib/scheduler/start-client.ts): restart context, the
    // scheduler, store hydration, then the scheduler's hydrated kick. `afterHydrate` runs
    // synchronously right before that kick and is never awaited, so the work below is
    // fire-and-forget and the first sync never waits on it. Returns the stop function.
    return startClient({
      afterHydrate: () => {
        applyLanguage(useAppLanguageStore.getState().appLanguage);

        // On cloud processing, delete retired and unknown model files. The
        // current model stays, so switching back to On this phone needs no
        // 3 GB download. Safe on cold start: no llama context is loaded yet.
        const meraStore = useMeraProtocolStore.getState();
        if (meraStore.processingMode !== ProcessingMode.OnDevice) {
          purgeStaleModels()
            .catch((err) =>
              logger.captureException(err, {
                tags: { component: 'RootLayout', method: 'purge-disabled-models' },
              }),
            );
        } else {
          // On-device users: delete retired catalogue models and fall back to
          // Cloud when the selected model is not on disk. Never blocks boot.
          retireLegacyModels().catch((err) =>
            logger.captureException(err, {
              tags: { component: 'RootLayout', method: 'retire-legacy-models' },
            }),
          );
        }

        // Re-register the Expo push token on every boot. Idempotent: it only
        // POSTs when the token differs from the cached persona. Deliberately not
        // awaited: it is a network POST on the critical path to the first sync.
        // On a very first cold start the scoring run may then be minted with a
        // null token and poll for its result instead of a push wake-up.
        const { userId } = useUserStore.getState();
        if (userId) {
          void ensurePushTokenRegistered(userId).catch((err) =>
            logger.captureException(err, {
              tags: { component: 'RootLayout', method: 'ensurePushTokenRegistered' },
            }),
          );
        }
      },
    });
  }, [setAppInitialized]);

  // Handle the notification tap that launched or foregrounded the app. Must
  // wait for navigation to be ready before navigating.
  //
  // ON EVERY BOOT, restart boots included. `getLastNotificationResponseAsync()`
  // survives a JS reload and every background -> foreground return is one
  // (lib/app-restart.ts), so `handleInitialNotification` deduplicates on the
  // tap's persisted request identifier instead. Skipping restart boots (the old
  // rule) dropped every tap made while the app was in the background, because
  // that tap's own return is a restart. The tap never navigates past the
  // startup/PIN gate: it stashes its route for app/logged-in/index to consume.
  useEffect(() => {
    if (!isNavigationReady) return;
    void handleInitialNotification();
  }, [isNavigationReady]);

  return { motion, themeMode, navigationTheme };
}
