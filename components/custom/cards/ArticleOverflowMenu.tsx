import { GLASS_OVER_CONTENT_FILL, TranslucentPlate } from '@/components/custom/GlassSurface';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AccessibilityInfo,
    Animated,
    Easing,
    LayoutAnimation,
    Modal,
    Platform,
    Pressable,
    View,
    useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Every icon and label in the sheet, the title included (owner, ux2 B6:
 *  uniformity). Only a destructive row differs. */
const SHEET_WHITE = '#FFFFFF';
const DESTRUCTIVE = '#F87171';
/** One slide between levels, both ways. */
export const SHEET_SLIDE_MS = 220;
/** The sheet sliding up from below the screen edge (ease-out). */
export const SHEET_ENTER_MS = 250;
/** Its slide back down (ease-in). The Modal stays shown until it ends. */
export const SHEET_EXIT_MS = 250;
/** If the Modal never reports `onShow`, rise anyway this long after the sheet
 *  has laid out. A safety net: a sheet that never appears is the worst case. */
export const SHEET_PRESENT_FALLBACK_MS = 150;
/** Reduce Motion: a short fade, no slide, both ways. */
const SHEET_FADE_MS = 150;
const SCRIM = 'rgba(0,0,0,0.78)';
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
    const color = destructive ? DESTRUCTIVE : SHEET_WHITE;
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
                    {opensLevel ? <MaterialIcons name="chevron-right" size={22} color={SHEET_WHITE} /> : null}
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
    /** The slide-down has finished and the Modal is hidden (every platform).
     *  Android has no `onDismiss`, so this is its dismissal signal. */
    onExited?: () => void;
    /** The article's headline, as the sheet's title (one line), every level. */
    title?: string;
    /** The publisher's own headline and its language: with `title` (the
     *  English title) these are exactly what the card's title chooses from,
     *  so the sheet shows the headline the card shows. */
    titleOriginal?: string | null;
    titleLanguage?: string | null;
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
 * Levels move together in SHEET_SLIDE_MS: on a push the old level slides out
 * to the left while the new one slides in from the right; Back is the
 * reverse. The outgoing level is a frozen copy of its last render, placed
 * absolutely (the sheet sizes to the incoming level only, and its height eases
 * there on iOS) and untouchable; it unmounts once the slide lands. Without it
 * the sheet showed an empty frame while the new level travelled in. Reduce
 * Motion swaps levels in place.
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
    onExited,
    title,
    titleOriginal,
    titleLanguage,
    onClose,
    levelKey,
    direction,
    onBack,
    children,
}) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const { width, height: windowHeight } = useWindowDimensions();
    const reduceMotion = useReduceMotion();

    // ── Slide up / slide down ──────────────────────────────────────────────
    // The sheet animates itself (never Modal `animationType="slide"`, which
    // would slide the scrim too): the scrim fades while the sheet rises from
    // below the screen edge. The Modal stays SHOWN until the slide-down ends,
    // so native UI an item presents after the dismissal (a browser, the
    // share sheet, the feedback form) is never presented over a leaving sheet.
    //
    // The rise waits until the sheet can be SEEN: the Modal has presented
    // (`onShow`, or a short fallback) and the sheet has laid out. Started any
    // earlier, it ran behind a Modal that was not on screen yet, and the reader
    // saw a fully dark scrim and a sheet already most of the way up. It starts
    // from a FIXED off-screen offset (the window height): the measured height
    // is 0 until onLayout, and switching to it mid-slide made the sheet jump.
    const enter = useRef(new Animated.Value(0)).current;
    const [modalShown, setModalShown] = useState(visible);
    const [presented, setPresented] = useState(false);
    const [laidOut, setLaidOut] = useState(false);
    const onExitedRef = useRef(onExited);
    onExitedRef.current = onExited;
    const canRise = presented && laidOut;
    // Whether this opening ever started to rise. A close before that has
    // nothing on screen to slide down (the sheet is still transparent).
    const rose = useRef(false);
    useEffect(() => {
        if (!visible || presented || !laidOut) return;
        const id = setTimeout(() => setPresented(true), SHEET_PRESENT_FALLBACK_MS);
        return () => clearTimeout(id);
    }, [visible, presented, laidOut]);
    // Rise: once shown AND visible to the reader.
    useLayoutEffect(() => {
        if (!visible) return;
        setModalShown(true);
        if (!canRise) return;
        rose.current = true;
        const anim = Animated.timing(enter, {
            toValue: 1,
            duration: reduceMotion ? SHEET_FADE_MS : SHEET_ENTER_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
        });
        anim.start();
        return () => anim.stop();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, canRise]);
    // Fall: only when `visible` itself turns false (never re-run by the
    // presented/laid-out reset that ends the fall).
    useLayoutEffect(() => {
        if (visible) return;
        const finish = () => {
            setModalShown(false);
            setPresented(false);
            setLaidOut(false);
            onExitedRef.current?.();
        };
        if (!rose.current) {
            finish();
            return;
        }
        rose.current = false;
        const anim = Animated.timing(enter, {
            toValue: 0,
            duration: reduceMotion ? SHEET_FADE_MS : SHEET_EXIT_MS,
            easing: Easing.in(Easing.cubic),
            useNativeDriver: true,
        });
        anim.start(({ finished }) => {
            if (finished) finish();
        });
        return () => anim.stop();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);
    const sheetMotion = reduceMotion
        ? { opacity: laidOut ? enter : 0 }
        : {
              opacity: laidOut ? 1 : 0,
              transform: [
                  {
                      translateY: enter.interpolate({
                          inputRange: [0, 1],
                          outputRange: [windowHeight, 0],
                      }),
                  },
              ],
          };
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
                // transparent, which on Back read as an empty tall sheet for
                // ~100ms before the menu appeared.
                LayoutAnimation.configureNext({
                    duration: SHEET_SLIDE_MS,
                    update: { type: LayoutAnimation.Types.easeInEaseOut },
                });
            }
            sign.current = direction === 'push' ? 1 : -1;
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
        const anim = Animated.timing(progress, { toValue: 1, duration: SHEET_SLIDE_MS, useNativeDriver: true });
        anim.start(({ finished }) => {
            if (finished) setOutgoing(null);
        });
        return () => anim.stop();
    }, [outgoing, progress]);
    const inX = progress.interpolate({ inputRange: [0, 1], outputRange: [sign.current * width, 0] });
    const outX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, -sign.current * width] });

    return (
        <Modal
            visible={modalShown}
            onDismiss={onDismiss}
            transparent
            animationType="none"
            onShow={() => setPresented(true)}
            onRequestClose={onBack ?? onClose}
            statusBarTranslucent
        >
            <Pressable
                accessibilityLabel={t('common.cancel')}
                onPress={onClose}
                style={{ flex: 1, justifyContent: 'flex-end' }}
                testID="article-menu-backdrop"
            >
                <Animated.View
                    testID="article-menu-scrim"
                    pointerEvents="none"
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: SCRIM, opacity: enter }}
                />
                <Animated.View
                    testID="article-menu-sheet"
                    style={[{ width: '100%' }, sheetMotion]}
                    onLayout={() => setLaidOut(true)}
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
                            <View testID="article-menu-title" accessibilityRole="header" className="px-4 pb-2">
                                {title?.trim() ? (
                                    // The card's own title component and fields, so the
                                    // sheet never shows a different headline (the card
                                    // shows the publisher's headline when the article is
                                    // in the reader's language, a translation otherwise).
                                    <TranslatableDynamic
                                        text={title.trim()}
                                        originalText={titleOriginal ?? undefined}
                                        originalLanguage={titleLanguage}
                                        size="sm"
                                        numberOfLines={1}
                                        style={{ color: SHEET_WHITE, fontWeight: '600' }}
                                    />
                                ) : (
                                    <Text
                                        size="sm"
                                        numberOfLines={1}
                                        style={{ color: SHEET_WHITE, fontWeight: '600' }}
                                    >
                                        {t('articleMenu.title')}
                                    </Text>
                                )}
                            </View>
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
                </Animated.View>
            </Pressable>
        </Modal>
    );
};

export default ActionSheet;
