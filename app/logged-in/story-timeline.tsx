import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import StoryTimelineScreen from '@/components/custom/tracked-stories/StoryTimelineScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';

export default function StoryTimeline() {
    const params = useLocalSearchParams<{ trackedStoryId?: string }>();
    const trackedStoryId = params.trackedStoryId;

    const [canGoBack] = React.useState(() => router.canGoBack());

    if (!trackedStoryId || typeof trackedStoryId !== 'string') {
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
                <StoryTimelineScreen
                    key={trackedStoryId}
                    trackedStoryId={trackedStoryId}
                    onBack={handleBack}
                />
            </ErrorBoundary>
        </GluestackUIProvider>
    );
}
