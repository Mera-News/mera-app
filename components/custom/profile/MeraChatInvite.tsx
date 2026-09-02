import { GlassPanel } from '@/components/custom/GlassSurface';
import MeraLogo from '@/components/custom/MeraLogo';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { hapticMedium } from '@/lib/haptics';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { useAiAccess } from '@/lib/stores/subscription-store';
import { subscribeScrollTick } from '@/lib/visibility-tick';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

const PRIMARY = 'rgb(231, 138, 83)';
const LOGO_SIZE = 56;

/**
 * Static, in-flow Mera CTA on the Profile tab — a comic speech bubble on the
 * left with the Mera logo on the right, reading as dialogue coming out of the
 * icon. Tapping the row opens the persona chat — except on Mera News Free,
 * where the same row renders inert and Mera says the free-tier sentence
 * instead (see the `locked` branch below).
 *
 * Replaces the former draggable FloatingMeraBubble (removed from ProfileTabScreen
 * in this wave). Because ChatPopover morphs the chat open from the store's
 * `bubbleCenter`, this row now owns publishing that center — the logo wrapper
 * measures its on-screen position and calls `setBubbleCenter` on layout, focus,
 * and each throttled scroll tick, so the popover always animates out of the logo
 * rather than the top-left corner.
 */
const MeraChatInvite: React.FC = () => {
    const { t } = useTranslation();
    const iconRef = useRef<View>(null);
    const aiAccess = useAiAccess();

    const publishCenter = useCallback(() => {
        iconRef.current?.measureInWindow((x, y, w, h) => {
            if (w === 0 && h === 0) return; // not laid out yet
            useFloatingChatStore.getState().setBubbleCenter({ x: x + w / 2, y: y + h / 2 });
        });
    }, []);

    // Re-measure on focus (tab switch back) and on every throttled scroll tick
    // (ProfileScreen wires notifyScrollTick) so the morph origin tracks the row's
    // current on-screen position even after scrolling.
    useFocusEffect(useCallback(() => { publishCenter(); }, [publishCenter]));
    useEffect(() => subscribeScrollTick(publishCenter), [publishCenter]);

    const openChat = useCallback(() => {
        void hapticMedium();
        publishCenter(); // freshest origin right before the morph
        useFloatingChatStore.getState().expand({ kind: 'persona' });
    }, [publishCenter]);

    // Mera News Free: the row itself is UNCHANGED — same speech bubble, same
    // animated logo, same layout an entitled user sees. Only the copy differs:
    // Mera says the free-tier paragraph instead of the invite, so the mode is
    // explained in Mera's own voice rather than by a different-looking card
    // appearing where the invite used to be.
    //
    // Tapping now opens the CHAT in both states. It previously opened the
    // paywall, because `FloatingChatHost` rendered nothing when locked and the
    // morph would have targeted a popover that was not mounted. The host now
    // mounts in every state, so that constraint is gone — and the chat is the
    // better destination: the popup opens on the persona opener, which explains
    // the tier and offers "See plans" as its single action. Going straight to a
    // purchase sheet from a speech bubble skipped the explanation.
    const locked = aiAccess === 'locked';

    const content = (
        <HStack className="items-center" space="md">
            {/* Speech bubble (left) — comic dialogue coming out of the logo. Glass
                bubble body; the tail sits OUTSIDE the panel (a sibling, not a
                child) because GlassPlate's clipping parent would cut off the
                tail's -6px overflow otherwise. */}
            <View className="flex-1" style={styles.bubbleWrap}>
                <GlassPanel
                    className="flex-1"
                    radius={16}
                    contentClassName="px-3.5 py-3"
                    edge={false}
                    style={styles.bubbleBorder}
                >
                    {/* Same node either way, only the string differs. Locked,
                        Mera explains the mode in her own first-person voice
                        (what stays, what she can't do, how to switch her back
                        on); entitled, it's the ordinary invite. Both are
                        phrased so they hold for a user who has saved and
                        followed nothing — see the note on freeTier.cardBody. */}
                    <Text
                        testID={locked ? 'mera-chat-invite-bubble-locked' : undefined}
                        className="text-white"
                        style={styles.bubbleText}
                    >
                        {t(locked ? 'freeTier.chatBubble' : 'profile.meraInvite')}
                    </Text>
                </GlassPanel>
                {/* Right-edge tail pointing at the logo (rotated square whose
                    top+right bordered edges form the arrow). Not glass itself —
                    a rotated 12px diamond is too small to host a clean GlassPlate
                    — tinted to read as part of the glass bubble instead of a
                    pure-black cutout when glass is active. */}
                <View style={styles.tail} />
            </View>

            {/* Mera logo (right). */}
            <View ref={iconRef} onLayout={publishCenter} style={styles.icon}>
                <MeraLogo size={LOGO_SIZE} animated />
            </View>
        </HStack>
    );

    // The measured `bubbleCenter` keeps being published while locked. It costs
    // one store write nothing currently reads (ChatPopover is unmounted), and
    // it means the morph origin is already correct the instant a purchase
    // unlocks the chat, with no first-tap-from-the-corner artefact.
    //
    // Both branches are a Pressable, so the row keeps its press feedback in
    // either state; only the destination differs. The locked testID stays
    // `mera-chat-invite-locked` — it is what the free-tier tests key on to tell
    // the two states apart, and both are now pressable.
    return (
        <Pressable
            testID={locked ? 'mera-chat-invite-locked' : 'mera-chat-invite'}
            onPress={openChat}
            className="mx-4 mb-5"
        >
            {content}
        </Pressable>
    );
};

// The tail is a rotated 12px diamond — too small to host its own plate — so it
// carries a literal colour matching the bubble's faint white lift.
//
// It used to fall back to opaque `#000000` off iOS 26, on the premise that the
// bubble did too via `GlassPanel`'s `fallbackClassName="bg-black"`. That premise
// has been stale for a while: `GlassPanel` documents `fallbackClassName` as
// deprecated AND IGNORED, and paints a `TranslucentPlate` on every platform. So
// the black tail was a black notch hanging off a translucent bubble everywhere
// except iOS 26. One constant now, matching the bubble on every platform.
const TAIL_COLOR = 'rgba(255,255,255,0.14)';

const styles = StyleSheet.create({
    bubbleWrap: {
        position: 'relative',
    },
    bubbleBorder: {
        borderWidth: 1,
        borderColor: PRIMARY,
    },
    bubbleText: {
        fontSize: 14,
        lineHeight: 19,
        fontWeight: '500',
    },
    tail: {
        position: 'absolute',
        right: -6,
        top: '50%',
        marginTop: -6,
        width: 12,
        height: 12,
        backgroundColor: TAIL_COLOR,
        borderTopWidth: 1,
        borderRightWidth: 1,
        borderColor: PRIMARY,
        transform: [{ rotate: '45deg' }],
    },
    icon: {
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export default MeraChatInvite;
