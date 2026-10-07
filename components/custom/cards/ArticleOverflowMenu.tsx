import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { inlineSign, MOTION } from '@/lib/motion';
import { COLORS } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, Easing, LayoutAnimation, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

/** Every icon and label in the sheet (owner, ux2 B6: uniformity). Only a
 *  destructive row differs. */
const SHEET_WHITE = COLORS.dark.ink;
const DESTRUCTIVE = COLORS.dark.negative;
/** One slide between levels, both ways (FinalRead #15). */
export const SHEET_SLIDE_MS = MOTION.supportSubList.duration;
const ROW_STYLE = { minHeight: 48, justifyContent: 'center' } as const;
/** The row label: the SAME class and style on every level of every sheet, so a
 *  pushed level cannot drift from the main ••• rows (batch 11: the old tree
 *  overlay's labels rendered at about a fifth of normal brightness). */
export const SHEET_ROW_LABEL_CLASS = 'text-white';
export const SHEET_ROW_LABEL_STYLE = { fontSize: 15, fontWeight: '600' } as const;
const CANCEL_STYLE = {
    minHeight: 48,
    marginTop: 8,
    marginHorizontal: 8,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
} as const;

export interface ArticleMenuItem {
    /** Stable key; also the VoiceOver custom action name. */
    key: string;
    label: string;
    /** The VoiceOver / TalkBack custom-action name, when the visible label
     *  leans on context the card root does not have ("About this source" on
     *  the sheet reads "About The Hindu" as a card action). */
    a11yLabel?: string;
    /** A MaterialIcons glyph, or a custom node (the Mera mark for Ask). */
    icon: keyof typeof MaterialIcons.glyphMap | React.ReactNode;
    testID: string;
    /** Runs AFTER the menu has closed. Return false (or throw) to report a
     *  failure; the host then offers a retry. */
    run: () => void | boolean | Promise<void | boolean>;
    /** The item navigates WITHIN the sheet (pushes a level) instead of
     *  closing it: it runs at once, never after a dismissal. */
    staysOpen?: boolean;
    /** A trailing chevron: tapping opens another level. */
    opensLevel?: boolean;
    /** A second, smaller line under the label (a level row's contents). */
    subtitle?: string;
}

export interface ActionSheetRowProps {
    label: string;
    icon: keyof typeof MaterialIcons.glyphMap | React.ReactNode;
    testID: string;
    onPress: () => void;
    /** A trailing chevron: this row opens another level. */
    opensLevel?: boolean;
    /** Red icon and label (a destructive confirm). */
    destructive?: boolean;
    /** A small grey line ABOVE the row, read before the tap. */
    description?: string;
    /** A smaller line UNDER the label (what a level row holds). */
    subtitle?: string;
}

/** ONE row style for every level of every sheet: 48pt, accent icon, white
 *  label, optional chevron. */
export const ActionSheetRow: React.FC<ActionSheetRowProps> = ({
    label,
    icon,
    testID,
    onPress,
    opensLevel,
    destructive,
    description,
    subtitle,
}) => {
    const color = destructive ? DESTRUCTIVE : SHEET_WHITE;
    const row = (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={subtitle ? `${label}, ${subtitle}` : label}
            onPress={onPress}
        >
            {/* Layout on an inner View with a STATIC style: a function `style` on
                a Pressable is dropped on device (the css-interop wrapper). */}
            <View style={ROW_STYLE}>
                <HStack className="items-center px-4" space="md">
                    {typeof icon === 'string' ? (
                        <MaterialIcons name={icon as keyof typeof MaterialIcons.glyphMap} size={22} color={color} />
                    ) : (
                        icon
                    )}
                    <VStack className="flex-1">
                        <Text
                            className={SHEET_ROW_LABEL_CLASS}
                            style={destructive ? [SHEET_ROW_LABEL_STYLE, { color: DESTRUCTIVE }] : SHEET_ROW_LABEL_STYLE}
                        >
                            {label}
                        </Text>
                        {subtitle ? (
                            <Text size="xs" numberOfLines={1} style={{ color: COLORS.dark.ink3 }}>
                                {subtitle}
                            </Text>
                        ) : null}
                    </VStack>
                    {opensLevel ? <MaterialIcons name="chevron-right" size={22} color={SHEET_WHITE} /> : null}
                </HStack>
            </View>
        </Pressable>
    );
    if (!description) return row;
    return (
        <VStack space="xs">
            <Text size="xs" className="px-4" style={{ color: COLORS.dark.ink3 }}>
                {description}
            </Text>
            {row}
        </VStack>
    );
};

export interface ActionSheetProps {
    /** The sheet is in the tree: open, OR closing and not yet dismissed. */
    mounted: boolean;
    /** The sheet is showing; false slides it away. */
    visible: boolean;
    /** The sheet has fully gone (iOS: the Modal's onDismiss). */
    onDismiss?: () => void;
    /** The sheet has fully gone (Android, which has no `onDismiss`). */
    onExited?: () => void;
    /** Cancel / scrim / drag down / hardware back: close the whole sheet. */
    onClose: () => void;
    /** Identifies the level on top; a change slides the new level in. */
    levelKey: string;
    /** Which way the last change went: a push slides in from the reading end,
     *  a pop from the other side, 'none' (open, Reduce Motion) swaps in place. */
    direction: 'push' | 'pop' | 'none';
    /** Draw a "← Back" row on top (a pushed level). */
    onBack?: () => void;
    children: React.ReactNode;
}

/**
 * The ••• menu for every article surface and every level it opens (the
 * publisher, Support, the feedback tree and its confirm, the follow levels),
 * on the app's one BottomSheet. A sub-menu is a LEVEL pushed inside the sheet,
 * never a second Modal. No headline (FinalRead #14).
 *
 * Levels move together over MOTION.supportSubList (250 ms ease-out): on a push
 * the old level slides out toward the start of the line while the new one
 * slides in from the reading end (mirrored in RTL); Back is the reverse. The
 * outgoing level is a frozen copy of its last render, placed absolutely (the
 * sheet sizes to the incoming level only, and its height eases there on iOS)
 * and untouchable; it unmounts once the slide lands. Reduce Motion swaps
 * levels in place.
 */
const ActionSheet: React.FC<ActionSheetProps> = (props) =>
    // In the tree only while open or CLOSING: this sits under every card, and
    // a closed menu must cost nothing. It stays mounted through the close so
    // the sheet can report it is gone: an item that presents native UI (a
    // browser, a form) must wait for that, see useArticleMenu.
    props.mounted ? <ActionSheetBody {...props} /> : null;

const ActionSheetBody: React.FC<ActionSheetProps> = ({
    visible,
    onDismiss,
    onExited,
    onClose,
    levelKey,
    direction,
    onBack,
    children,
}) => {
    const { t } = useTranslation();
    const { width } = useWindowDimensions();
    const reduceMotion = useReducedMotion();

    // 0 → 1 over one transition. Incoming: from the side it came from to 0.
    // Outgoing: from 0 to the opposite side.
    const progress = useRef(new Animated.Value(1)).current;
    const lastKey = useRef(levelKey);
    const sign = useRef(1);
    // The level on screen, as last rendered: what slides OUT on the next change.
    const shown = useRef<{ key: string; content: React.ReactNode } | null>(null);
    const [outgoing, setOutgoing] = useState<{ key: string; content: React.ReactNode } | null>(null);

    const content = (
        <VStack space="xs">
            {onBack ? (
                <ActionSheetRow testID="sheet-back" label={t('common.back')} icon="arrow-back" onPress={onBack} />
            ) : null}
            {children}
        </VStack>
    );

    // A new level: ease the height (iOS; Android's LayoutAnimation is off in
    // this app) and move both levels. Detected during render so the first
    // frame of the new level is already offset (no flash at rest).
    if (lastKey.current !== levelKey) {
        lastKey.current = levelKey;
        const animate = !reduceMotion && direction !== 'none';
        if (animate) {
            if (Platform.OS === 'ios') {
                // Height only (`update`), same duration, so it moves IN STEP with
                // the slide. No `create`: that faded the new level up from
                // transparent, which on Back read as an empty tall sheet.
                LayoutAnimation.configureNext({
                    duration: SHEET_SLIDE_MS,
                    update: { type: LayoutAnimation.Types.easeOut },
                });
            }
            sign.current = (direction === 'push' ? 1 : -1) * inlineSign();
            progress.setValue(0);
            setOutgoing(shown.current);
        } else {
            progress.setValue(1);
            setOutgoing(null);
        }
    }
    shown.current = { key: levelKey, content };
    // Started before paint (layout effect), so the slide begins in the same
    // frame as the height change rather than one passive-effect frame later.
    useLayoutEffect(() => {
        if (!outgoing) return;
        const anim = Animated.timing(progress, {
            toValue: 1,
            duration: SHEET_SLIDE_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
        });
        anim.start(({ finished }) => {
            if (finished) setOutgoing(null);
        });
        return () => anim.stop();
    }, [outgoing, progress]);
    const inX = progress.interpolate({ inputRange: [0, 1], outputRange: [sign.current * width, 0] });
    const outX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, -sign.current * width] });

    return (
        <BottomSheet
            open={visible}
            onClose={onClose}
            onClosed={() => {
                onDismiss?.();
                onExited?.();
            }}
            testID="article-menu-sheet"
        >
            <Box className="px-2" testID="article-menu">
                {/* The level viewport CLIPS: on a push to a shorter level the
                    sheet shrinks to the new height while the outgoing rows are
                    still sliding, and unclipped they spill over Cancel. */}
                <View testID="article-menu-viewport" style={{ overflow: 'hidden' }}>
                    <Animated.View
                        key={levelKey}
                        testID="article-menu-level"
                        style={{ transform: [{ translateX: outgoing ? inX : 0 }] }}
                    >
                        {content}
                    </Animated.View>
                    {outgoing ? (
                        <Animated.View
                            key={`out:${outgoing.key}`}
                            testID="article-menu-level-out"
                            pointerEvents="none"
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: [{ translateX: outX }] }}
                        >
                            {outgoing.content}
                        </Animated.View>
                    ) : null}
                </View>
                <Pressable
                    testID="article-menu-cancel"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.cancel')}
                    onPress={onClose}
                >
                    {/* A visible full-width button inside the sheet's inset,
                        label centred. */}
                    <View testID="article-menu-cancel-plate" style={CANCEL_STYLE}>
                        <Text className="text-white" style={{ fontSize: 15, fontWeight: '600', textAlign: 'center' }}>
                            {t('common.cancel')}
                        </Text>
                    </View>
                </Pressable>
            </Box>
        </BottomSheet>
    );
};

export default ActionSheet;
