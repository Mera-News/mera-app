// The root layout's boot logic (app/_layout.tsx's AppRoot), as a hook. Kept out
// of app/ because expo-router treats every file there as a route. Every module
// imported here is already imported by app/_layout.tsx above its task
// registrations, so module evaluation order is unchanged.
import { router, useNavigationContainerRef, usePathname } from 'expo-router';
import { useEffect } from 'react';
import { Directory, Paths } from 'expo-file-system';
import { useThemeMode } from '@/lib/theme/tokens';
import { useMotionAllowed } from '@/lib/motion-gate';
import { hydrateAllStores } from '@/lib/database/hydrate-stores';
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
import { initRestartContext } from '@/lib/app-restart';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';

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

  // Set up notification listeners + wire silent-push task wakes. Push-token
  // registration happens during onboarding (explicit consent), not at boot.
  useEffect(() => {
    setupNotifications();
    void ensureSilentPushTaskRegistered();
  }, []);

  // Set up network connectivity listener
  useEffect(() => {
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

    // ONE settings read, ahead of everything that depends on it.
    //
    // `initRestartContext()` reads and clears the restart marker
    // (lib/app-restart.ts), which is what tells this boot apart from a real
    // cold start. It is awaited BEFORE AppScheduler.init() so that
    // `onStoresHydrated()` — which must stay synchronous, see its header — can
    // read the populated cache rather than a promise. pin-store.init() runs in
    // an earlier effect and awaits the same memoised promise, so the two
    // callers share a single read and neither has to know about the other.
    // `cancelled` because `AppScheduler.init()` now sits behind an await. If the
    // update gate flips to blocked in that window, AppRoot unmounts and
    // dispose() runs FIRST — and init() registers its AppState and network
    // listeners above its own `suspended` guard, so it would re-arm them behind
    // the force-update screen.
    let cancelled = false;
    void (async () => {
      await initRestartContext();
      if (cancelled) return;

      // Initialise the scheduler after marking the app ready so tasks that
      // check db-ready will pass their condition on the first tick.
      void AppScheduler.init();

      // Kick off store hydration in the background. The For You suggestion
      // query inside is fired ahead of everything else and updates the store
      // the instant it resolves — the screen re-renders with cached rows
      // without the rest of hydration needing to complete.
      hydrateAllStores()
        .then(() => {
          // Post-hydration tasks that need hydrated store state.
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

          // Re-register the Expo push token on every boot. This is idempotent —
          // only POSTs to the server when the token has changed vs the cached
          // persona. Handles reinstalls, iOS→Android migrations, and token
          // rotation events.
          //
          // Deliberately NOT awaited: it is a network POST sitting directly on the
          // critical path to the first sync, and cold start is exactly when the
          // user is looking at an empty feed. Tradeoff — `getExpoPushToken()`
          // reads `userPersona?.expoPushToken`, so on a very first cold start the
          // scoring run may be minted with a null token and fall back to polling
          // for its result instead of a push wake-up. Latency now beats a
          // slightly cheaper first run.
          const { userId } = useUserStore.getState();
          if (userId) {
            void ensurePushTokenRegistered(userId).catch((err) =>
              logger.captureException(err, {
                tags: { component: 'RootLayout', method: 'ensurePushTokenRegistered' },
              }),
            );
          }

          // Treat cold start like an app-foreground event so tasks that
          // declare 'app-foreground' triggers (feed-sync, inference-recover)
          // fire immediately without waiting for a background→foreground cycle.
          // Placed after hydration so the 'authenticated' condition passes.
          AppScheduler.onStoresHydrated();
        })
        .catch((error) =>
          logger.captureException(error, {
            tags: { component: 'RootLayout', method: 'bootstrap' },
          }),
        );
    })();

    return () => { cancelled = true; AppScheduler.dispose(); };
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
