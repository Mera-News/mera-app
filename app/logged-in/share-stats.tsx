import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ShareStatsPreviewScreen from '@/components/custom/share-stats/ShareStatsPreviewScreen';
import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ShareStats() {
    return (
        <View style={{ flex: 1 }}>
            {/* Unpadded wrapper. The backdrop is mounted HERE, outside the
                SafeAreaView, so the page background spans the safe areas
                instead of leaving black strips at either end. */}
            <AbstractGradientBackdrop />

            <SafeAreaView testID="share-stats-screen" style={{ flex: 1 }}>
                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <ShareStatsPreviewScreen onBack={() => router.back()} />
                </ErrorBoundary>
            </SafeAreaView>
        </View>
    );
}
