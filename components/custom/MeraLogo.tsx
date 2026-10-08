import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, ClipPath, G, Path, Rect } from 'react-native-svg';
import Animated, {
    cancelAnimation,
    Easing,
    makeMutable,
    useAnimatedStyle,
    withRepeat,
    withSequence,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';

import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import { loopRuns, useMotionAllowed } from '@/lib/motion-gate';
import { useColors } from '@/lib/theme/tokens';

// The Mera mark. Static callers get ONE Svg, exactly as before. A mark that
// moves (`animated` cone, `scrollCards` grid) is drawn as three layers so the
// motion is a VIEW transform composited on the UI thread, never a per-frame
// SVG redraw (RNSVG rasterises on the CPU, so animating a <G> re-drew the whole
// glyph every frame):
//   1. the card grid, in a rectangular clip, translated as a view;
//   2. one still Svg: hexagon, highlighted card, focus dot;
//   3. the cone, in its own Svg, rotated as a view about its apex.
// Why the layers look identical to the single Svg:
// - The cards' rows (y 330-710) sit inside the hexagon's vertical edges
//   (y 304-720), so a rectangle at x 279-745 clips them exactly like the
//   hexagon does; anything at its edge is under the 24-unit outline stroke.
// - The cone stays inside the hexagon at +-15 degrees, so it needs no clip.
//   It turns about its apex by translate-rotate-translate, NOT `transformOrigin`:
//   on device a percentage origin ("83.88%") put the pivot several glyph
//   heights below the mark, so the cone flew out of its box and left none
//   in the hexagon at all.
// - Cone and grid share the glyph's one ink colour, so drawing the cone above
//   the opaque highlighted card and dot, and the 0.18 grid below the opaque
//   outline, changes no pixel.

const VB_X = 255;
const VB_Y = 146;
const VB_W = 514;
const VB_H = 732;
const VIEW_BOX = `${VB_X} ${VB_Y} ${VB_W} ${VB_H}`;
const HEX_D = 'M512 170 L745 304 L745 720 L512 854 L279 720 L279 304 Z';
/** The background card grid: 150x110 cards on a 170 pitch, three rows. */
const CARD_ROWS = [330, 465, 600] as const;
const CARD_PITCH = 170;
/** Still grid: the three columns the static glyph has always drawn. */
const STILL_CARD_COLUMNS = [320, 490, 660] as const;
/** Scrolling grid: one extra column each side, so moving it one pitch left
 *  lands on the starting picture and the loop wraps without a seam. */
const SCROLL_CARD_COLUMNS = [150, 320, 490, 660, 830] as const;
/** One card pitch every 3.2s: deliberately not a multiple of the cone's 4s
 *  sweep, so the two never lock into a visible beat. */
const CARD_SCROLL_MS = 3200;
const SWEEP_HALF_MS = 2000;
const SWEEP_DEG = 15;
const SPOTLIGHT_D = 'M512 760 L450 485 L574 485 Z';
/** How far below the view's centre the cone apex (512, 760) sits, as a
 *  fraction of the view's size. `meet` centres the glyph horizontally, which
 *  puts x=512 at exactly the centre of a square view, so only y is off. */
const APEX_BELOW_CENTRE = (760 - VB_Y) / VB_H - 0.5;
/** The cards' clip rectangle, in viewBox units. */
const CLIP = { x0: 279, x1: 745, y0: 304, y1: 720 } as const;

// ── One clock for every mark ────────────────────────────────────────────────
// Every moving mark reads the SAME two shared values, so all marks on screen
// are in phase and a remount (a tab switch) never restarts the sweep. The
// clock runs only while at least one mark that may move is on screen: each
// one holds a reference while its gate is open (focused, foregrounded, not
// Lite, not Reduce Motion). The last release pauses it where it is and the
// next first acquire resumes from there. Created lazily: suites that mock
// reanimated without `makeMutable` only meet it when a moving mark mounts.

type Clock = { value: SharedValue<number> | null; users: number; start: (v: SharedValue<number>) => void };

const sweepEase = Easing.inOut(Easing.ease);

const coneClock: Clock = {
    value: null,
    users: 0,
    start: (v) => {
        // Finish the half-sweep it was paused in, then loop.
        const to = v.value <= 0 ? SWEEP_DEG : -SWEEP_DEG;
        const rest = (Math.abs(to - v.value) / (2 * SWEEP_DEG)) * SWEEP_HALF_MS;
        const back = withTiming(-to, { duration: SWEEP_HALF_MS, easing: sweepEase });
        const forth = withTiming(to, { duration: SWEEP_HALF_MS, easing: sweepEase });
        v.value = withSequence(
            withTiming(to, { duration: rest, easing: sweepEase }),
            withRepeat(withSequence(back, forth), -1),
        );
    },
};

const cardClock: Clock = {
    value: null,
    users: 0,
    start: (v) => {
        const rest = ((CARD_PITCH + v.value) / CARD_PITCH) * CARD_SCROLL_MS;
        v.value = withSequence(
            withTiming(-CARD_PITCH, { duration: rest, easing: Easing.linear }),
            withRepeat(
                withSequence(
                    withTiming(0, { duration: 0 }),
                    withTiming(-CARD_PITCH, { duration: CARD_SCROLL_MS, easing: Easing.linear }),
                ),
                -1,
            ),
        );
    },
};

function clockValue(clock: Clock, initial: number): SharedValue<number> {
    if (!clock.value) clock.value = makeMutable(initial);
    return clock.value;
}

/** Holds the clock while `on`; returns its shared value. */
function useClock(clock: Clock, initial: number, on: boolean): SharedValue<number> {
    const value = clockValue(clock, initial);
    useEffect(() => {
        if (!on) return;
        clock.users += 1;
        if (clock.users === 1) clock.start(value);
        return () => {
            clock.users -= 1;
            if (clock.users === 0) cancelAnimation(value);
        };
    }, [clock, value, on]);
    return value;
}

// ── Static pieces ───────────────────────────────────────────────────────────

const CardGrid: React.FC<{ columns: readonly number[] }> = ({ columns }) => (
    <>
        {CARD_ROWS.map((y) =>
            columns.map((x) => <Rect key={`${x}-${y}`} x={`${x}`} y={`${y}`} width="150" height="110" rx="14" />),
        )}
    </>
);

const StillCards: React.FC<{ color: string }> = ({ color }) => (
    <G fill="none" stroke={color} strokeOpacity="0.18" strokeWidth="10">
        <CardGrid columns={STILL_CARD_COLUMNS} />
    </G>
);

/** The frozen -15 degree cone. */
const StaticSpotlight: React.FC<{ color: string }> = ({ color }) => (
    <G transform="rotate(-15 512 760)">
        <Path d={SPOTLIGHT_D} fill={color} opacity="0.300" />
    </G>
);

const Highlight: React.FC<{ color: string }> = ({ color }) => (
    <>
        <Rect x="490" y="465" width="150" height="110" rx="14" fill="none" stroke={color} strokeWidth="16" />
        <Circle cx="512" cy="748" r="16" fill={color} />
    </>
);

// ── The layered, moving mark ────────────────────────────────────────────────

interface LayeredProps {
    size: number;
    color: string;
    cone: boolean;
    cards: boolean;
    /** The caller wants it still (the kit gallery's frozen tile). */
    still: boolean;
}

/** The layered mark. Exported only for the P2 kit gallery's frozen tile (it
 *  passes `still`); everything else goes through `MeraLogo`. */
export const LayeredMark: React.FC<LayeredProps> = ({ size, color, cone, cards, still }) => {
    const active = useAnimationsActive();
    const motion = useMotionAllowed();
    // Lite = no motion, even while it shows work in progress: a text line
    // beside it says so.
    const moving = loopRuns(active, motion, still);
    const angle = useClock(coneClock, -SWEEP_DEG, cone && moving);
    const offset = useClock(cardClock, 0, cards && moving);

    // A view turns about its centre: shift the apex to the centre, turn, shift
    // back.
    const apex = APEX_BELOW_CENTRE * size;
    const coneStyle = useAnimatedStyle(() => ({
        transform: [
            { translateY: apex },
            { rotate: `${cone && moving ? angle.value : -SWEEP_DEG}deg` },
            { translateY: -apex },
        ],
    }));
    // viewBox units to points: `meet` scales by the taller side.
    const k = size / VB_H;
    const padX = (size - VB_W * k) / 2;
    const clip = {
        left: padX + (CLIP.x0 - VB_X) * k,
        top: (CLIP.y0 - VB_Y) * k,
        width: (CLIP.x1 - CLIP.x0) * k,
        height: (CLIP.y1 - CLIP.y0) * k,
    };
    const cardsStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: cards && moving ? offset.value * k : 0 }],
    }));
    const box = { width: size, height: size };

    return (
        <View style={box}>
            {cards && (
                <View style={[styles.abs, styles.clip, clip]}>
                    <Animated.View style={[{ width: size, height: size, left: -clip.left, top: -clip.top }, cardsStyle]}>
                        <Svg width={size} height={size} viewBox={VIEW_BOX}>
                            <G fill="none" stroke={color} strokeOpacity="0.18" strokeWidth="10">
                                <CardGrid columns={moving ? SCROLL_CARD_COLUMNS : STILL_CARD_COLUMNS} />
                            </G>
                        </Svg>
                    </Animated.View>
                </View>
            )}
            <Svg style={styles.abs} width={size} height={size} viewBox={VIEW_BOX}>
                <Path d={HEX_D} fill="none" stroke={color} strokeWidth="24" strokeLinejoin="round" />
                <ClipPath id="hexB">
                    <Path d={HEX_D} />
                </ClipPath>
                <G clipPath="url(#hexB)">
                    {!cards && <StillCards color={color} />}
                    {!cone && <StaticSpotlight color={color} />}
                    <Highlight color={color} />
                </G>
            </Svg>
            {cone && (
                <Animated.View style={[styles.abs, box, coneStyle]}>
                    <Svg width={size} height={size} viewBox={VIEW_BOX}>
                        <Path d={SPOTLIGHT_D} fill={color} opacity="0.300" />
                    </Svg>
                </Animated.View>
            )}
        </View>
    );
};

interface MeraLogoProps {
    size?: number;
    /**
     * The cone sweeps left and right on the shared clock. Default false: one
     * still Svg with no reanimated involvement (every icon, sheet and brand
     * call site). Holds still while off screen, in Lite mode and under
     * Reduce Motion (useMotionAllowed).
     */
    animated?: boolean;
    /** Ink for every stroke and fill. Default: the theme's ink (white in dark,
     *  near-black in light). Pass one for a ground that is not the page (the
     *  Mera button's disc, the article image placeholder). */
    color?: string;
    /** Scroll the background cards right to left on the shared clock (news
     *  passing under the torch). Same gates as `animated`. */
    scrollCards?: boolean;
}

// The viewBox is tightened to the glyph bounds (hexagon x 279-745 / y 170-854
// plus the 24-unit stroke outset) so a given `size` renders at a visual height
// consistent with neighbouring lucide icons.
const MeraLogo: React.FC<MeraLogoProps> = ({
    size = 80,
    animated = false,
    color,
    scrollCards = false,
}) => {
    const colors = useColors();
    const mark = color ?? colors.ink;
    if (animated || scrollCards) {
        return (
            <LayeredMark
                size={size}
                color={mark}
                cone={animated}
                cards={scrollCards}
                still={false}
            />
        );
    }
    return (
        <Svg width={size} height={size} viewBox={VIEW_BOX}>
            <Path d={HEX_D} fill="none" stroke={mark} strokeWidth="24" strokeLinejoin="round" />
            <ClipPath id="hexB">
                <Path d={HEX_D} />
            </ClipPath>
            <G clipPath="url(#hexB)">
                <StillCards color={mark} />
                <StaticSpotlight color={mark} />
                <Highlight color={mark} />
            </G>
        </Svg>
    );
};

const styles = StyleSheet.create({
    abs: { position: 'absolute', left: 0, top: 0 },
    clip: { overflow: 'hidden' },
});

export default MeraLogo;
