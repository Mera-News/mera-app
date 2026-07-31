import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import PublisherArticleList from '@/components/custom/config-panel/PublisherArticleList';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
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
            <View style={{ flex: 1 }}>
                {/* Unpadded wrapper. The page backdrop is mounted HERE, not inside the
                    SafeAreaView and not inside the screen component, so it spans the
                    FULL screen including the safe areas — otherwise the insets leave
                    black strips top and bottom. The content below keeps its insets. */}
                <AbstractGradientBackdrop />

                <SafeAreaView style={{ flex: 1 }}>
                    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                        <PublisherArticleList
                            publisherId={params.publisherId}
                            publisherName={params.publisherName ?? 'Top headlines'}
                            onBack={() => router.back()}
                        />
                    </ErrorBoundary>
                </SafeAreaView>
            </View>
        </GluestackUIProvider>
    );
}
