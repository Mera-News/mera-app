import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import CountryArticleList from '@/components/custom/config-panel/CountryArticleList';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { useThemeColors } from '@/lib/theme/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function CountryArticles() {
    const colors = useThemeColors();
    const params = useLocalSearchParams<{
        countryCode: string;
        countryName: string;
    }>();

    if (!params.countryCode) {
        router.back();
        return null;
    }

    return (
        <GluestackUIProvider>
            <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <CountryArticleList
                        countryCode={params.countryCode}
                        countryName={params.countryName ?? 'Top headlines'}
                        onBack={() => router.back()}
                    />
                </ErrorBoundary>
            </SafeAreaView>
        </GluestackUIProvider>
    );
}
