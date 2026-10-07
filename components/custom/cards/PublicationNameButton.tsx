import { Pressable } from '@/components/ui/pressable';
import { HStack } from '@/components/ui/hstack';
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useColors } from '@/lib/theme/tokens';

/** Held before the pressed look shows, so a finger that starts a scroll on
 *  the name does not flash it. Same order as ScrollView's own touch delay. */
export const NAME_PRESS_DELAY_MS = 130;
const PRESSED_OPACITY = 0.55;

interface PublicationNameButtonProps {
    /** The publication name as the row already draws it (a Text node). */
    readonly children: React.ReactNode;
    readonly onPress: () => void;
    /** A card passes its own long press (the ••• menu), so a long press on the
     *  name still opens the menu rather than dying on the name. */
    readonly onLongPress?: () => void;
    /**
     * How far the touch target reaches above and below the name's line, in
     * points. The CALLER knows the gaps around its row, so it clamps these to
     * them: the target must never reach the title or the ••• button. The
     * target is exactly as wide as the name.
     */
    readonly hitAbove: number;
    readonly hitBelow: number;
    /**
     * `card`: inside a card root, which is ONE accessibility element. The name
     * is hidden from VoiceOver and TalkBack; the card's "About {source}"
     * custom action reaches the same page.
     * `screen`: on the detail screen, where the name is its own control: a
     * button with `a11yLabel`, and a trailing ⓘ.
     */
    readonly variant: 'card' | 'screen';
    readonly a11yLabel?: string;
    readonly infoColor?: string;
    readonly testID: string;
    readonly style?: StyleProp<ViewStyle>;
}

/**
 * A publication name that opens the publication page. The row's own layout
 * does not move: the target grows by padding that negative margins give back.
 * Pressed state is React state on a static style (a function style is dropped
 * on device).
 */
const PublicationNameButton: React.FC<PublicationNameButtonProps> = ({
    children,
    onPress,
    onLongPress,
    hitAbove,
    hitBelow,
    variant,
    a11yLabel,
    infoColor,
    testID,
    style,
}) => {
    const [pressed, setPressed] = useState(false);
    const colors = useColors();
    const frame: ViewStyle = {
        flexShrink: 1,
        minWidth: 0,
        paddingTop: hitAbove,
        paddingBottom: hitBelow,
        marginTop: -hitAbove,
        marginBottom: -hitBelow,
        justifyContent: 'center',
    };
    const press = {
        onPress,
        onLongPress,
        unstable_pressDelay: NAME_PRESS_DELAY_MS,
        onPressIn: () => setPressed(true),
        onPressOut: () => setPressed(false),
    };
    const dim = pressed ? { opacity: PRESSED_OPACITY } : undefined;

    if (variant === 'card') {
        return (
            <Pressable
                testID={testID}
                {...press}
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[frame, style]}
            >
                <View style={dim}>{children}</View>
            </Pressable>
        );
    }

    // The ⓘ glyph sits UNDER a childless labelled button: a glyph inside a
    // labelled pressable still surfaces on iOS as its own StaticText.
    return (
        <View style={[frame, style]} testID={`${testID}-frame`}>
            <HStack
                space="xs"
                className="items-center"
                style={dim}
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            >
                <View style={{ flexShrink: 1, minWidth: 0 }}>{children}</View>
                <MaterialIcons name="info-outline" size={13} color={infoColor ?? colors.ink2} {...DECORATIVE_ICON_A11Y} />
            </HStack>
            <Pressable
                testID={testID}
                {...press}
                accessibilityRole="button"
                accessibilityLabel={a11yLabel}
                style={StyleSheet.absoluteFill}
            />
        </View>
    );
};

export default PublicationNameButton;
