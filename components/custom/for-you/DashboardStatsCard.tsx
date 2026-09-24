// The Dashboard's stats card: the first card of the Overview list.
//
// Owner: the article-count sentence moved out of the header and into the
// Overview content, "so the header will stay the same even when the user taps
// on some other pill". It is also where the Dashboard's status panel lives now
// that the header has no Mera mark: tap the card and it opens the SAME body
// the Feed's mark opens (`FeedStatusBody`), with the same fields, and closes
// itself after the same STATUS_PANEL_AUTO_COLLAPSE_MS (owner: "make them
// similar").
//
// Always rendered. `FeedStatsSentence` says nothing at zero articles, which is
// the normal state of a capped account, and this card is the Dashboard's only
// home for the limit and error blocks, so at zero it shows the status line
// instead ("Up to date", "Daily article limit reached", ...), existing copy.
//
// A surface over the BACKDROP, inside the list, so no dark over-content base.

import { GlassPanel } from '@/components/custom/GlassSurface';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { useStatusDisclosure } from '@/lib/hooks/use-status-disclosure';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import FeedStatsSentence from './FeedStatsSentence';
import { FeedStatusBody, STATUS_PANEL_AUTO_COLLAPSE_MS } from './FeedStatusPanel';
import { a11yStateKey, STATUS_INK } from './status-ink';

export const DashboardStatsCard: React.FC = () => {
    const { t } = useTranslation();
    // `a11yStateKey` is computed from the mode; see its own note on `tAny`.
    const tAny = t as unknown as (key: string) => string;
    const mode = useFeedStatusMode();
    const { articleCount } = useFeedCounts();
    // `available` is true: this card is on screen in every state.
    const { expanded, toggle } = useStatusDisclosure(true, STATUS_PANEL_AUTO_COLLAPSE_MS);
    const stateLabel = tAny(a11yStateKey(mode));

    return (
        <GlassPanel radius={12} className="mb-2" contentClassName="px-4 py-3" testID="dashboard-stats-card">
            <Pressable
                onPress={toggle}
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
            {expanded ? (
                <View style={{ marginTop: 8 }} testID="dashboard-stats-card-details">
                    <FeedStatusBody mode={mode} />
                </View>
            ) : null}
        </GlassPanel>
    );
};

export default DashboardStatsCard;
