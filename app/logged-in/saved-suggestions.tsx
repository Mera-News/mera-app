import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import SavedSuggestionsScreen from '@/components/custom/saved-suggestions/SavedSuggestionsScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router } from 'expo-router';
import React from 'react';

export default function SavedSuggestions() {
    const handleBack = () => {
        router.back();
    };

    return (
        <GluestackUIProvider mode="dark">
            <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                <SavedSuggestionsScreen onBack={handleBack} />
            </ErrorBoundary>
        </GluestackUIProvider>
    );
}
