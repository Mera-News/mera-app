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

    // Evaluate once on mount: a deep-linked screen with no navigation history
    // shows a home button that jumps to For You instead of a back arrow.
    const [canGoBack] = React.useState(() => router.canGoBack());

    if (!articleSuggestionId || typeof articleSuggestionId !== 'string') {
        router.back();
        return null;
    }

    const handleBack = () => {
        if (canGoBack) {
            router.back();
        } else {
            router.replace('/logged-in/app_container/for_you');
        }
    };

    return (
        <GluestackUIProvider mode="dark">
            <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                <ArticleSuggestionScreen
                    key={articleSuggestionId}
                    articleSuggestionId={articleSuggestionId}
                    onBack={handleBack}
                    backIcon={canGoBack ? 'back' : 'home'}
                />
            </ErrorBoundary>
        </GluestackUIProvider>
    );
}
