// The feed pipeline's status, in one glyph, inline beside the screen title.
//
// This replaces a full-width indeterminate bar that sat under the title on both
// tabs. The bar was doing real work — it was also the only place a sync error or
// a hit daily limit surfaced — but it read as "something is arriving", which is
// what turned the Feed into a thing you check rather than a thing you read. The
// information survives; the billboard does not.
//
// The glyph is the Mera mark itself, and ONLY the Feed mounts it, at the
// right end of its title row, in EVERY state (owner): small and completely
// still at rest, bigger with its strokes drawing on while a sync runs. It is
// always tappable, so the status panel is always one tap away. The Dashboard
// has no mark; its panel opens from the Overview stats card.

// State is carried by size, ink and motion rather than by presence, so the slot
// never moves and never empties:
//   processing    → torch sweeps over scrolling cards, at 1.55x, in pure white
//   error         → still, 1x, red
//   limited       → still, 1x, amber
//   idle/deferred → still, 1x, the theme's off-white
// At rest the mark is exactly as tall as the "Feed" title's ink (owner: "as big
// as the Feed text in the same line"): 21.5pt on a compact phone, 25.8pt at
// 400pt+, so 33.3 / 40pt while processing, inside a row pinned at 45 / 54pt.
//
// While processing, "Mera reading all the news" (owner): the torch sweeps back
// and forth (MeraLogo's `animated`, ±15deg over 4s) while the background cards
// scroll right to left behind it (`scrollCards`, one card every 3.2s). Both
// are MeraLogo's own and self-gate on focus + foreground (RNSVG rasterises on
// the CPU). Under Reduce Motion the size still changes, instantly, and nothing
// moves. The fully drawn mark is on screen throughout, so the grow never
// blanks it.

// The emphasis is a `transform: scale`, NOT a larger `size`. A bigger size grows
// the SVG's layout box, which reflows the title row and shoves whatever sits
// beside it sideways every time a sync starts. A transform is composited and
// costs the row nothing.

import MeraLogo from '@/components/custom/MeraLogo';
import { Pressable } from '@/components/ui/pressable';
import { type FeedStatusMode } from '@/lib/feed-status-mode';
import { a11yStateKey } from './status-ink';
import { type HeaderTitleSize, headerTitleSize } from '@/lib/typography/header-title-size';
import { useWindowDimensions } from 'react-native';
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

/** Pure white — the one state that is meant to pull the eye. */
const ACTIVE = '#FFFFFF';
/** The theme's `light` (tailwind.config.js). There is no off-white token beyond
 *  it, and this is deliberately a step back from `ACTIVE` rather than a dimmed
 *  grey: at rest the mark is branding, not a disabled control. */
const RESTING = '#FBFBFB';
const ERROR = '#F87171';
const WARN = '#FBBF24';

/**
 * The resting mark's height = the INK height of "Feed" in the header title,
 * per `headerTitleSize` step. Measured with CoreText in the system bold font
 * the Heading renders: "Feed" is 21.46pt from the "d" ascender to the baseline
 * at 30px (3xl) and 25.75pt at 36px (4xl). The glyph box is tight to the mark
 * (MeraLogo's viewBox), so `size` IS its visible height. Tracks the NOMINAL
 * title size; a long translation shrunk by adjustsFontSizeToFit is smaller.
 */
const LOGO_SIZE_BY_TITLE: Record<HeaderTitleSize, number> = { '3xl': 21.5, '4xl': 25.8 };
/** Processing grows the mark 1.55x by transform (33.3 / 40pt), inside the 45 /
 *  54pt row. The glyph is 0.70:1, so it overflows its layout box by ~4-5pt a
 *  side into the row's gaps; nothing reflows. The largest scale the row holds
 *  vertically is ~2.1x, but that eats the whole gap to the narration. */
const ACTIVE_SCALE = 1.55;
const RESTING_SCALE = 1;
/** Long enough that the growth is not a snap, short enough that a sync starting
 *  still reads as an event rather than a transition you sit and watch. */
const SCALE_MS = 250;

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
    const tAny = t as (key: string) => string;
    const processing = mode === 'processing';

    // `reactCompiler: true` is on, and MeraLogo.tsx:31-35 records that branching
    // a shared-value-holding component on a variant is this area's likeliest
    // bug. These three hooks run on every render for every mode — the component
    // no longer returns early for the invisible states, so there is nothing left
    // to branch around. Seeded from `mode` rather than from 1 so a header that
    // mounts mid-sync starts at the right size instead of growing into it.
    const reduceMotion = useReducedMotion();
    const { width: windowWidth } = useWindowDimensions();
    const logoSize = LOGO_SIZE_BY_TITLE[headerTitleSize(windowWidth)];
    const moving = processing && !reduceMotion;
    const target = processing ? ACTIVE_SCALE : RESTING_SCALE;
    const scale = useSharedValue(target);
    useEffect(() => {
        scale.value = reduceMotion ? target : withTiming(target, { duration: SCALE_MS });
    }, [target, reduceMotion, scale]);
    const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

    // Entering the capped or error state is announced by the SCREEN
    // (`useFeedModeAnnouncement`), not here: the Dashboard has no mark.

    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            // 12 is the header-chrome convention (the bell, the drill-down back
            // button); the mark itself is only ~22pt.
            hitSlop={12}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            // State FIRST, then the action. A screen-reader user needs to know
            // the feed is capped before they know they can open a panel about
            // it; the reverse order buries the only new information behind a
            // string that never changes.
            accessibilityLabel={`${tAny(a11yStateKey(mode))}. ${t(
                expanded ? 'feedStatus.collapseA11y' : 'feedStatus.openA11y',
            )}`}
            className="items-center justify-center"
        >
            {/* The scale lives on this wrapper, not on the Svg: transforms do not
                participate in layout, so the row keeps reserving `logoSize` in
                every state. `testID` here is derived rather than fixed — the
                simulator harness drives the Pressable above by its own id. */}
            <Animated.View testID={`${testID}-mark`} style={scaleStyle}>
                <MeraLogo
                    size={logoSize}
                    animated={moving}
                    scrollCards={moving}
                    color={inkFor(mode)}
                />
            </Animated.View>
        </Pressable>
    );
};

export default FeedStatusIndicator;
