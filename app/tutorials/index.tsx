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
 *
 * ⚠️ TOP-LEVEL, NOT UNDER `/logged-in`. Owner's instruction: an unauthed reader
 * must be able to learn everything about Mera, so this flow may not sit behind
 * the session gate. Moving it out costs nothing, because nothing under
 * `app/logged-in/_layout.tsx` was ever required here — the tutorials read only
 * the settings KV (`lib/stores/tutorials-store.ts`), never Apollo, never the
 * session. It also means the PIN lock does not cover this route, which is
 * correct: there is no user data on it.
 *
 * The one thing that IS in the logged-in layout and matters is
 * `FloatingChatHost`. Pushed from inside the app the host is still mounted
 * underneath in the root stack, so "Ask Mera" works exactly as before; signed
 * out there is no host, which is why `AskMeraButton` self-gates on the local
 * identity rather than trusting its host.
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
                                    `/tutorials/player?chapter=${chapterId}` as never,
                                )
                            }
                        />
                    </ErrorBoundary>
                </SafeAreaView>
            </View>
        </GluestackUIProvider>
    );
}
