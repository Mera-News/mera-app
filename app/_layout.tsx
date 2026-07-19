// Initialise Sentry FIRST so background TaskManager wakes (which run JS
// without rendering the React tree) still report errors. Must be before any
// import that may throw or use logger.
import '@/lib/sentry-init';
// Polyfill crypto.getRandomValues — must precede any @noble/* crypto usage
import 'react-native-get-random-values';
import { ApolloProvider } from '@apollo/client/react';
import { DatabaseProvider } from '@nozbe/watermelondb/DatabaseProvider';
import { Stack, useNavigationContainerRef, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { enableFreeze } from 'react-native-screens';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import client from '../lib/apollo-client';

// Enables react-freeze-based screen freezing (perf item A7) so tab screens
// stop re-rendering while blurred — see components/custom/FocusFreeze.tsx.
enableFreeze(true);

import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import NativeUpdateGate from '@/components/custom/NativeUpdateGate';
import OTAUpdatePrompt from '@/components/custom/OTAUpdatePrompt';
import ToastInitializer from '@/components/custom/ToastInitializer';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
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
import { initNetworkListener } from '@/lib/stores/network-store';
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

// Register the inference TaskManager task at module load so the
// expo-notifications silent-push wake (phase-1-done / phase-2-done from the
// inference gateway) can resolve the task name on cold start. The task is
// response-unpacking only; fresh cycles are kicked off in the foreground.
defineInferenceTask();

// Everything below the mandatory-update gate. Kept as its own component so the
// gate can mount/unmount it as a unit: when an update is required (or while the
// version check is still resolving) this never mounts, so NONE of the boot
// hooks/effects below run — no hydration, no notifications, no push-token
// registration, no scheduler, no OTA. That is what makes the update screen
// truly quiescent (nothing in the background).
function AppRoot() {
  const navigationRef = useNavigationContainerRef();

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
      .then(async () => {
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
        // rotation events. Awaited before onStoresHydrated so the token is
        // in memory when the first feed-sync scoring pass runs.
        const { userId } = useUserStore.getState();
        if (userId) {
          await ensurePushTokenRegistered(userId);
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
          </Stack>
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
            <NativeUpdateGate>
              <ToastInitializer />
              <OTAUpdatePrompt />
              <AppRoot />
            </NativeUpdateGate>
          </GluestackUIProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
});