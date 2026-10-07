/**
 * The card grows into the article page (FinalRead #4-6, FinalMotion "Open an
 * article"). Hand-built: Reanimated's shared-element transitions sit behind a
 * compile-time flag (a native rebuild), so this is one root overlay instead.
 *
 *   open   the card measures itself at press-in (`noteCardPress`). On tap,
 *          `growOpen` grows an overlay from that frame to full screen over the
 *          Feed, which is still on screen and sinks on `cardSinkProgress`.
 *          At the end the page is pushed with NO animation (the `grow` route
 *          param picks `animation: 'none'` in app/logged-in/_layout.tsx) and
 *          the overlay leaves on the page's first layout (`cardGrowLanded`).
 *   back   the Back button calls `growBack`: the overlay covers the screen,
 *          the page pops with no animation (the Feed is drawn again), and the
 *          overlay shrinks into the card's re-measured frame.
 *
 * The native edge swipe stays the platform's own pop (owner M4).
 *
 * Order matters: iOS detaches the previous screen once a push lands, so the
 * Feed can only be seen sinking BEFORE the push, never under a mounted page.
 */
import { Image } from 'expo-image';
import React, { useSyncExternalStore } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
    Easing,
    interpolate,
    interpolateColor,
    makeMutable,
    runOnJS,
    useAnimatedStyle,
    withTiming,
} from 'react-native-reanimated';

// ponytail: dev-only until the P0 capture signs it off; P9 un-gates or deletes.
export const CARD_GROW_ENABLED = __DEV__;

const OPEN_MS = 380;
const BACK_MS = 300;
/** A press measured longer ago than this is not the tap being opened. */
const PRESS_FRESH_MS = 1500;
/** If the page never reports its first layout, the overlay still leaves. */
const LAND_FALLBACK_MS = 800;
/** Card hero band (`CARD_HERO_HEIGHT`) and the page's parallax header
 *  (`SCREEN_HEADER_HEIGHT` in ArticleSuggestionContainer). Literal: importing
 *  the container from here would pull the detail screen into the card graph. */
const CARD_IMAGE_HEIGHT = 192;
const PAGE_IMAGE_HEIGHT = 240;
const CARD_RADIUS = 6;
const CARD_SURFACE = 'rgba(255,255,255,0.07)';
const PAGE_SURFACE = '#000000';
const SINK_DIM = 0.4;

type Rect = { x: number; y: number; width: number; height: number };
type Measurable = Pick<View, 'measureInWindow'>;

/** 0 = the card at its slot, 1 = the full page. The Feed sinks on it too. */
export const cardSinkProgress = makeMutable(0);
const rectSV = makeMutable<Rect>({ x: 0, y: 0, width: 0, height: 0 });

let pressed: { id: string; node: Measurable; rect: Rect; imageUrl: string | null; at: number } | null = null;
/** Pages opened by a grow, by suggestion id: where Back shrinks to. */
const launched = new Map<string, { node: Measurable; rect: Rect; imageUrl: string | null }>();

let overlay: { imageUrl: string | null } | null = null;
let landing = false;
let landTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
function setOverlay(next: { imageUrl: string | null } | null) {
    overlay = next;
    listeners.forEach((l) => l());
}

/** The card was pressed: remember its frame for a grow that may follow. */
export function noteCardPress(id: string, node: Measurable | null, imageUrl: string | null): void {
    if (!CARD_GROW_ENABLED || !node) return;
    node.measureInWindow((x, y, width, height) => {
        if (width > 0 && height > 0) pressed = { id, node, rect: { x, y, width, height }, imageUrl, at: Date.now() };
    });
}

/** Open suggestion `id`: grow from its pressed card, then `push(true)`; or
 *  `push(false)` at once when there is no fresh press to grow from. */
export function growOpen(id: string, push: (grew: boolean) => void): void {
    const p = pressed && pressed.id === id && Date.now() - pressed.at < PRESS_FRESH_MS ? pressed : null;
    pressed = null;
    if (!CARD_GROW_ENABLED || !p || overlay) {
        push(false);
        return;
    }
    launched.set(id, { node: p.node, rect: p.rect, imageUrl: p.imageUrl });
    rectSV.value = p.rect;
    cardSinkProgress.value = 0;
    landing = true;
    setOverlay({ imageUrl: p.imageUrl });
    const pushNow = () => {
        push(true);
        landTimer = setTimeout(cardGrowLanded, LAND_FALLBACK_MS);
    };
    cardSinkProgress.value = withTiming(1, { duration: OPEN_MS, easing: Easing.inOut(Easing.ease) }, (done) => {
        if (done) runOnJS(pushNow)();
    });
}

/** The grown page has laid out: the overlay can leave. No-op otherwise. */
export function cardGrowLanded(): void {
    if (!landing) return;
    landing = false;
    if (landTimer) clearTimeout(landTimer);
    landTimer = null;
    setOverlay(null);
    cardSinkProgress.value = 0;
}

/** Back from suggestion `id`: shrink into its card when it grew, else `pop()`. */
export function growBack(id: string, pop: () => void): void {
    const l = launched.get(id);
    launched.delete(id);
    if (!CARD_GROW_ENABLED || !l || overlay) {
        pop();
        return;
    }
    rectSV.value = l.rect;
    cardSinkProgress.value = 1;
    setOverlay({ imageUrl: l.imageUrl });
    pop();
    const shrink = () => {
        cardSinkProgress.value = withTiming(0, { duration: BACK_MS, easing: Easing.inOut(Easing.ease) }, (done) => {
            if (done) runOnJS(setOverlay)(null);
        });
    };
    // Re-measure once the Feed is drawn again; a card virtualised away keeps
    // its old frame.
    requestAnimationFrame(() => {
        let measured = false;
        l.node.measureInWindow((x, y, width, height) => {
            measured = true;
            if (width > 0 && height > 0) rectSV.value = { x, y, width, height };
            shrink();
        });
        setTimeout(() => {
            if (!measured) shrink();
        }, 50);
    });
}

function subscribe(l: () => void) {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
}

/** Mounted once, after the logged-in `<Stack>`: the growing card. */
export function CardGrowHost(): React.ReactElement | null {
    const state = useSyncExternalStore(subscribe, () => overlay);
    const { width: W, height: H } = useWindowDimensions();
    const dimStyle = useAnimatedStyle(() => ({ opacity: cardSinkProgress.value * SINK_DIM }));
    const pageStyle = useAnimatedStyle(() => {
        const p = cardSinkProgress.value;
        const r = rectSV.value;
        return {
            left: interpolate(p, [0, 1], [r.x, 0]),
            top: interpolate(p, [0, 1], [r.y, 0]),
            width: interpolate(p, [0, 1], [r.width, W]),
            height: interpolate(p, [0, 1], [r.height, H]),
            borderRadius: interpolate(p, [0, 1], [CARD_RADIUS, 0]),
            backgroundColor: interpolateColor(p, [0, 1], [CARD_SURFACE, PAGE_SURFACE]),
        };
    });
    const imageStyle = useAnimatedStyle(() => ({
        height: interpolate(cardSinkProgress.value, [0, 1], [CARD_IMAGE_HEIGHT, PAGE_IMAGE_HEIGHT]),
    }));
    if (!state) return null;
    return (
        <View style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#000000' }, dimStyle]} />
            <Animated.View style={[{ position: 'absolute', overflow: 'hidden' }, pageStyle]}>
                {state.imageUrl ? (
                    <Animated.View style={[{ width: '100%' }, imageStyle]}>
                        <Image source={{ uri: state.imageUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
                    </Animated.View>
                ) : null}
            </Animated.View>
        </View>
    );
}

/** The Feed (or any page a card is opened from) sinks to 94% while it grows. */
export function useCardSinkStyle() {
    return useAnimatedStyle(() => ({
        transform: [{ scale: interpolate(cardSinkProgress.value, [0, 1], [1, 0.94]) }],
    }));
}
