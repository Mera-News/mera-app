import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ShareStatsPreviewScreen from '@/components/custom/share-stats/ShareStatsPreviewScreen';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ShareStats() {
    // The `card` param is UNTRUSTED and is passed straight through rather than
    // narrowed here: `resolveStatsCardParam` validates it against the known ids
    // AND against what this device actually has, which this file cannot know.
    // The shipped link com.mera.news://logged-in/share-stats carries no param
    // at all and must keep working, so absent is the ordinary case.
    const { card } = useLocalSearchParams<{ card?: string }>();

    return (
        <View style={{ flex: 1 }}>
            {/* Unpadded wrapper. The backdrop is mounted HERE, outside the
                SafeAreaView, so the page background spans the safe areas
                instead of leaving black strips at either end. */}
            <AbstractGradientBackdrop />

            <SafeAreaView testID="share-stats-screen" style={{ flex: 1 }}>
                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <ShareStatsPreviewScreen onBack={() => router.back()} requestedCard={card} />
                </ErrorBoundary>
            </SafeAreaView>
        </View>
    );
}
