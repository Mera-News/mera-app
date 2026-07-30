import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import HeadlineDepthScreen from '@/components/custom/headline-depth/HeadlineDepthScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router } from 'expo-router';
import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function HeadlineDepth() {
    return (
        <GluestackUIProvider mode="dark">
            <SafeAreaView style={{ flex: 1, backgroundColor: '#000000' }}>
                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <HeadlineDepthScreen onBack={() => router.back()} />
                </ErrorBoundary>
            </SafeAreaView>
        </GluestackUIProvider>
    );
}
