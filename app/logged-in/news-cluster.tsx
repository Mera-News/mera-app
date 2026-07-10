import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import NewsClusterScreen from '@/components/custom/news-detail/NewsClusterScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';

export default function NewsCluster() {
    const params = useLocalSearchParams<{
        clusterId: string;
    }>();

    const clusterId = params.clusterId;

    if (!clusterId || typeof clusterId !== 'string') {
        router.back();
        return null;
    }

    const handleBack = () => {
        router.back();
    };

    return (
        <GluestackUIProvider>
            <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                <NewsClusterScreen
                    clusterId={clusterId}
                    onBack={handleBack}
                />
            </ErrorBoundary>
        </GluestackUIProvider>
    );
}
