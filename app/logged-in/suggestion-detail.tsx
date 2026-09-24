import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ArticleSuggestionScreen from '@/components/custom/news-detail/ArticleSuggestionScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import React from 'react';

export default function SuggestionDetail() {
    const params = useLocalSearchParams<{
        articleSuggestionId?: string;
    }>();

    const articleSuggestionId = params.articleSuggestionId;

    // Evaluate once on mount: a deep-linked screen with no navigation history
    // shows a home button that jumps to For You instead of a back arrow.
    const [canGoBack] = React.useState(() => router.canGoBack());

    // A missing param means a malformed deep link, often with no history to go
    // back to. Navigating during render is a side effect in render; a
    // Redirect is the declarative equivalent and always has a destination.
    if (!articleSuggestionId || typeof articleSuggestionId !== 'string') {
        return <Redirect href="/logged-in/app_container/for_you" />;
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
