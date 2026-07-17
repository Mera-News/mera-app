import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import PublicationPreferencesScreen from '@/components/custom/publication-preferences/PublicationPreferencesScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router } from 'expo-router';
import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function PublicationPreferences() {
    return (
        <GluestackUIProvider mode="dark">
            <SafeAreaView style={{ flex: 1, backgroundColor: '#000000' }}>
                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <PublicationPreferencesScreen onBack={() => router.back()} />
                </ErrorBoundary>
            </SafeAreaView>
        </GluestackUIProvider>
    );
}
