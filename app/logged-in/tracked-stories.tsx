import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import TrackedStoriesScreen from '@/components/custom/tracked-stories/TrackedStoriesScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router } from 'expo-router';
import React from 'react';

export default function TrackedStories() {
    const handleBack = () => {
        if (router.canGoBack()) {
            router.back();
        } else {
            router.replace('/logged-in/app_container/for_you');
        }
    };

    return (
        <GluestackUIProvider mode="dark">
            <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                <TrackedStoriesScreen onBack={handleBack} />
            </ErrorBoundary>
        </GluestackUIProvider>
    );
}
