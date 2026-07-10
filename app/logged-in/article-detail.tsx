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

    if (!articleId || typeof articleId !== 'string') {
        router.back();
        return null;
    }

    const handleBack = () => {
        router.back();
    };

    return (
        <GluestackUIProvider>
            <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                <ArticleDetailScreen articleId={articleId} onBack={handleBack} />
            </ErrorBoundary>
        </GluestackUIProvider>
    );
}
