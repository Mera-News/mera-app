// The feed status card: the first card of the Feed and Interests pages (it was
// the Dashboard Overview's, removed by navx and restored at the owner's ask).
//
// Owner: the article-count sentence lives in the page content, not the header,
// "so the header will stay the same even when the user taps on some other
// pill". Tap the card and the status panel (`FeedStatusPanel`) drops down
// under it and closes itself after STATUS_PANEL_AUTO_COLLAPSE_MS.
//
// A DROPDOWN, never an in-place expansion, drawn by the `StatusDropdownLayer`
// each page mounts last (see status-dropdown.tsx for why a screen layer and
// not a Modal). This card only measures itself and asks the provider to open.
//
// Two rows. The status line is ALWAYS there and always one line, with a
// spinner while Mera syncs: the owner wanted the sync visible, and a row that
// came and went would change the card's height at the head of the list (the
// Interests list has no autoscroll-to-top, so the card grew upward under the
// header there). Under it, the count sentence, which says nothing at zero
// articles (the normal state of a capped account).
//
// No announcement here: FeedScreen and the Mera button already announce the
// status changes, and a third would repeat them.
//
// The card is a surface over the BACKDROP, so no dark base.

import { GlassPanel } from '@/components/custom/GlassSurface';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import FeedStatsSentence from './FeedStatsSentence';
import { measureAnchor } from './stats-card-dropdown';
import { useStatusDropdown } from './status-dropdown';
import { a11yStateKey, STATUS_INK } from './status-ink';

export const DashboardStatsCard: React.FC = () => {
    const { t } = useTranslation();
    // `a11yStateKey` is computed from the mode; see its own note on `tAny`.
    const tAny = t as unknown as (key: string) => string;
    const mode = useFeedStatusMode();
    const { articleCount } = useFeedCounts();
    const { expanded, open: openDropdown, collapse } = useStatusDropdown();
    const stateLabel = tAny(a11yStateKey(mode));

    const anchorRef = useRef<View>(null);
    const open = useCallback(() => measureAnchor(anchorRef.current, openDropdown), [openDropdown]);

    return (
        // `collapsable={false}`: a flattened view has nothing native to measure.
        <View ref={anchorRef} collapsable={false} className="mb-2" testID="dashboard-stats-card-anchor">
        <GlassPanel radius={12} contentClassName="px-4 py-3" testID="dashboard-stats-card">
            {/* The row is a hidden visual with a CHILDLESS labelled button laid
                over it: the chevron glyph inside the button surfaced on iOS as
                its own StaticText (captured class, ux2). */}
            <View>
                <HStack
                    className="items-start"
                    space="sm"
                    pointerEvents="none"
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                >
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <HStack className="items-center" space="xs">
                            {mode === 'processing' ? (
                                <Spinner
                                    size="small"
                                    color={STATUS_INK.secondary}
                                    style={styles.spinner}
                                    testID="dashboard-stats-card-syncing"
                                />
                            ) : null}
                            <Text
                                size="sm"
                                className="font-medium"
                                numberOfLines={1}
                                style={{ color: STATUS_INK.primary, flexShrink: 1 }}
                                testID="dashboard-stats-card-state"
                            >
                                {stateLabel}
                            </Text>
                        </HStack>
                        {articleCount > 0 ? (
                            <FeedStatsSentence className="text-typography-700 font-medium mt-1" />
                        ) : null}
                    </View>
                    <MaterialIcons
                        name={expanded ? 'expand-less' : 'expand-more'}
                        size={20}
                        color={STATUS_INK.secondary}
                        accessible={false}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                    />
                </HStack>
                <Pressable
                    onPress={expanded ? collapse : open}
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    accessibilityLabel={`${stateLabel}. ${t(
                        expanded ? 'feedStatus.collapseA11y' : 'feedStatus.openA11y',
                    )}`}
                    testID="dashboard-stats-card-toggle"
                    style={StyleSheet.absoluteFill}
                />
            </View>
        </GlassPanel>
        </View>
    );
};

const styles = StyleSheet.create({
    // A small spinner is 20pt; scaled to sit inside the sm line box so the
    // status row is the same height syncing or not.
    spinner: { transform: [{ scale: 0.8 }], width: 16, height: 16 },
});

export default DashboardStatsCard;
