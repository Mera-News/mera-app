import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import PublicationPage from '@/components/custom/publication-page/PublicationPage';
import { parsePublicationOrder } from '@/components/custom/publication-page/open-publication-page';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// The publication page. Opened ONLY through `openPublicationPage`, keyed by a
// publisher id or by a raw publication name plus country. Never a feed id.
export default function Publication() {
    const params = useLocalSearchParams<{
        publisherId?: string;
        name?: string;
        country?: string;
        order?: string;
    }>();

    // A missing key means a malformed deep link, often with no history to go
    // back to. A Redirect is the declarative way out and always has a
    // destination.
    if (!params.publisherId && !params.name) {
        return <Redirect href="/logged-in/app_container/feed" />;
    }

    return (
        <GluestackUIProvider mode="dark">
            <View style={{ flex: 1 }}>
                <AbstractGradientBackdrop />
                <SafeAreaView style={{ flex: 1 }}>
                    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                        <PublicationPage
                            publisherId={params.publisherId ?? null}
                            rawName={params.name ?? null}
                            countryCode={params.country ?? null}
                            order={parsePublicationOrder(params.order)}
                            onBack={() => router.back()}
                        />
                    </ErrorBoundary>
                </SafeAreaView>
            </View>
        </GluestackUIProvider>
    );
}
