// The Dashboard's stats card: the first card of the Overview list.
//
// Owner: the article-count sentence moved out of the header and into the
// Overview content, "so the header will stay the same even when the user taps
// on some other pill". It is also where the Dashboard's status panel lives now
// that the header has no Mera mark: tap the card and the SAME panel the Feed's
// mark opens (`FeedStatusPanel`) drops down under it, and closes itself after
// the same STATUS_PANEL_AUTO_COLLAPSE_MS (owner: "make them similar").
//
// A DROPDOWN, never an in-place expansion, drawn by `StatusDropdownLayer` in
// ForYouScreen (see status-dropdown.tsx for why a screen layer and not a
// Modal). This card only measures itself and asks the provider to open.
//
// Always rendered. `FeedStatsSentence` says nothing at zero articles, which is
// the normal state of a capped account, and this card is the Dashboard's only
// home for the limit and error blocks, so at zero it shows the status line
// instead ("Up to date", "Daily article limit reached", ...), existing copy.
//
// The card is a surface over the BACKDROP, so no dark base.

import { GlassPanel } from '@/components/custom/GlassSurface';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import FeedStatsSentence from './FeedStatsSentence';
import { measureAnchor } from './stats-card-dropdown';
import { useStatusDropdown } from './status-dropdown';
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
    const { expanded, open: openDropdown, collapse } = useStatusDropdown();
    const stateLabel = tAny(a11yStateKey(mode));

    const anchorRef = useRef<View>(null);
    const open = useCallback(() => measureAnchor(anchorRef.current, openDropdown), [openDropdown]);

    return (
        // `collapsable={false}`: a flattened view has nothing native to measure.
        <View ref={anchorRef} collapsable={false} className="mb-2" testID="dashboard-stats-card-anchor">
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
        </View>
    );
};

export default DashboardStatsCard;
