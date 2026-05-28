import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import SourcesL2PublisherList from '@/components/custom/config-panel/SourcesL2PublicationList';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
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
            <SafeAreaView style={{ flex: 1, backgroundColor: '#000000' }}>
                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <SourcesL2PublisherList
                        countryCode={params.countryCode}
                        countryName={params.countryName ?? 'Publishers'}
                        onBack={() => router.back()}
                    />
                </ErrorBoundary>
            </SafeAreaView>
        </GluestackUIProvider>
    );
}
