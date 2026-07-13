import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ArticleDetailScreen from '@/components/custom/news-detail/ArticleDetailScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';

export default function ArticleDetail() {
    const params = useLocalSearchParams<{
        articleId?: string;
    }>();

    const articleId = params.articleId;

    // Evaluate once on mount: a deep-linked screen with no navigation history
    // shows a home button that jumps to For You instead of a back arrow.
    const [canGoBack] = React.useState(() => router.canGoBack());

    if (!articleId || typeof articleId !== 'string') {
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
                <ArticleDetailScreen
                    key={articleId}
                    articleId={articleId}
                    onBack={handleBack}
                    backIcon={canGoBack ? 'back' : 'home'}
                />
            </ErrorBoundary>
        </GluestackUIProvider>
    );
}
