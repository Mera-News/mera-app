import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import TutorialPlayer from '@/components/custom/tutorials/TutorialPlayer';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { PRE_AUTH_CHAPTER_ID } from '@/lib/tutorials/chapters';
import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

/**
 * Routing only.
 *
 * A PUSHED ROUTE rather than a Modal, deliberately: `FloatingChatHost` is
 * mounted as a sibling AFTER `<Stack>` in `app/logged-in/_layout.tsx`, and an
 * RN Modal is a separate native window that would paint above it — so "Ask
 * Mera" from inside a Modal would expand the chat popover invisibly behind the
 * tutorial. A pushed route also gets the back gesture and the stack's
 * `slide_from_right` for free. The PRE-auth host is a Modal for the opposite
 * reason (no stack to push onto); see `TutorialModalHost`.
 *
 * ⚠️ TOP-LEVEL, NOT UNDER `/logged-in` — see `./index.tsx` for why. It is pushed
 * onto the ROOT stack now, so when it is opened from inside the app the
 * logged-in tree (and its `FloatingChatHost`) stays mounted below it. That
 * placement is exactly why the host does NOT simply paint above this route:
 * `/tutorials` (menu) and `/tutorials/player` are TWO stacked screens, both
 * above the entire `/logged-in` subtree — the plain `router.back()` below only
 * pops this one, leaving the opaque menu covering the popover. `AskMeraButton`
 * does not use this `onClose` prop at all; it calls `router.dismissAll()`
 * itself to clear both routes at once before opening the chat. This `onClose`
 * remains for the ordinary close ("X") and finish (last-slide "Done") paths,
 * which should only pop back to the tutorials menu, not exit the whole group.
 *
 * No `SafeAreaView` here: the player reads the insets itself, because the
 * pre-auth Modal host has no SafeAreaView to inherit from and both hosts must
 * lay out identically.
 */
export default function TutorialPlayerRoute() {
    const params = useLocalSearchParams<{ chapter?: string }>();

    return (
        <GluestackUIProvider mode="dark">
            <View style={{ flex: 1 }}>
                <AbstractGradientBackdrop />

                <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
                    <TutorialPlayer
                        chapterId={params.chapter ?? PRE_AUTH_CHAPTER_ID}
                        onClose={() => router.back()}
                    />
                </ErrorBoundary>
            </View>
        </GluestackUIProvider>
    );
}
