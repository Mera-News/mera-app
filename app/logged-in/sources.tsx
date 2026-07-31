import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import SourcesScreen from '@/components/custom/config-panel/SourcesScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Interim full-screen access point for Sources management (Wave 5), pushed
// from the "Sources" row at the top of the Settings tab. Sources moves into
// the Explore tab in a later wave; this route unwires cleanly then.
export default function Sources() {
    return (
        <GluestackUIProvider mode="dark">
            <View style={{ flex: 1 }}>
                {/* Unpadded wrapper. The page backdrop is mounted HERE, not inside the
                    SafeAreaView and not inside the screen component, so it spans the
                    FULL screen including the safe areas — otherwise the insets leave
                    black strips top and bottom. The content below keeps its insets. */}
                <AbstractGradientBackdrop />

                <SafeAreaView testID="sources-screen" style={{ flex: 1 }}>
                    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                        <SourcesScreen onBack={() => router.back()} />
                    </ErrorBoundary>
                </SafeAreaView>
            </View>
        </GluestackUIProvider>
    );
}
