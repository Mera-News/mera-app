import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import PersonaArticleList from '@/components/custom/config-panel/PersonaArticleList';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function PersonaArticles() {
    const params = useLocalSearchParams<{
        interestId: string;
        interestText: string;
    }>();

    if (!params.interestId) {
        router.back();
        return null;
    }

    return (
        <GluestackUIProvider mode="dark">
            <SafeAreaView style={{ flex: 1, backgroundColor: '#000000' }}>
                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <PersonaArticleList
                        interestId={params.interestId}
                        interestText={params.interestText ?? 'Articles'}
                        onBack={() => router.back()}
                    />
                </ErrorBoundary>
            </SafeAreaView>
        </GluestackUIProvider>
    );
}
