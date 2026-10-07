import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import SystemCheckStage from '@/components/custom/system-check/SystemCheckStage';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// The system check again, from Settings > Display. Same stage a new install
// sees before sign-in; Continue returns to Settings.
export default function SystemCheck() {
    return (
        <GluestackUIProvider>
            <View style={{ flex: 1 }}>
                <AbstractGradientBackdrop />
                <SafeAreaView style={{ flex: 1 }}>
                    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                        <SystemCheckStage onContinue={() => router.back()} testID="settings-system-check" />
                    </ErrorBoundary>
                </SafeAreaView>
            </View>
        </GluestackUIProvider>
    );
}
