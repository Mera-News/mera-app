// Initialise Sentry FIRST so background TaskManager wakes (which run JS
// without rendering the React tree) still report errors. Must be before any
// import that may throw or use logger.
import '@/lib/sentry-init';
// DEV-only cold-start timeline. Imported here for its module-eval side effect
// (t0 = bundle evaluation) and compiled out of release builds.
import '@/lib/diagnostics/coldstart-timeline';
// Polyfill crypto.getRandomValues — must precede any @noble/* crypto usage
import 'react-native-get-random-values';
import { ApolloProvider } from '@apollo/client/react';
import { DatabaseProvider } from '@nozbe/watermelondb/DatabaseProvider';
import { ThemeProvider } from '@react-navigation/native';
import { router, Stack, useNavigationContainerRef, usePathname } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import client from '../lib/apollo-client';

import { OfflineBannerSlot } from '@/components/custom/OfflineBanner';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import NativeUpdateGate from '@/components/custom/NativeUpdateGate';
import OTASilentUpdater from '@/components/custom/OTASilentUpdater';
import TranslationUnavailablePrompt from '@/components/custom/TranslationUnavailablePrompt';
import ToastInitializer from '@/components/custom/ToastInitializer';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { TextScaleProvider } from '@/lib/typography/TextScaleProvider';
import '@/global.css';
import database from '@/lib/database';
import { hydrateAllStores } from '@/lib/database/hydrate-stores';
import { useUserStore } from '@/lib/stores/user-store';
import { applyLanguage } from '@/lib/i18n';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import logger from '@/lib/logger';
import { ensurePushTokenRegistered, handleInitialNotification, setupNotifications } from '@/lib/notification-service';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { purgeAllBaseModels } from '@/lib/mera-protocol-toolkit';
import { Directory, Paths } from 'expo-file-system';
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
import {
  defineInferenceTask,
  ensureSilentPushTaskRegistered,
} from '@/lib/background/inference-task';
import { defineBackupTask, syncBackupTaskRegistration } from '@/lib/background/backup-task';
import * as Sentry from '@sentry/react-native';
import { DUMP_QUERIES_ENABLED } from '@/lib/config/endpoints';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
// Task registrations — each file calls AppScheduler.register() at module load
import '@/lib/scheduler/tasks/feed-sync-task';
import '@/lib/scheduler/tasks/inference-recover-task';
import '@/lib/scheduler/tasks/apollo-cache-evict-task';
import '@/lib/scheduler/tasks/push-token-check-task';
import '@/lib/scheduler/tasks/data-cleanup-task';
import '@/lib/scheduler/tasks/persona-migration-task';
import '@/lib/scheduler/tasks/persona-hygiene-task';
import '@/lib/scheduler/tasks/sanity-backfill-task';
import '@/lib/scheduler/tasks/persona-geo-task';
import '@/lib/scheduler/tasks/feedback-cycle-task';
import '@/lib/scheduler/tasks/entitlement-sync-task';

// Register the inference TaskManager task at module load so the
// expo-notifications silent-push wake (phase-1-done / phase-2-done from the
// inference gateway) can resolve the task name on cold start. The task is
// response-unpacking only; fresh cycles are kicked off in the foreground.
defineInferenceTask();

// Same reason, different trigger: the OS resolves the JS entry point on a
// BGTask wake and looks the task up by name, so it has to be DEFINED at module
// load or the wake finds nothing. Registration is separate and happens after
// settings hydrate, since it depends on the cadence.
defineBackupTask();

// Everything below the mandatory-update gate. Kept as its own component so the
// gate can mount/unmount it as a unit: when an update is required (or while the
// version check is still resolving) this never mounts, so NONE of the boot
// hooks/effects below run — no hydration, no notifications, no push-token
// registration, no scheduler, no OTA. That is what makes the update screen
// truly quiescent (nothing in the background).
function AppRoot() {
  const navigationRef = useNavigationContainerRef();

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

  // react-navigation theme, tracked to the app's color scheme (pinned dark
  // today via GluestackUIProvider mode="dark"). Supplies dark surfaces so the
  // NativeTabs per-tab wrapper never paints react-navigation's default light
  // background — the white flash on tab switch.
  const { colorScheme } = useColorScheme();
  const navigationTheme = getNavigationTheme(colorScheme === 'light' ? 'light' : 'dark');

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

        // If the user is on cloud processing, the downloaded base-model
        // GGUF (~3 GB) shouldn't squat on disk. Wipe the `mera-models/`
        // cache and reset the store's model-state so the UI reflects
        // reality. Safe to call on cold start — no llama context can be
        // loaded yet.
        const meraStore = useMeraProtocolStore.getState();
        if (meraStore.processingMode !== ProcessingMode.OnDevice) {
          purgeAllBaseModels()
            .then(() => {
              if (meraStore.modelState !== 'not_downloaded') {
                meraStore.setModelState('not_downloaded');
                meraStore.setDownloadProgress(0);
              }
            })
            .catch((err) =>
              logger.captureException(err, {
                tags: { component: 'RootLayout', method: 'purge-disabled-models' },
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

    return () => { AppScheduler.dispose(); };
  }, [setAppInitialized]);

  // Handle notifications that launched the app (when app was not running)
  // Must wait for navigation to be ready before navigating
  useEffect(() => {
    if (isNavigationReady) {
      handleInitialNotification();
    }
  }, [isNavigationReady]);

  return (
    <ErrorBoundary
      level="screen"
      FallbackComponent={FullScreenErrorFallback}
    >
      <DatabaseProvider database={database}>
        <ApolloProvider client={client}>
          <StatusBar style="light" backgroundColor="#000000" />
          <ThemeProvider value={navigationTheme}>
            <View style={{ flex: 1 }}>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: '#000000' },
                animation: 'slide_from_right',
              }}
            >
              <Stack.Screen
                name="index"
                options={{
                  headerShown: false,
                  animation: 'fade'
                }}
              />
              <Stack.Screen
                name="login"
                options={{
                  headerShown: false,
                  animation: 'slide_from_left'
                }}
              />
              <Stack.Screen
                name="logged-in"
                options={{
                  headerShown: false,
                  animation: 'fade'
                }}
              />
              <Stack.Screen
                name="pin-lock"
                options={{
                  headerShown: false,
                  animation: 'fade',
                  gestureEnabled: false,
                }}
              />
              <Stack.Screen
                name="pin-setup"
                options={{
                  headerShown: false,
                  animation: 'fade',
                  gestureEnabled: false,
                }}
              />
            </Stack>
            {/* Global connectivity band. Mounted at the ROOT, not in the
                /logged-in banner slot, because that slot cannot cover /login —
                and /login is exactly where the "Welcome back" screen lives that
                a failed request used to eject users onto. One mount also covers
                /pin-lock and /pin-setup. Self-gates on connectivity, so it
                renders nothing in the common case; insets are read inside the
                component so this layout gains no new subscription. */}
            <OfflineBannerSlot />
            </View>
          </ThemeProvider>
        </ApolloProvider>
      </DatabaseProvider>
    </ErrorBoundary>
  );
}

// Root layout: providers + the mandatory-update gate ONLY. Deliberately holds no
// store subscriptions or boot logic of its own, so background activity can never
// re-render the gate / update screen — when blocked, the screen is static.
export default Sentry.wrap(function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <GluestackUIProvider mode="dark">
            {/* Publishes the user's in-app text size to every <Text>/<Heading>.
                Outermost of the content providers so the update gate and the
                toasts scale too — and it holds the ONE store subscription, so
                this stays the only component that re-renders on a size change. */}
            <TextScaleProvider>
            <NativeUpdateGate>
              <ToastInitializer />
              <OTASilentUpdater />
              <TranslationUnavailablePrompt />
              <AppRoot />
            </NativeUpdateGate>
            </TextScaleProvider>
          </GluestackUIProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
});