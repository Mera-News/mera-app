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
import FactsComboToast from '@/components/custom/toast/FactsComboToast';
import ToastDeck from '@/components/custom/toast/ToastDeck';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { DialogHost } from '@/components/ui/confirm-dialog';
import { ThemeCrossfade } from '@/components/ui/theme-crossfade';
import { COLORS, useThemeMode } from '@/lib/theme/tokens';
import { hydrateTheme } from '@/lib/theme/theme-store';
import LaunchLogoHandoff from '@/components/custom/auth/LaunchLogoHandoff';
import { TextScaleProvider } from '@/lib/typography/TextScaleProvider';
import { useMotionAllowed } from '@/lib/motion-gate';
import { ReduceMotion, ReducedMotionConfig } from 'react-native-reanimated';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
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
import { retireLegacyModels } from '@/lib/mera-protocol-toolkit/core/retire-models';
import { Directory, Paths } from 'expo-file-system';
import { useModelLifecycle } from '@/lib/hooks/useModelLifecycle';
import { useAppStateStore, useIsNavigationReady } from '@/lib/stores/app-state-store';
import { setCurrentPathname } from '@/lib/nav-state';
import { holdSplash, SplashReleaser } from '@/lib/splash-hold';
import RestoreCover from '@/components/custom/launch/RestoreCover';
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
import * as Sentry from '@sentry/react-native';
import { DUMP_QUERIES_ENABLED } from '@/lib/config/endpoints';
import { initRestartContext } from '@/lib/app-restart';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
// Task registrations — each file calls AppScheduler.register() at module load
import '@/lib/scheduler/tasks/feed-sync-task';
import '@/lib/scheduler/tasks/feedback-request-sync-task';
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
import '@/lib/scheduler/tasks/fact-check-reconcile-task';
import { useAppRoot } from '@/lib/hooks/use-app-root';

// The OS-woken tasks (the silent-push unpack and `mera-background`) are
// defined in `index.js`, not here: under expo-router this module is evaluated
// only when a route renders, and a killed app woken headless renders nothing.
// See lib/background/define-tasks.ts.

// Everything below the mandatory-update gate. Kept as its own component so the
// gate can mount/unmount it as a unit: when an update is required (or while the
// version check is still resolving) this never mounts, so NONE of the boot
// hooks/effects below run — no hydration, no notifications, no push-token
// registration, no scheduler, no OTA. That is what makes the update screen
// truly quiescent (nothing in the background).
function AppRoot() {
  const { motion, themeMode, navigationTheme } = useAppRoot();

  return (
    <ErrorBoundary
      level="screen"
      FallbackComponent={FullScreenErrorFallback}
    >
      <DatabaseProvider database={database}>
        <ApolloProvider client={client}>
          <StatusBar style={themeMode === 'light' ? 'dark' : 'light'} backgroundColor={COLORS[themeMode].base} />
          <ThemeProvider value={navigationTheme}>
            <View style={{ flex: 1 }}>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: COLORS[themeMode].base },
                animation: motion ? 'slide_from_right' : 'none',
              }}
            >
              <Stack.Screen
                name="index"
                options={{
                  headerShown: false,
                  animation: motion ? 'fade' : 'none'
                }}
              />
              <Stack.Screen
                name="login"
                options={{
                  headerShown: false,
                  animation: motion ? 'slide_from_left' : 'none'
                }}
              />
              <Stack.Screen
                name="logged-in"
                options={{
                  headerShown: false,
                  animation: motion ? 'fade' : 'none'
                }}
              />
              <Stack.Screen
                name="pin-lock"
                options={{
                  headerShown: false,
                  animation: motion ? 'fade' : 'none',
                  gestureEnabled: false,
                }}
              />
              <Stack.Screen
                name="pin-setup"
                options={{
                  headerShown: false,
                  animation: motion ? 'fade' : 'none',
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
            {/* F1: releases the held splash on the first route past the
                startup gates (lib/splash-hold.ts). Renders nothing. */}
            <SplashReleaser />
            {/* Into the Feed: the launch logo flies into the Mera button. */}
            <LaunchLogoHandoff />
            {/* Android only: the launch look over an update reload's rebuild of the reader's spot. Last, so it covers the stack. */}
            <RestoreCover />
            </View>
          </ThemeProvider>
        </ApolloProvider>
      </DatabaseProvider>
    </ErrorBoundary>
  );
}

// F1: keep the native splash over the version check and the startup gates
// until the first real screen commits (capped, so it can never hang). Module
// scope on purpose: the public preventAutoHideAsync must run before
// expo-router's own first-render auto-hide.
holdSplash();

// The theme choice is a device preference in AsyncStorage: read it before the
// first screen so a light device never paints dark first. Never rejects.
void hydrateTheme();

/**
 * Lite = no motion (lib/motion-gate.ts, layer 1): Reanimated's reduce-motion
 * switch forced on, so every Reanimated animation started from now on lands at
 * once. Rendered only in Lite: unmounting restores the system value, so a Full
 * user's Reduce Motion is never touched. Its own component so the store
 * subscription never re-renders the root.
 */
function LiteMotionConfig() {
  const lite = useDisplayPrefsStore((s) => s.liteMode);
  return lite ? <ReducedMotionConfig mode={ReduceMotion.Always} /> : null;
}

// Root layout: providers + the mandatory-update gate ONLY. Deliberately holds no
// store subscriptions or boot logic of its own, so background activity can never
// re-render the gate / update screen — when blocked, the screen is static.
export default Sentry.wrap(function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* First, so Lite's no-motion switch is set before anything animates. */}
      <LiteMotionConfig />
      <KeyboardProvider>
        <SafeAreaProvider>
          <GluestackUIProvider>
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
              {/* Renders nothing: shows the facts-combo progress card on the deck. */}
              <FactsComboToast />
              {/* LAST on purpose: toasts have to paint above the router stack,
                  the tab bar and the floating chat bubble, and on native that
                  is decided by sibling order. Inside TextScaleProvider so they
                  still scale, and inside SafeAreaProvider for the insets. */}
              <ToastDeck />
              {/* The app's dialogs from plain code (lib/dialog.ts); no native alerts. */}
              <DialogHost />
              {/* The 300 ms crossfade when the theme changes. Renders nothing at rest. */}
              <ThemeCrossfade />
            </NativeUpdateGate>
            </TextScaleProvider>
          </GluestackUIProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
});