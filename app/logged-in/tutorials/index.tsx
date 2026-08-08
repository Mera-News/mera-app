import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import TutorialsMenuScreen from '@/components/custom/tutorials/TutorialsMenuScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * Routing only. The chapter is passed as a QUERY PARAM to the player route
 * (`?chapter=welcome`) rather than as a `[chapter].tsx` dynamic segment: there
 * is no dynamic-segment precedent anywhere under `app/`, `typedRoutes: true` is
 * on, and `app/logged-in/sources-publishers.tsx` already proves the query-param
 * shape works. No `_layout.tsx` and no `Stack.Screen` declaration is needed —
 * `app/logged-in/preferences/` is the precedent.
 */
export default function Tutorials() {
    return (
        <GluestackUIProvider mode="dark">
            <View style={{ flex: 1 }}>
                {/* Unpadded wrapper so the backdrop spans the safe areas; the
                    content below keeps its insets. Same shape as every other
                    pushed screen in this stack. */}
                <AbstractGradientBackdrop />

                <SafeAreaView testID="tutorials-screen" style={{ flex: 1 }}>
                    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                        <TutorialsMenuScreen
                            onBack={() => router.back()}
                            onOpenChapter={(chapterId) =>
                                router.push(
                                    `/logged-in/tutorials/player?chapter=${chapterId}` as never,
                                )
                            }
                        />
                    </ErrorBoundary>
                </SafeAreaView>
            </View>
        </GluestackUIProvider>
    );
}
