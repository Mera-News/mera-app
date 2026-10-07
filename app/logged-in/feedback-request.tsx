import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import FeedbackRequestModal from '@/components/custom/feedback-request/FeedbackRequestModal';
import { isDuplicateFeedbackRequestScreen } from '@/components/custom/feedback-request/duplicate-screen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { useRoute } from '@react-navigation/native';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';

/**
 * The feedback-request modal, presented `transparentModal` (see
 * app/logged-in/_layout.tsx). A route rather than an in-tree Modal because a
 * push tap can only open a route; FeedbackRequestModal's header says more.
 *
 * Belt against a double open (a push tap and the auto-show host landing
 * together): a copy pushed directly on top of the same question closes itself
 * at once and renders nothing, so it stamps nothing either.
 */
export default function FeedbackRequestRoute() {
    const { id } = useLocalSearchParams<{ id?: string }>();
    const navigation = useNavigation();
    const route = useRoute();
    const [duplicate] = useState(() =>
        isDuplicateFeedbackRequestScreen(navigation.getState(), route.key, id),
    );
    const close = useCallback(() => {
        // Opened cold from a push, there may be nothing underneath to go back to.
        if (router.canGoBack()) router.back();
        else router.replace('/logged-in');
    }, []);
    useEffect(() => {
        if (duplicate) close();
    }, [duplicate, close]);
    if (duplicate) return null;
    return (
        <GluestackUIProvider>
            <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                <FeedbackRequestModal id={typeof id === 'string' ? id : undefined} onClose={close} />
            </ErrorBoundary>
        </GluestackUIProvider>
    );
}
