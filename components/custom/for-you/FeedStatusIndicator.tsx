// The feed pipeline's status, in one glyph, inline beside the screen title.
//
// This replaces a full-width indeterminate bar that sat under the title on both
// tabs. The bar was doing real work — it was also the only place a sync error or
// a hit daily limit surfaced — but it read as "something is arriving", which is
// what turned the Feed into a thing you check rather than a thing you read. The
// information survives; the billboard does not.
//
// The glyph is now the Mera mark itself, and it is ALWAYS on screen. The first
// pass drew a spinner or a warning icon and nothing at all when idle, which cost
// two things: the header changed shape under the reader every time a sync
// started or ended, and the detail panel behind it was only reachable during the
// few seconds a sync happened to be in flight. A mark that is always there is a
// fixed landmark and a permanent way in.
//
// State is carried by ink and motion rather than by presence, so the slot never
// moves and never empties:
//   processing    → the spotlight sweeps, at 1.3x, in pure white
//   error         → still, 1x, red
//   limited       → still, 1x, amber
//   idle/deferred → still, 1x, the theme's off-white
//
// The sweep is MeraLogo's own `animated` prop rather than a second animation
// written here. That matters beyond duplication: the sweep self-gates on focus +
// foreground (see AnimatedSpotlight) because RNSVG rasterises on the CPU, so an
// unattended one would keep re-drawing this header while the user reads another
// tab. Reproducing the animation would mean reproducing that gate too.
//
// The emphasis is a `transform: scale`, NOT a larger `size`. A bigger size grows
// the SVG's layout box, which reflows the title row and shoves the importance
// filter chip sideways every time a sync starts. A transform is composited and
// costs the row nothing.

import MeraLogo from '@/components/custom/MeraLogo';
import { Pressable } from '@/components/ui/pressable';
import { type FeedStatusMode } from '@/lib/feed-status-mode';
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

/** Pure white — the one state that is meant to pull the eye. */
const ACTIVE = '#FFFFFF';
/** The theme's `light` (tailwind.config.js). There is no off-white token beyond
 *  it, and this is deliberately a step back from `ACTIVE` rather than a dimmed
 *  grey: at rest the mark is branding, not a disabled control. */
const RESTING = '#FBFBFB';
const ERROR = '#F87171';
const WARN = '#FBBF24';

/** Sized to the `size="small"` spinner and the 20pt warning glyph this replaced,
 *  so the title row's height is unchanged by the swap. */
const LOGO_SIZE = 22;
const ACTIVE_SCALE = 1.3;
/** Long enough that the growth is not a snap, short enough that a sync starting
 *  still reads as an event rather than a transition you sit and watch. */
const SCALE_MS = 200;

/** Ink per state. `deferred` and `idle` share the resting colour: "waiting for
 *  the next batch" is a pipeline count the reader cannot act on, so it gets no
 *  visual weight of its own. The count is still in the panel one tap away. */
function inkFor(mode: FeedStatusMode): string {
    switch (mode) {
        case 'processing':
            return ACTIVE;
        case 'error':
            return ERROR;
        case 'limited':
            return WARN;
        default:
            return RESTING;
    }
}

export interface FeedStatusIndicatorProps {
    readonly mode: FeedStatusMode;
    /** Whether the detail panel this opens is currently showing. */
    readonly expanded: boolean;
    readonly onPress: () => void;
    readonly testID: string;
}

export const FeedStatusIndicator: React.FC<FeedStatusIndicatorProps> = ({
    mode,
    expanded,
    onPress,
    testID,
}) => {
    const { t } = useTranslation();
    const processing = mode === 'processing';

    // `reactCompiler: true` is on, and MeraLogo.tsx:31-35 records that branching
    // a shared-value-holding component on a variant is this area's likeliest
    // bug. These three hooks run on every render for every mode — the component
    // no longer returns early for the invisible states, so there is nothing left
    // to branch around. Seeded from `mode` rather than from 1 so a header that
    // mounts mid-sync starts at the right size instead of growing into it.
    const scale = useSharedValue(processing ? ACTIVE_SCALE : 1);
    useEffect(() => {
        scale.value = withTiming(processing ? ACTIVE_SCALE : 1, { duration: SCALE_MS });
    }, [processing, scale]);
    const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            // 12 is the header-chrome convention (the bell, the drill-down back
            // button); the mark itself is only ~22pt.
            hitSlop={12}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={t(expanded ? 'feedStatus.collapseA11y' : 'feedStatus.openA11y')}
            className="items-center justify-center"
        >
            {/* The scale lives on this wrapper, not on the Svg: transforms do not
                participate in layout, so the row keeps reserving LOGO_SIZE in
                every state. `testID` here is derived rather than fixed — the
                simulator harness drives the Pressable above by its own id. */}
            <Animated.View testID={`${testID}-mark`} style={scaleStyle}>
                <MeraLogo size={LOGO_SIZE} animated={processing} color={inkFor(mode)} />
            </Animated.View>
        </Pressable>
    );
};

export default FeedStatusIndicator;
