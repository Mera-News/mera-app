// The Dashboard's stats card: the first card of the Overview list.
//
// Owner: the article-count sentence moved out of the header and into the
// Overview content, "so the header will stay the same even when the user taps
// on some other pill". It is also where the Dashboard's status panel lives now
// that the header has no Mera mark: tap the card and the SAME panel the Feed's
// mark opens (`FeedStatusPanel`, dark over-content base included) drops down
// under it, and closes itself after the same STATUS_PANEL_AUTO_COLLAPSE_MS
// (owner: "make them similar").
//
// A DROPDOWN in a transparent Modal, never an in-place expansion. The card is
// the head of the Overview list, and growing it was captured growing UPWARD
// under the header at scroll offset 0, hiding the first rows of the body. The
// card never changes height, so the list never does. It closes on the timer,
// a tap anywhere outside (the backdrop, which also covers the card, so a
// second tap on the card closes it), a tab switch (a Modal outlives one), and
// "Manage plan" (via `onBeforeNavigate`, so no backdrop is left over the
// pushed screen). The list cannot scroll while it is open, for at most 3s.
//
// Always rendered. `FeedStatsSentence` says nothing at zero articles, which is
// the normal state of a capped account, and this card is the Dashboard's only
// home for the limit and error blocks, so at zero it shows the status line
// instead ("Up to date", "Daily article limit reached", ...), existing copy.
//
// The card is a surface over the BACKDROP, so no dark base; the dropdown floats
// over the sections and takes the panel's own dark base.

import { GlassPanel } from '@/components/custom/GlassSurface';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import { useStatusDisclosure } from '@/lib/hooks/use-status-disclosure';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Platform, Pressable as RNPressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import FeedStatsSentence from './FeedStatsSentence';
import FeedStatusPanel, { STATUS_PANEL_AUTO_COLLAPSE_MS } from './FeedStatusPanel';
import { type AnchorRect, dropdownBottomReserve, dropdownFrame, measureAnchor } from './stats-card-dropdown';
import { a11yStateKey, STATUS_INK } from './status-ink';
import { useFeedModeAnnouncement } from './use-feed-mode-announcement';

export const DashboardStatsCard: React.FC = () => {
    const { t } = useTranslation();
    // `a11yStateKey` is computed from the mode; see its own note on `tAny`.
    const tAny = t as unknown as (key: string) => string;
    const mode = useFeedStatusMode();
    // The Dashboard's announcement of entering the capped or error state. It
    // lived in the header's Mera mark, which this tab no longer has. The card
    // is mounted for the life of the Overview list, like the mark was.
    useFeedModeAnnouncement(mode);
    const { articleCount } = useFeedCounts();
    // `available` is true: this card is on screen in every state.
    const { expanded, toggle, collapse } = useStatusDisclosure(true, STATUS_PANEL_AUTO_COLLAPSE_MS);
    const stateLabel = tAny(a11yStateKey(mode));

    // Close on a tab switch. Not via `available`: the card itself never leaves
    // the screen, only the Modal outlives the tab.
    const focused = useIsFocusedSafe();
    useEffect(() => {
        if (!focused) collapse();
    }, [focused, collapse]);

    const anchorRef = useRef<View>(null);
    const [anchor, setAnchor] = useState<AnchorRect | null>(null);
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const open = useCallback(() => {
        measureAnchor(anchorRef.current, (rect) => {
            setAnchor(rect);
            toggle();
        });
    }, [toggle]);
    const frame = anchor
        ? dropdownFrame(
              anchor,
              windowHeight,
              insets.top,
              dropdownBottomReserve(Platform.OS, insets.bottom, TAB_BAR_HEIGHT),
          )
        : null;

    return (
        // `collapsable={false}`: a flattened view has nothing native to measure.
        <View ref={anchorRef} collapsable={false} className="mb-2">
        <GlassPanel radius={12} contentClassName="px-4 py-3" testID="dashboard-stats-card">
            <Pressable
                onPress={expanded ? collapse : open}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={`${stateLabel}. ${t(
                    expanded ? 'feedStatus.collapseA11y' : 'feedStatus.openA11y',
                )}`}
                testID="dashboard-stats-card-toggle"
            >
                <HStack className="items-start" space="sm">
                    <View style={{ flex: 1, minWidth: 0 }}>
                        {articleCount > 0 ? (
                            <FeedStatsSentence className="text-typography-700 font-medium" />
                        ) : (
                            <Text
                                size="sm"
                                className="font-medium"
                                style={{ color: STATUS_INK.primary }}
                                testID="dashboard-stats-card-state"
                            >
                                {stateLabel}
                            </Text>
                        )}
                    </View>
                    <MaterialIcons
                        name={expanded ? 'expand-less' : 'expand-more'}
                        size={20}
                        color={STATUS_INK.secondary}
                    />
                </HStack>
            </Pressable>
        </GlassPanel>
        <Modal
            visible={expanded && frame !== null}
            transparent
            // The panel carries its own fade.
            animationType="none"
            // Window coordinates on Android match `measureInWindow` only when
            // the Modal also draws under the status bar.
            statusBarTranslucent
            onRequestClose={collapse}
        >
            {/* Invisible: a popover, not a dialog, so nothing dims. It covers
                the card too, which is what makes a second tap close it. */}
            <RNPressable
                style={StyleSheet.absoluteFill}
                onPress={collapse}
                accessibilityRole="button"
                accessibilityLabel={t('feedStatus.collapseA11y')}
                testID="dashboard-stats-dropdown-backdrop"
            />
            {frame ? (
                <View
                    style={{
                        position: 'absolute',
                        top: frame.top,
                        left: frame.left,
                        width: frame.width,
                    }}
                    testID="dashboard-stats-dropdown"
                >
                    {/* The cap lives on the ScrollView itself so a body taller
                        than the room above the tab bar scrolls instead of
                        overflowing a capped parent. */}
                    <ScrollView
                        style={{ maxHeight: frame.maxHeight }}
                        bounces={false}
                        showsVerticalScrollIndicator={false}
                        testID="dashboard-stats-dropdown-scroll"
                    >
                        <FeedStatusPanel expanded={expanded} mode={mode} onBeforeNavigate={collapse} />
                    </ScrollView>
                </View>
            ) : null}
        </Modal>
        </View>
    );
};

export default DashboardStatsCard;
