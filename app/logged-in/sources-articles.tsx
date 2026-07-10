import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import SourcesArticleList from '@/components/custom/config-panel/SourcesArticleList';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { useThemeColors } from '@/lib/theme/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function SourcesArticles() {
    const colors = useThemeColors();
    const params = useLocalSearchParams<{
        title: string;
        countryCode: string;
        publisherName: string;
        publicationSourceId: string;
    }>();

    if (!params.publicationSourceId) {
        router.back();
        return null;
    }

    return (
        <GluestackUIProvider>
            <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <SourcesArticleList
                        title={params.title ?? 'Articles'}
                        publisherName={params.publisherName}
                        publicationSourceId={params.publicationSourceId}
                        onBack={() => router.back()}
                    />
                </ErrorBoundary>
            </SafeAreaView>
        </GluestackUIProvider>
    );
}
