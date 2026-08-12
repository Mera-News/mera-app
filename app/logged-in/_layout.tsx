import { Stack } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import FeedbackWidgetModal from '@/components/custom/FeedbackWidgetModal';
import ReauthBanner from '@/components/custom/ReauthBanner';
import FloatingChatHost from '@/components/custom/floating-chat/FloatingChatHost';
import LapseInterstitialGate from '@/components/custom/subscription/LapseInterstitialGate';
import FirstOpenPaywallGate from '@/components/custom/subscription/FirstOpenPaywallGate';
import ConsentGate from '@/components/custom/auth/ConsentGate';

export default function LoggedInLayout() {
  const insets = useSafeAreaInsets();

  return (
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
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="onboarding"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="not-subscribed"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="app_container"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="suggestion-detail"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="sources-publishers"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="sources-articles"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="persona-articles"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="country-articles"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="publisher-articles"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="notifications"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="article-detail"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="config-panel"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="sources"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="profile-advanced"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="saved-suggestions"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="story-timeline"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="fact-feed"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="facts"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="publication-preferences"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="visited-publications"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
        <Stack.Screen
          name="publication-history"
          options={{
            headerShown: false,
            animation: 'slide_from_right'
          }}
        />
      </Stack>
      {/* Mounted once for the whole logged-in tree rather than per-screen. The
          auth breaker no longer auto-resumes feed-sync while `needsReauth` is
          set — a proven-dead session must be re-authenticated, not retried — so
          this banner is the ONLY self-heal path. Previously it lived in the two
          feed headers, which left a user sitting on Explore/Profile/Settings
          with no visible way out. It self-gates on needsReauth + online, so it
          renders nothing in the common case. */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          top: insets.top + 8,
          left: 16,
          right: 16,
          zIndex: 20,
        }}
      >
        <ReauthBanner />
      </View>
      <FloatingChatHost />
      <FeedbackWidgetModal />
      {/* Renders nothing — a mounted effect. Lives here, once, so it watches
          the whole logged-in tree instead of one screen, and so it survives the
          tab switches a per-screen mount would miss. */}
      <LapseInterstitialGate />
      {/* Mutually exclusive with the gate above: this one requires
          hasEverSubscribed === false, which a lapse rules out. */}
      <FirstOpenPaywallGate />
      {/* MUST be last: renders an in-place full-screen overlay (not a
          navigation, unlike the two gates above) when the session user's
          accepted terms/privacy versions are missing or stale, and needs to
          paint over everything else mounted in this tree — including
          FloatingChatHost and the feedback modal above. Outranks onboarding
          and the paywall; see its own header for why it carries no
          app_container path filter. */}
      <ConsentGate />
    </View>
  );
}
