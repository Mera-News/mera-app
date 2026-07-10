import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import VisitedPublicationsList from '@/components/custom/config-panel/VisitedPublicationsList';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { useThemeColors } from '@/lib/theme/tokens';
import { router } from 'expo-router';
import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function VisitedPublications() {
    const colors = useThemeColors();
    return (
        <GluestackUIProvider>
            <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <VisitedPublicationsList onBack={() => router.back()} />
                </ErrorBoundary>
            </SafeAreaView>
        </GluestackUIProvider>
    );
}
