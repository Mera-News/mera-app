import { GLASS_OVER_CONTENT_FILL, TranslucentPlate } from '@/components/custom/GlassSurface';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AccessibilityInfo,
    Animated,
    LayoutAnimation,
    Modal,
    Platform,
    Pressable,
    View,
    useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ACCENT = '#EDA77E';
const DESTRUCTIVE = '#F87171';
/** One slide between levels, both ways. */
export const SHEET_SLIDE_MS = 220;
const ROW_STYLE = { minHeight: 48, justifyContent: 'center' } as const;
/** The row label: the SAME class and style on every level of every sheet, so a
 *  pushed level cannot drift from the main ••• rows (batch 11: the old tree
 *  overlay's labels rendered at about a fifth of normal brightness). */
export const SHEET_ROW_LABEL_CLASS = 'flex-1 text-white';
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
}

/** The real "Reduce Motion" setting (not `useAnimationsActive`, which is about
 *  a screen being in view). */
function useReduceMotion(): boolean {
    const [reduced, setReduced] = useState(false);
    useEffect(() => {
        let alive = true;
        AccessibilityInfo.isReduceMotionEnabled?.()
            .then((v) => {
                if (alive) setReduced(!!v);
            })
            .catch(() => {});
        const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v: boolean) => setReduced(!!v));
        return () => {
            alive = false;
            sub?.remove?.();
        };
    }, []);
    return reduced;
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
}) => {
    const color = destructive ? DESTRUCTIVE : ACCENT;
    const row = (
        <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
            {/* Layout on an inner View with a STATIC style: a function `style` on
                a Pressable is dropped on device (the css-interop wrapper). */}
            <View style={ROW_STYLE}>
                <HStack className="items-center px-4" space="md">
                    {typeof icon === 'string' ? (
                        <MaterialIcons name={icon as keyof typeof MaterialIcons.glyphMap} size={22} color={color} />
                    ) : (
                        icon
                    )}
                    <Text
                        className={SHEET_ROW_LABEL_CLASS}
                        style={destructive ? [SHEET_ROW_LABEL_STYLE, { color: DESTRUCTIVE }] : SHEET_ROW_LABEL_STYLE}
                    >
                        {label}
                    </Text>
                    {opensLevel ? <MaterialIcons name="chevron-right" size={22} color="rgb(163,163,163)" /> : null}
                </HStack>
            </View>
        </Pressable>
    );
    if (!description) return row;
    return (
        <VStack space="xs">
            <Text size="xs" className="px-4" style={{ color: 'rgb(163,163,163)' }}>
                {description}
            </Text>
            {row}
        </VStack>
    );
};

export interface ActionSheetProps {
    /** The sheet is in the tree: open, OR closing and not yet dismissed. */
    mounted: boolean;
    /** The sheet is showing; false starts the Modal's dismissal. */
    visible: boolean;
    /** The Modal has finished dismissing (iOS only: RN calls it there). */
    onDismiss?: () => void;
    /** The article's headline, as the sheet's title (one line), every level. */
    title?: string;
    /** Cancel / backdrop / hardware back at the root: close the whole sheet. */
    onClose: () => void;
    /** Identifies the level on top; a change slides the new level in. */
    levelKey: string;
    /** Which way the last change went: a push slides in from the right, a pop
     *  from the left, 'none' (open, Reduce Motion) swaps in place. */
    direction: 'push' | 'pop' | 'none';
    /** Draw a "← Back" row on top (a pushed level). */
    onBack?: () => void;
    children: React.ReactNode;
}

/**
 * The shared bottom sheet for every article surface: the ••• menu and every
 * level it opens (the feedback tree, its confirm, the follow levels). ONE
 * Modal, one container, one title, one row style and one Cancel; a sub-menu is
 * a LEVEL pushed inside it, never a second Modal (owner: "clicking on 'I like
 * it' should feel like it's opening a submenu ... back should take the user to
 * the main menu").
 *
 * A pushed level slides in from the right in SHEET_SLIDE_MS and a pop slides
 * in from the left; the sheet's height eases to the new level (iOS). Reduce
 * Motion swaps levels with no slide.
 *
 * A titled sheet over CONTENT, so it carries the dark over-content base (a bare
 * translucent plate over headlines is unreadable), and it has an explicit
 * Cancel (F38).
 */
const ActionSheet: React.FC<ActionSheetProps> = (props) =>
    // In the tree only while open or DISMISSING: this sits under every card,
    // and a closed menu must cost nothing. It stays mounted through the
    // dismissal so the Modal can report `onDismiss`: an item that presents
    // native UI (a browser, a form) must wait for it, see useArticleMenu.
    props.mounted ? <ActionSheetBody {...props} /> : null;

const ActionSheetBody: React.FC<ActionSheetProps> = ({
    visible,
    onDismiss,
    title,
    onClose,
    levelKey,
    direction,
    onBack,
    children,
}) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const reduceMotion = useReduceMotion();
    const slide = useRef(new Animated.Value(0)).current;
    const lastKey = useRef(levelKey);

    // A new level: ease the height (iOS; Android's LayoutAnimation is off in
    // this app) and slide the new content in from the side it came from.
    if (lastKey.current !== levelKey) {
        lastKey.current = levelKey;
        if (!reduceMotion && direction !== 'none') {
            if (Platform.OS === 'ios') {
                LayoutAnimation.configureNext(
                    LayoutAnimation.create(SHEET_SLIDE_MS, 'easeInEaseOut', 'opacity'),
                );
            }
            slide.setValue(direction === 'push' ? width : -width);
        } else {
            slide.setValue(0);
        }
    }
    useEffect(() => {
        Animated.timing(slide, { toValue: 0, duration: SHEET_SLIDE_MS, useNativeDriver: true }).start();
    }, [levelKey, slide]);

    return (
        <Modal
            visible={visible}
            onDismiss={onDismiss}
            transparent
            animationType="fade"
            onRequestClose={onBack ?? onClose}
            statusBarTranslucent
        >
            <Pressable
                accessibilityLabel={t('common.cancel')}
                onPress={onClose}
                style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.78)', justifyContent: 'flex-end' }}
                testID="article-menu-backdrop"
            >
                <Pressable onPress={() => {}} style={{ width: '100%' }} accessible={false}>
                    <Box
                        className="rounded-t-3xl overflow-hidden border-t border-white/10"
                        style={{ backgroundColor: GLASS_OVER_CONTENT_FILL }}
                    >
                        {/* Plate first on an UNPADDED box: the plate absolute-fills its
                            parent's CONTENT box, so padding there leaves an
                            unplated frame. */}
                        <TranslucentPlate />
                        <Box
                            className="px-2 pt-3"
                            // Clear the home indicator: the sheet sits over the tab bar.
                            style={{ paddingBottom: insets.bottom + 12 }}
                            testID="article-menu"
                        >
                            {/* The headline, so the reader knows which story the
                                actions are for; the generic label only when
                                there is none. Same on every level. */}
                            <Text
                                testID="article-menu-title"
                                size="sm"
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                className="px-4 pb-2"
                                style={{ color: 'rgb(212,212,212)', fontWeight: '600' }}
                                accessibilityRole="header"
                            >
                                {title?.trim() ? title.trim() : t('articleMenu.title')}
                            </Text>
                            <Animated.View
                                key={levelKey}
                                testID="article-menu-level"
                                style={{ transform: [{ translateX: slide }] }}
                            >
                                <VStack space="xs">
                                    {onBack ? (
                                        <ActionSheetRow
                                            testID="sheet-back"
                                            label={t('common.back')}
                                            icon="arrow-back"
                                            onPress={onBack}
                                        />
                                    ) : null}
                                    {children}
                                </VStack>
                            </Animated.View>
                            <Pressable
                                testID="article-menu-cancel"
                                accessibilityRole="button"
                                accessibilityLabel={t('common.cancel')}
                                onPress={onClose}
                            >
                                {/* A visible full-width button inside the sheet's
                                    inset, label centred. */}
                                <View testID="article-menu-cancel-plate" style={CANCEL_STYLE}>
                                    <Text className="text-white" style={{ fontSize: 15, fontWeight: '600', textAlign: 'center' }}>
                                        {t('common.cancel')}
                                    </Text>
                                </View>
                            </Pressable>
                        </Box>
                    </Box>
                </Pressable>
            </Pressable>
        </Modal>
    );
};

export default ActionSheet;
