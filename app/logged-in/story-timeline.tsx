import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import StoryTimelineScreen from '@/components/custom/tracked-stories/StoryTimelineScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import React from 'react';

export default function StoryTimeline() {
    const params = useLocalSearchParams<{ trackedStoryId?: string }>();
    const trackedStoryId = params.trackedStoryId;

    const [canGoBack] = React.useState(() => router.canGoBack());

    // A missing param means a malformed deep link, often with no history to go
    // back to. Navigating during render is a side effect in render; a
    // Redirect is the declarative equivalent and always has a destination.
    if (!trackedStoryId || typeof trackedStoryId !== 'string') {
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
                <StoryTimelineScreen
                    key={trackedStoryId}
                    trackedStoryId={trackedStoryId}
                    onBack={handleBack}
                />
            </ErrorBoundary>
        </GluestackUIProvider>
    );
}
