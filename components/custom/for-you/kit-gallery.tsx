// S2's section of the navx2 P2 kit gallery (app/dev-kit.tsx): every kit piece
// this area owns, in every state. Dev only; deleted in P13.
//
// The status icon and the counts card in each mode (the daily limit and the
// problem states are reachable on a simulator only here), the counts card
// sliding in (tap Show), the empty-state block with its hero and "Learn
// about", and the fact page's Next and last rows.

import { Text } from '@/components/ui/text';
import type { FeedStatusMode } from '@/lib/feed-status-mode';
import { useColors } from '@/lib/theme/tokens';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import DashboardStatsCard from './DashboardStatsCard';
import FeedStatusIcon from './FeedStatusIcon';
import ForYouEmptyState from './ForYouEmptyState';
import NextSectionFooter from './NextSectionFooter';
import StatusCardSlideIn from './StatusCardSlideIn';

const MODES: readonly FeedStatusMode[] = ['idle', 'processing', 'limited', 'error'];
const noop = () => undefined;

function Label({ children }: { readonly children: string }) {
    const colors = useColors();
    return (
        <Text size="xs" style={{ color: colors.ink3, marginTop: 16, marginBottom: 6 }}>
            {children}
        </Text>
    );
}

export default function KitGallery() {
    const { t } = useTranslation();
    const colors = useColors();
    const [slideIn, setSlideIn] = useState(false);

    return (
        <View testID="kit-s2">
            <Label>Status icon: idle, syncing, daily limit, problem</Label>
            <View style={{ flexDirection: 'row' }}>
                {MODES.map((m) => (
                    <FeedStatusIcon key={m} mode={m} onPress={noop} />
                ))}
            </View>

            {MODES.map((m) => (
                <View key={m}>
                    <Label>{`Counts card: ${m}${m === 'processing' ? ', details open' : ''}`}</Label>
                    <DashboardStatsCard mode={m} expandInPlace initiallyExpanded={m === 'processing'} testID={`kit-card-${m}`} />
                </View>
            ))}

            <Label>Counts card sliding in over a list (hides after 5 s, swipe up)</Label>
            <View style={{ height: 320, borderRadius: 12, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }}>
                <Pressable
                    onPress={() => setSlideIn((v) => !v)}
                    accessibilityRole="button"
                    style={{ height: 44, justifyContent: 'center', paddingHorizontal: 12, backgroundColor: colors.surface }}
                    testID="kit-slide-in-toggle"
                >
                    <Text size="sm" style={{ color: colors.ink }}>
                        {slideIn ? 'Hide' : 'Show'}
                    </Text>
                </Pressable>
                <StatusCardSlideIn visible={slideIn} onHide={() => setSlideIn(false)} topOverride={52} />
            </View>

            <Label>Empty: Feed with no facts (hero + Learn about)</Label>
            <ForYouEmptyState
                animationId="feed-two-lists"
                title={t('interests.emptyTitle')}
                body={t('feed.noFactsBody')}
                action={{ label: t('interests.learnAbout'), onPress: noop, testID: 'kit-empty-feed-learn' }}
                testID="kit-empty-feed"
            />
            <Label>Empty: Stories</Label>
            <ForYouEmptyState
                animationId="following-what-it-is"
                title={t('trackedStories.emptyTitle')}
                body={t('trackedStories.emptyBodyMera')}
                action={{ label: t('trackedStories.learnAbout'), onPress: noop, testID: 'kit-empty-stories-learn' }}
                testID="kit-empty-stories"
            />
            <Label>Empty: Saved (icon)</Label>
            <ForYouEmptyState
                icon="bookmark-border"
                title={t('savedSuggestions.emptyTitle')}
                body={t('library.saved.emptyBody')}
                action={{ label: t('library.saved.learn'), onPress: noop, testID: 'kit-empty-saved-learn' }}
                testID="kit-empty-saved"
            />

            <Label>Fact page: Next row, then the last row</Label>
            <NextSectionFooter kind="next" factId="kit-fact" title="Follows the German housing market" translateTitle={false} onPress={noop} />
            <NextSectionFooter kind="back" onPress={noop} />
        </View>
    );
}
