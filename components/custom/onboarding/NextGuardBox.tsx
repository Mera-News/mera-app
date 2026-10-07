import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, useReducedMotion } from 'react-native-reanimated';

import ModalMaterial from '@/components/custom/ModalMaterial';
import { Button, ButtonText } from '@/components/ui/button';
import { MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';

export interface NextGuardBoxProps {
    open: boolean;
    title: string;
    body: string;
    /** The main choice, filled orange ("Add a fact", "Turn them on"). */
    primaryLabel: string;
    onPrimary: () => void;
    /** The way through, outlined ("Continue anyway", "Not now"). */
    secondaryLabel: string;
    onSecondary: () => void;
    /** Place it: the caller anchors the box just above its Next button. */
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

/**
 * The small box that rises from the Next button instead of letting it through
 * (Journey #14 no facts, #24 no notifications). Two choices, nothing else; it
 * stays until one is picked.
 */
export function NextGuardBox({
    open,
    title,
    body,
    primaryLabel,
    onPrimary,
    secondaryLabel,
    onSecondary,
    style,
    testID,
}: NextGuardBoxProps) {
    const colors = useColors();
    const reduceMotion = useReducedMotion();
    if (!open) return null;
    return (
        <Animated.View
            entering={
                reduceMotion
                    ? FadeIn.duration(MOTION.smallModal.in)
                    : FadeInDown.duration(MOTION.smallModal.in).withInitialValues({ transform: [{ translateY: 12 }] })
            }
            exiting={FadeOut.duration(MOTION.smallModal.out)}
            accessibilityViewIsModal
            testID={testID}
            style={[styles.box, { borderColor: colors.line }, style]}
        >
            <ModalMaterial />
            <View style={styles.inner}>
                <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                    {title}
                </Text>
                <Text style={[styles.body, { color: colors.ink2 }]}>{body}</Text>
                <View style={styles.actions}>
                    <Button
                        variant="outline"
                        action="secondary"
                        onPress={onSecondary}
                        className="flex-1"
                        testID={testID ? `${testID}-secondary` : undefined}
                    >
                        <ButtonText>{secondaryLabel}</ButtonText>
                    </Button>
                    <Button
                        action="primary"
                        onPress={onPrimary}
                        className="flex-1"
                        testID={testID ? `${testID}-primary` : undefined}
                    >
                        <ButtonText>{primaryLabel}</ButtonText>
                    </Button>
                </View>
            </View>
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    box: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
    inner: { padding: 16, gap: 8 },
    title: { fontSize: 16, fontWeight: '700' },
    body: { fontSize: 14, lineHeight: 20 },
    actions: { flexDirection: 'row', gap: 10, marginTop: 8 },
});
