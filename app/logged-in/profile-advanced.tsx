import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import AdvancedHubScreen from '@/components/custom/profile/AdvancedHubScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { authClient } from '@/lib/auth-client';
import { router } from 'expo-router';
import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ProfileAdvanced() {
    const { data: session } = authClient.useSession();
    const userId = session?.user?.id;

    return (
        <GluestackUIProvider mode="dark">
            <SafeAreaView style={{ flex: 1, backgroundColor: '#000000' }}>
                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    {userId ? (
                        <AdvancedHubScreen userId={userId} onBack={() => router.back()} />
                    ) : null}
                </ErrorBoundary>
            </SafeAreaView>
        </GluestackUIProvider>
    );
}
