// THROWAWAY route for the P0 rasterizer spike. Deleted before the wave ends —
// every file under app/ is a reachable deep link, and nothing in P0 ships.
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import CaptureSpike from '@/components/custom/share-stats/CaptureSpike';
import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

export default function ShareStatsSpike() {
    return (
        <View style={{ flex: 1, backgroundColor: '#000000' }} testID="share-stats-spike-screen">
            <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                <CaptureSpike onBack={() => router.back()} />
            </ErrorBoundary>
        </View>
    );
}
