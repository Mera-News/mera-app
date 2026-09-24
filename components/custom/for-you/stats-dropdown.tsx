// The Dashboard stats card's status dropdown: a provider that owns its state,
// and a layer ForYouScreen mounts over the whole screen.
//
// Why a layer in the SCREEN, not a Modal: a transparent RN Modal is its own
// window and covers the tab bar, so with the panel open a tab tap only closed
// the panel (captured). The layer lives inside the tab screen, and the native
// tab bar sits above every tab screen, so a tab tap reaches the bar, switches
// tab, and the blur close below shuts the panel.
//
// Why a dropdown at all: the card is the head of the Overview list, and
// growing it in place was captured growing UPWARD under the header at scroll
// offset 0. The card never changes height, so the list never does.
//
// The provider owns the disclosure (the card reads `expanded` for its chevron
// and label); the layer owns the drawing. Closes on the shared 3s timer, a tap
// anywhere on the backdrop (which covers the card, so a second tap on the card
// closes it), a tab switch, and before "Manage plan" navigates.

import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import { useStatusDisclosure } from '@/lib/hooks/use-status-disclosure';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import FeedStatusPanel, { STATUS_PANEL_AUTO_COLLAPSE_MS } from './FeedStatusPanel';
import { type AnchorRect, dropdownFrame, measureAnchor } from './stats-card-dropdown';

interface StatsDropdownState {
    readonly expanded: boolean;
    /** The card's rect in WINDOW coordinates (`measureInWindow`). */
    readonly open: (anchorInWindow: AnchorRect) => void;
    readonly collapse: () => void;
}

interface StatsDropdownInternals extends StatsDropdownState {
    readonly layerRef: React.RefObject<View | null>;
    /** The card's rect in the LAYER's coordinates, once measured. */
    readonly anchor: AnchorRect | null;
    readonly layerHeight: number;
}

const Ctx = createContext<StatsDropdownInternals | null>(null);

const NOOP: StatsDropdownState = { expanded: false, open: () => {}, collapse: () => {} };

/** For the card. Outside a provider it is inert rather than a crash. */
export function useStatsDropdown(): StatsDropdownState {
    return useContext(Ctx) ?? NOOP;
}

export const StatsDropdownProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // `available` true: the card is always rendered; only a tab switch needs
    // closing, and the blur effect below does that.
    const { expanded, toggle, collapse } = useStatusDisclosure(true, STATUS_PANEL_AUTO_COLLAPSE_MS);
    const layerRef = useRef<View | null>(null);
    const [anchor, setAnchor] = useState<AnchorRect | null>(null);
    const [layerHeight, setLayerHeight] = useState(0);

    const focused = useIsFocusedSafe();
    useEffect(() => {
        if (!focused) collapse();
    }, [focused, collapse]);

    const open = useCallback(
        (a: AnchorRect) => {
            // Window -> layer coordinates. The layer fills the screen, so its
            // window origin is the screen's; measured, not assumed to be 0.
            measureAnchor(layerRef.current, (layer) => {
                setAnchor({ x: a.x - layer.x, y: a.y - layer.y, width: a.width, height: a.height });
                setLayerHeight(layer.height);
                if (!expanded) toggle();
            });
        },
        [expanded, toggle],
    );

    const value = useMemo(
        () => ({ expanded, open, collapse, layerRef, anchor, layerHeight }),
        [expanded, open, collapse, anchor, layerHeight],
    );
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

/**
 * Mount LAST inside the screen's root, so it paints over the list and the
 * header. Always mounted (it has to be measurable), and touch-transparent
 * while closed.
 */
export const StatsDropdownLayer: React.FC = () => {
    const ctx = useContext(Ctx);
    const { t } = useTranslation();
    const mode = useFeedStatusMode();
    const insets = useSafeAreaInsets();
    // Inside a tab: iOS content runs under the floating bar and this is the
    // in-tab inset, which contains the bar; Android content ends at the bar
    // and this is 0. See lib/navigation/tab-bar.ts.
    const tabClearance = useTabBarClearance();
    if (!ctx) return null;
    const { expanded, collapse, layerRef, anchor, layerHeight } = ctx;
    const frame = anchor ? dropdownFrame(anchor, layerHeight, insets.top, tabClearance) : null;
    const showing = expanded && frame !== null;

    return (
        <View
            ref={layerRef}
            // Measurable while closed: a flattened view has nothing native.
            collapsable={false}
            pointerEvents={showing ? 'auto' : 'none'}
            style={[StyleSheet.absoluteFill, { zIndex: 20 }]}
            testID="dashboard-stats-dropdown-layer"
        >
            {showing ? (
                <>
                    {/* Invisible: a popover, not a dialog, so nothing dims. It
                        covers the card too, which is what makes a second tap
                        on the card close it. */}
                    <Pressable
                        style={StyleSheet.absoluteFill}
                        onPress={collapse}
                        accessibilityRole="button"
                        accessibilityLabel={t('feedStatus.collapseA11y')}
                        testID="dashboard-stats-dropdown-backdrop"
                    />
                    <View
                        style={{ position: 'absolute', top: frame.top, left: frame.left, width: frame.width }}
                        testID="dashboard-stats-dropdown"
                    >
                        {/* The cap lives on the ScrollView itself so a body
                            taller than the room above the tab bar scrolls
                            instead of overflowing a capped parent. */}
                        <ScrollView
                            style={{ maxHeight: frame.maxHeight }}
                            bounces={false}
                            showsVerticalScrollIndicator={false}
                            testID="dashboard-stats-dropdown-scroll"
                        >
                            {/* Opaque: it floats over list CONTENT with nothing
                                behind it, unlike the Feed's panel, which sits on
                                the header's own scrim and plate. */}
                            <FeedStatusPanel expanded mode={mode} onBeforeNavigate={collapse} opaque />
                        </ScrollView>
                    </View>
                </>
            ) : null}
        </View>
    );
};
