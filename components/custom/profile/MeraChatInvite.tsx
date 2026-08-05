import { GLASS_AVAILABLE, GlassPanel } from '@/components/custom/GlassSurface';
import MeraLogo from '@/components/custom/MeraLogo';
import FreeTierInlineNotice from '@/components/custom/subscription/FreeTierInlineNotice';
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
 * icon. Tapping the row opens the persona chat.
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

    // Mera News Free: this row is the chat entry point, so it can't just
    // vanish (that would read as a bug) or keep opening a chat the
    // floating-chat-store chokepoint would silently no-op — swap in the
    // one-sentence free-tier notice instead, in the same slot.
    if (aiAccess === 'locked') {
        return (
            <View className="mx-4 mb-5">
                <FreeTierInlineNotice surface="chat" />
            </View>
        );
    }

    return (
        <Pressable onPress={openChat} className="mx-4 mb-5">
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
                        fallbackClassName="bg-black"
                        edge={false}
                        style={styles.bubbleBorder}
                    >
                        <Text className="text-white" style={styles.bubbleText}>
                            {t('profile.meraInvite')}
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
        </Pressable>
    );
};

// Tail fallback matches the bubble's opaque `bg-black` fallback; when glass is
// active there's no literal color to sample (GlassPlate is a native blur
// view, not a color), so the tail is tinted with the same faint white lift
// the app's glass surfaces use, instead of staying a pure-black cutout.
const TAIL_COLOR = GLASS_AVAILABLE ? 'rgba(255,255,255,0.14)' : '#000000';

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
