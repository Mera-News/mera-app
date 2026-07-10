import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import PublicationArticleHistoryList from '@/components/custom/config-panel/PublicationArticleHistoryList';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { useThemeColors } from '@/lib/theme/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function PublicationHistory() {
    const colors = useThemeColors();
    const params = useLocalSearchParams<{
        publicationName: string;
        countryCode?: string;
    }>();

    if (!params.publicationName) {
        router.back();
        return null;
    }

    return (
        <GluestackUIProvider>
            <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <PublicationArticleHistoryList
                        publicationName={params.publicationName}
                        countryCode={params.countryCode ?? null}
                        onBack={() => router.back()}
                    />
                </ErrorBoundary>
            </SafeAreaView>
        </GluestackUIProvider>
    );
}
