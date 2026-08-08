import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { hapticMedium } from '@/lib/haptics';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { useAiAccess } from '@/lib/stores/subscription-store';
import { useUserStore } from '@/lib/stores/user-store';
import type { ChapterId } from '@/lib/tutorials/types';
import { TUTORIAL_ACCENT, TUTORIAL_ACCENT_EDGE, TUTORIAL_ACCENT_SOFT } from './theme';
import { useTutorialCopy } from './use-tutorial-copy';

interface AskMeraButtonProps {
    readonly chapterId: ChapterId;
    readonly slideId: string;
    /** Resolved prefill — the question this slide seeds the chat with. */
    readonly prefill: string;
    /** Closes the tutorial so the popover is not covered by the pushed route. */
    readonly onClose: () => void;
}

/**
 * "Ask Mera" on a tutorial slide.
 *
 * ⚠️ THE CONTEXT KIND IS LOAD-BEARING. It must be `{ kind: 'generic' }`, never
 * `{ kind: 'persona' }`. `PersonaUpdateAgent`'s prompt tells it to stay on
 * profile topics and redirect anything else, AND mandates a `saveExtractedFacts`
 * call on every turn — so a tutorial question ("what is the Explore tab for?")
 * would be politely deflected *and* would silently mutate the user's profile.
 * It fails invisibly: the popover morphs, a reply streams, it is simply the
 * wrong agent. `agent-registry.ts` routes `'generic'` to `TutorialHelpAgent`,
 * which has no tools at all.
 *
 * ⚠️ The morph origin is also load-bearing. `bubbleCenter` defaults to
 * `{x:0, y:0}` and nothing else on this screen publishes it, so without the
 * `measureInWindow` below `ChatPopover` expands out of the top-left corner.
 * Precedent: `components/custom/profile/MeraChatInvite.tsx:38-49`.
 *
 * ⚠️ NOT RENDERED WITHOUT A SESSION, and the check lives HERE rather than in the
 * host. The login-screen Modal passes `enableAskMera={false}`, but that prop
 * only covers the host that remembers to pass it — and the tutorials are a
 * TOP-LEVEL route now (`app/tutorials/`), reachable signed out from the paywall
 * and from anywhere else an entry point is added later. Signed out,
 * `deriveAiAccess` returns `'unknown'` (no server tier, an ANONYMOUS
 * CustomerInfo), not `'locked'`, so the `aiAccess` guard below lets the button
 * through — and outside `/logged-in` there is no `FloatingChatHost` to render
 * the popover, so the press would open the chat store and paint nothing at all.
 * A dead button is the worst of the three options, hence the local-identity
 * check: absent user id ⇒ no affordance.
 *
 * Also hidden on the free tier, where the chat host renders nothing and the
 * morph would target an unmounted popover.
 */
const AskMeraButton: React.FC<AskMeraButtonProps> = ({
    chapterId,
    slideId,
    prefill,
    onClose,
}) => {
    const t = useTutorialCopy();
    const anchorRef = useRef<View>(null);
    const aiAccess = useAiAccess();
    // Local identity, not `authClient.useSession()` — same rule as the rest of
    // the app: the persisted id is what survives a /get-session that cannot be
    // reached, and a signed-in reader must not lose Ask Mera to a flaky network.
    const userId = useUserStore((s) => s.userId);

    const handlePress = useCallback(() => {
        void hapticMedium();
        const open = () => {
            useFloatingChatStore.getState().openArticleFeedback(
                { kind: 'generic', route: `tutorials/${chapterId}/${slideId}` },
                prefill,
            );
            // The popover is a sibling of the logged-in <Stack>, so it paints
            // ABOVE this pushed route — but leaving the tutorial on screen
            // underneath is disorienting, and the user came here to ask, not to
            // keep reading. Closing after the open() keeps the measured origin
            // valid for the morph.
            onClose();
        };

        anchorRef.current?.measureInWindow((x, y, w, h) => {
            if (w > 0 || h > 0) {
                useFloatingChatStore
                    .getState()
                    .setBubbleCenter({ x: x + w / 2, y: y + h / 2 });
            }
            open();
        });

        // measureInWindow's callback is async and does not fire for an unmounted
        // or zero-sized view. Nothing else would open the chat in that case, so
        // there is no fallback here on purpose: a chat that opens from the corner
        // is worse than a button that did nothing on one unlucky tap, and the
        // next tap measures fine.
    }, [chapterId, slideId, prefill, onClose]);

    if (!userId || aiAccess === 'locked') return null;

    return (
        <View ref={anchorRef} style={styles.anchor}>
            <Pressable
                testID="tutorial-ask-mera"
                onPress={handlePress}
                accessibilityRole="button"
                accessibilityLabel={t('tutorials.askMera')}
                style={styles.button}
            >
                <MaterialIcons name="chat-bubble-outline" size={16} color={TUTORIAL_ACCENT} />
                <Text style={styles.label}>{t('tutorials.askMera')}</Text>
            </Pressable>
        </View>
    );
};

const styles = StyleSheet.create({
    anchor: {
        alignSelf: 'flex-start',
    },
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: TUTORIAL_ACCENT_EDGE,
        backgroundColor: TUTORIAL_ACCENT_SOFT,
        paddingHorizontal: 14,
        paddingVertical: 9,
    },
    label: {
        color: TUTORIAL_ACCENT,
        fontSize: 13,
        fontWeight: '600',
    },
});

export default AskMeraButton;
