// The status panel as a DROPDOWN, on both tabs: a provider that owns its
// state, and a layer the screen mounts last, over its list and header. The
// Feed anchors it under its title row (opened from the Mera mark), the
// Dashboard under the Overview stats card.
//
// Why a dropdown at all: an in-place panel changes the list's geometry. On the
// Dashboard the stats card, growing at the head of the list, was captured
// growing UPWARD under the header; on the Feed the panel grew the header,
// which re-padded the list and left it scrolled ~99pt down after the panel
// closed. A dropdown changes no layout, so neither can happen.
//
// Why a layer in the SCREEN, not a Modal: a transparent RN Modal is its own
// window and covers the tab bar, so with the panel open a tab tap only closed
// the panel (captured). The layer lives inside the tab screen, and the native
// tab bar sits above every tab screen, so a tab tap reaches the bar, switches
// tab, and the blur close below shuts the panel.
//
// The provider owns the disclosure (the trigger reads `expanded` for its own
// state and label); the layer owns the drawing. Closes on the shared 3s timer, a tap
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

interface StatusDropdownState {
    readonly expanded: boolean;
    /** The anchor's rect in WINDOW coordinates (`measureInWindow`). */
    readonly open: (anchorInWindow: AnchorRect) => void;
    readonly collapse: () => void;
}

interface StatusDropdownInternals extends StatusDropdownState {
    readonly layerRef: React.RefObject<View | null>;
    /** The anchor's rect in the LAYER's coordinates, once measured. */
    readonly anchor: AnchorRect | null;
    readonly layerHeight: number;
}

const Ctx = createContext<StatusDropdownInternals | null>(null);

const NOOP: StatusDropdownState = { expanded: false, open: () => {}, collapse: () => {} };

/** For the trigger. Outside a provider it is inert rather than a crash. */
export function useStatusDropdown(): StatusDropdownState {
    return useContext(Ctx) ?? NOOP;
}

export const StatusDropdownProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // `available` true: both triggers are always rendered; only a tab switch
    // needs closing, and the blur effect below does that.
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
export const StatusDropdownLayer: React.FC<{
    /** `{surface}` for the layer's testIDs: `${prefix}-dropdown-layer`, etc. */
    readonly testIDPrefix: string;
}> = ({ testIDPrefix }) => {
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
            testID={`${testIDPrefix}-dropdown-layer`}
        >
            {showing ? (
                <>
                    {/* Invisible: a popover, not a dialog, so nothing dims. It
                        covers the trigger too, which is what makes a second
                        tap on the trigger close it. */}
                    <Pressable
                        style={StyleSheet.absoluteFill}
                        onPress={collapse}
                        accessibilityRole="button"
                        accessibilityLabel={t('feedStatus.collapseA11y')}
                        testID={`${testIDPrefix}-dropdown-backdrop`}
                    />
                    <View
                        style={{ position: 'absolute', top: frame.top, left: frame.left, width: frame.width }}
                        testID={`${testIDPrefix}-dropdown`}
                    >
                        {/* The cap lives on the ScrollView itself so a body
                            taller than the room above the tab bar scrolls
                            instead of overflowing a capped parent. */}
                        <ScrollView
                            style={{ maxHeight: frame.maxHeight }}
                            bounces={false}
                            showsVerticalScrollIndicator={false}
                            testID={`${testIDPrefix}-dropdown-scroll`}
                        >
                            <FeedStatusPanel expanded mode={mode} onBeforeNavigate={collapse} />
                        </ScrollView>
                    </View>
                </>
            ) : null}
        </View>
    );
};
