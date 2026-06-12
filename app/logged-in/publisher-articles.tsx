import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import PublisherArticleList from '@/components/custom/config-panel/PublisherArticleList';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function PublisherArticles() {
    const params = useLocalSearchParams<{
        publisherId: string;
        publisherName: string;
    }>();

    if (!params.publisherId) {
        router.back();
        return null;
    }

    return (
        <GluestackUIProvider mode="dark">
            <SafeAreaView style={{ flex: 1, backgroundColor: '#000000' }}>
                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <PublisherArticleList
                        publisherId={params.publisherId}
                        publisherName={params.publisherName ?? 'Top headlines'}
                        onBack={() => router.back()}
                    />
                </ErrorBoundary>
            </SafeAreaView>
        </GluestackUIProvider>
    );
}
