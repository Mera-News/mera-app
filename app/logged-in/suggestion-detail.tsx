import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ArticleSuggestionScreen from '@/components/custom/news-detail/ArticleSuggestionScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';

export default function SuggestionDetail() {
    const params = useLocalSearchParams<{
        articleSuggestionId?: string;
    }>();

    const articleSuggestionId = params.articleSuggestionId;

    if (!articleSuggestionId || typeof articleSuggestionId !== 'string') {
        router.back();
        return null;
    }

    const handleBack = () => {
        router.back();
    };

    return (
        <GluestackUIProvider mode="dark">
            <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                <ArticleSuggestionScreen
                    articleSuggestionId={articleSuggestionId}
                    onBack={handleBack}
                />
            </ErrorBoundary>
        </GluestackUIProvider>
    );
}
