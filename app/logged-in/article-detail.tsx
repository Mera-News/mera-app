import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ArticleDetailScreen from '@/components/custom/news-detail/ArticleDetailScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import React from 'react';

export default function ArticleDetail() {
    const params = useLocalSearchParams<{
        articleId?: string;
        stableClusterId?: string;
    }>();

    const articleId = params.articleId;
    const stableClusterId =
        typeof params.stableClusterId === 'string' ? params.stableClusterId : undefined;

    // Evaluate once on mount: a deep-linked screen with no navigation history
    // shows a home button that jumps to For You instead of a back arrow.
    const [canGoBack] = React.useState(() => router.canGoBack());

    // A missing param means a malformed deep link, often with no history to go
    // back to. Navigating during render is a side effect in render; a
    // Redirect is the declarative equivalent and always has a destination.
    if (!articleId || typeof articleId !== 'string') {
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
                <ArticleDetailScreen
                    key={articleId}
                    articleId={articleId}
                    stableClusterId={stableClusterId}
                    onBack={handleBack}
                    backIcon={canGoBack ? 'back' : 'home'}
                />
            </ErrorBoundary>
        </GluestackUIProvider>
    );
}
