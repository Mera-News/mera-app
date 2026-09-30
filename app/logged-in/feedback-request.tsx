import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import FeedbackRequestModal from '@/components/custom/feedback-request/FeedbackRequestModal';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback } from 'react';

/**
 * The feedback-request modal, presented `transparentModal` (see
 * app/logged-in/_layout.tsx). A route rather than an in-tree Modal because a
 * push tap can only open a route; FeedbackRequestModal's header says more.
 */
export default function FeedbackRequestRoute() {
    const { id } = useLocalSearchParams<{ id?: string }>();
    const close = useCallback(() => {
        // Opened cold from a push, there may be nothing underneath to go back to.
        if (router.canGoBack()) router.back();
        else router.replace('/logged-in');
    }, []);
    return (
        <GluestackUIProvider mode="dark">
            <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                <FeedbackRequestModal id={typeof id === 'string' ? id : undefined} onClose={close} />
            </ErrorBoundary>
        </GluestackUIProvider>
    );
}
