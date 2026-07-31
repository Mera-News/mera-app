import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import SavedSuggestionsScreen from '@/components/custom/saved-suggestions/SavedSuggestionsScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

export default function SavedSuggestions() {
    const handleBack = () => {
        router.back();
    };

    return (
        <GluestackUIProvider mode="dark">
            {/* The root testID lives here rather than on SavedSuggestionsScreen:
                that component is ALSO mounted embedded inside ForYouScreen, and
                two elements answering to `saved-suggestions-screen` would make
                the harness's arrival assertion meaningless. */}
            <View testID="saved-suggestions-screen" style={{ flex: 1 }}>
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. It is mounted HERE rather than in
                    SavedSuggestionsScreen because that component is ALSO rendered
                    embedded inside ForYouScreen, which brings its own backdrop —
                    mounting it there would stack two animated fields. */}
                <AbstractGradientBackdrop />

                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <SavedSuggestionsScreen onBack={handleBack} />
                </ErrorBoundary>
            </View>
        </GluestackUIProvider>
    );
}
