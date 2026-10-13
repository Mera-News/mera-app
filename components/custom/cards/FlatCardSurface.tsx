import { CARDS_USE_GLASS, CardGlassPlate } from '@/components/custom/cards/CardGlassPlate';
import { Box } from '@/components/ui/box';
import { MOTION } from '@/lib/motion';
import { tint, useColors } from '@/lib/theme/tokens';
import React from 'react';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

interface FlatCardSurfaceProps {
    /** Outer spacing (margins) for the host's list; the surface itself is fixed. */
    className?: string;
    /** The new-card halo: an orange glow while on, fading out when it turns false. */
    halo?: boolean;
    children: React.ReactNode;
}

/** Rounded-2xl at this app's 14pt rem; the shadow layers follow the surface. */
const RADIUS = 14;

/**
 * The card's resting shadow, as a CSS `boxShadow`, never the `shadow-hard-2`
 * class. NativeWind turns that class into `elevation` on Android, and Android
 * draws an elevation shadow UNDER the whole view, so it showed THROUGH the
 * translucent plate as a square-cornered box inside the card (light theme; the
 * dark grey shadow vanishes on the dark page). An outset `boxShadow` is drawn
 * only outside the border box, so nothing ever sits under the plate.
 */
const RESTING_SHADOW = '0px 3px 10px 0px rgba(38, 38, 38, 0.20)';

/** A new card's orange shadow (FinalMotion "Signals"): fades away over 600 ms
 *  once the card counts as seen, leaving the resting grey one. A layer BEHIND
 *  the surface, outside its clip, so it renders the same on iOS and Android
 *  (an Android elevation shadow ignores most of a shadow colour). */
const CardHalo: React.FC<{ on: boolean }> = ({ on }) => {
    const colors = useColors();
    const opacity = useSharedValue(on ? 1 : 0);
    React.useEffect(() => {
        opacity.value = withTiming(on ? 1 : 0, { duration: MOTION.halo.fade, easing: Easing.out(Easing.ease) });
    }, [on, opacity]);
    const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
    return (
        <Animated.View
            pointerEvents="none"
            testID="card-halo"
            style={[
                {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    borderRadius: RADIUS,
                    boxShadow: `0px 2px 14px 1px ${tint(colors.accent, 0.55)}`,
                },
                style,
            ]}
        />
    );
};

/**
 * The Dashboard's floating card surface, in ONE place: the article cards'
 * `flat` treatment (ArticleCardBase) and the followed-story rows
 * (TrackedStoriesScreen) both draw it, so they cannot drift apart (owner:
 * "make these cards similar to the translucent cards like the article cards").
 *
 * The translucent plate sits over the page BACKDROP, never over other
 * content, so it needs no opaque base under it.
 *
 * Shadow and halo live on the outer, non-clipping Box: a view's shadow is cut
 * off the moment that same view also sets `overflow: hidden`, so the rounded,
 * clipped surface (border + plate + content) has to be a separate inner Box.
 */
const FlatCardSurface: React.FC<FlatCardSurfaceProps> = ({ className, halo, children }) => (
    <Box
        className={`rounded-2xl${className ? ` ${className}` : ''}`}
        style={{ borderRadius: RADIUS, boxShadow: RESTING_SHADOW }}
    >
        {halo !== undefined ? <CardHalo on={halo} /> : null}
        <Box
            testID="card-surface"
            className={
                CARDS_USE_GLASS
                    ? // The opaque `bg-background-0` has to go, not just sit under
                      // the glass: a solid background over the plate cancels it.
                      'rounded-2xl overflow-hidden border border-line'
                    : 'rounded-2xl overflow-hidden bg-background-0 border border-line'
            }
        >
            <CardGlassPlate />
            {children}
        </Box>
    </Box>
);

export default FlatCardSurface;
