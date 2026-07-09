import { Slot } from 'expo-router';
import { View } from 'react-native';

import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ModelDownloadBanner from '@/components/custom/ModelDownloadBanner';

// Foreground polling, AppState listening, and recoverCycle calls have moved
// to AppScheduler (lib/scheduler/AppScheduler.ts) and its registered tasks:
//   - feed-sync-task.ts   — syncs the feed on a 5-minute cadence + foreground
//   - inference-recover-task.ts — calls recoverCycle on foreground

export default function AppLayout() {
    return (
        <View style={{ flex: 1 }}>
            <ErrorBoundary
                level="screen"
                FallbackComponent={FullScreenErrorFallback}
            >
                <Slot />
            </ErrorBoundary>
            <ModelDownloadBanner />
        </View>
    );
}
