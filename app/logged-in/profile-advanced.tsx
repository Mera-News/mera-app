import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import AdvancedHubScreen from '@/components/custom/profile/AdvancedHubScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { authClient } from '@/lib/auth-client';
import { useUserStore } from '@/lib/stores/user-store';
import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ProfileAdvanced() {
    // Identity is a LOCAL fact — the same rule the launch gate applies
    // (lib/security/launch-route.ts). Gating this hub on the SERVER session
    // rendered literally nothing (the `: null` below) whenever /get-session
    // could not be reached — offline, a keychain-locked background wake, a 401
    // blip — so a signed-in user opening Advanced got a blank page. The
    // persisted id (hydrated at launch, cleared only by an explicit logout) is
    // the gate now; the session is the fallback for the window before
    // hydrateFromDb() has run.
    const { data: session } = authClient.useSession();
    const localUserId = useUserStore((s) => s.userId);
    const userId = localUserId ?? session?.user?.id;

    return (
        <GluestackUIProvider mode="dark">
            <View style={{ flex: 1 }}>
                {/* Unpadded wrapper. The page backdrop is mounted HERE, not inside the
                    SafeAreaView and not inside the screen component, so it spans the
                    FULL screen including the safe areas — otherwise the insets leave
                    black strips top and bottom. The content below keeps its insets. */}
                <AbstractGradientBackdrop />

                <SafeAreaView style={{ flex: 1 }}>
                    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                        {userId ? (
                            <AdvancedHubScreen userId={userId} onBack={() => router.back()} />
                        ) : null}
                    </ErrorBoundary>
                </SafeAreaView>
            </View>
        </GluestackUIProvider>
    );
}
