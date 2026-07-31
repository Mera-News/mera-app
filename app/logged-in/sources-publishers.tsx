import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import SourcesL2PublisherList from '@/components/custom/config-panel/SourcesL2PublicationList';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function SourcesPublishers() {
    const params = useLocalSearchParams<{
        countryCode: string;
        countryName: string;
    }>();

    if (!params.countryCode) {
        router.back();
        return null;
    }

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
                        <SourcesL2PublisherList
                            countryCode={params.countryCode}
                            countryName={params.countryName ?? 'Publishers'}
                            onBack={() => router.back()}
                        />
                    </ErrorBoundary>
                </SafeAreaView>
            </View>
        </GluestackUIProvider>
    );
}
