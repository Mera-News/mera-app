import MeraLogo from '@/components/custom/MeraLogo';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { hapticMedium } from '@/lib/haptics';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
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

    return (
        <Pressable onPress={openChat} className="mx-4 mb-5">
            <HStack className="items-center" space="md">
                {/* Speech bubble (left) — comic dialogue coming out of the logo. */}
                <View className="flex-1" style={styles.bubble}>
                    <Text className="text-white" style={styles.bubbleText}>
                        {t('profile.meraInvite')}
                    </Text>
                    {/* Right-edge tail pointing at the logo (rotated square whose
                        top+right bordered edges form the arrow). */}
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

const styles = StyleSheet.create({
    bubble: {
        position: 'relative',
        backgroundColor: '#000000',
        borderWidth: 1,
        borderColor: PRIMARY,
        borderRadius: 16,
        paddingHorizontal: 14,
        paddingVertical: 12,
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
        backgroundColor: '#000000',
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
