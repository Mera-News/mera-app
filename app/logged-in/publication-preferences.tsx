import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import PublicationPreferencesScreen from '@/components/custom/publication-preferences/PublicationPreferencesScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function PublicationPreferences() {
    return (
        <GluestackUIProvider mode="dark">
            <View style={{ flex: 1 }}>
                {/* Unpadded wrapper. The page backdrop is mounted HERE, not inside the
                    SafeAreaView and not inside the screen component, so it spans the
                    FULL screen including the safe areas — otherwise the insets leave
                    black strips top and bottom. The content below keeps its insets. */}
                <AbstractGradientBackdrop />

                <SafeAreaView testID="publication-preferences-screen" style={{ flex: 1 }}>
                    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                        <PublicationPreferencesScreen onBack={() => router.back()} />
                    </ErrorBoundary>
                </SafeAreaView>
            </View>
        </GluestackUIProvider>
    );
}
