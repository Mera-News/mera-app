import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import PersonaArticleList from '@/components/custom/config-panel/PersonaArticleList';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function PersonaArticles() {
    const params = useLocalSearchParams<{ topicTexts: string }>();
    const topicTexts = params.topicTexts ? (JSON.parse(params.topicTexts) as string[]) : [];

    if (topicTexts.length === 0) {
        router.back();
        return null;
    }

    return (
        <GluestackUIProvider mode="dark">
            <SafeAreaView style={{ flex: 1, backgroundColor: '#000000' }}>
                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <PersonaArticleList
                        topicTexts={topicTexts}
                        onBack={() => router.back()}
                    />
                </ErrorBoundary>
            </SafeAreaView>
        </GluestackUIProvider>
    );
}
