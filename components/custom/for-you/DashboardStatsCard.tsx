// The feed's ONE counts card (FinalFeed #1, FinalFeedStatus #1-5): in an empty
// Feed's empty chain, at the head of the list at the daily limit, or at the
// head of the list when the Mera status icon asks for it (feed-status-card.ts,
// which also holds its open/closed state, so the icon can expand it). There
// is never an overlay and never two. The chevron opens the details INSIDE the
// card.
//
// Level 1: the status line (a light sweeps across it while a sync runs) and a
// chevron, then the count sentence ("being analysed" while syncing, with the
// 20pt processing scene beside it). Level 2, under the chevron
// and INSIDE the same card: FeedStatusDetails. At the daily limit or on a
// problem the whole card is FeedStatusNotice instead: no chevron, no counts.
//
// A zero count leads with its reason instead (zero-state.ts): nothing
// fetched, nothing analysed, nothing relevant, or offline, as plain text in
// the card's one-press row (no links, owner).
//
// No announcement here: FeedScreen announces the capped and error states.

import { GlassPanel } from '@/components/custom/GlassSurface';
import LoopScene from '@/components/custom/for-you/LoopScene';
import { processingAnimationFor } from '@/components/custom/processing/animation-registry';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { useHasFacts } from '@/components/custom/feed/use-has-facts';
import { useIsConnected } from '@/lib/stores/network-store';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { formatCount } from '@/lib/utils/format-count';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect } from 'react';
import { registerStatusCard, setStatusCardExpanded, useFeedStatusCard } from './feed-status-card';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { ShimmerText } from '@/components/ui/shimmer';
import { Text } from '@/components/ui/text';
import { MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';
import Animated, { FadeIn, FadeOut, useReducedMotion } from 'react-native-reanimated';
import FeedStatsSentence from './FeedStatsSentence';
import FeedStatusDetails, { AnalysingProgress, FeedStatusNotice } from './FeedStatusDetails';
import { a11yStateKey } from './status-ink';
import { zeroState, type ZeroState } from './zero-state';

const HIDDEN = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
} as const;

const SCENE_SIZE = 20;

export interface DashboardStatsCardProps {
    readonly testID?: string;
}

/** The status line. While a sync runs a soft light sweeps across it
 *  (ShimmerText owns Reduce Motion and Lite). */
function StatusLine({ label, syncing }: { label: string; syncing: boolean }) {
    const colors = useColors();
    const style = [styles.line, { color: colors.ink }];
    return syncing ? (
        <ShimmerText style={styles.line} numberOfLines={1} testID="dashboard-stats-card-state">
            {label}
        </ShimmerText>
    ) : (
        <Text numberOfLines={1} style={style} testID="dashboard-stats-card-state">
            {label}
        </Text>
    );
}

const TABULAR = { fontVariant: ['tabular-nums' as const] };

/** A zero's sentence, plain text (owner: no links; the reader finds
 *  Settings and their profile themselves). */
function useZeroText(kind: ZeroState | null): string | null {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();
    const { articleCount, analysedCount } = useFeedCounts();
    const fmt = (count: number) => ({ count, formatted: formatCount(count, appLanguage) });
    if (kind === 'offline') return t('common.offlineBannerOffline');
    if (kind === 'fetched') return t('feed.statsZeroFetched');
    if (kind === 'analysed') return `${t('feed.statsPublished', fmt(articleCount))} ${t('feed.statsZeroAnalysedTail')}`;
    if (kind === 'relevant')
        return `${t('feed.statsPublished', fmt(articleCount))} ${t('feed.statsAnalysed', fmt(analysedCount))} ${t('feed.statsZeroRelevantTail')}`;
    return null;
}

export const DashboardStatsCard: React.FC<DashboardStatsCardProps> = ({ testID = 'dashboard-stats-card' }) => {
    const { t } = useTranslation();
    // `a11yStateKey` is computed from the mode; see its own note on `tAny`.
    const tAny = t as unknown as (key: string) => string;
    const mode = useFeedStatusMode();
    const { articleCount, analysedCount, relevantCount } = useFeedCounts();
    const expanded = useFeedStatusCard((s) => s.expanded);
    // Not `emptyWants` (an empty Feed past a run, exactly where a zero needs
    // explaining): with no facts at all the no-facts card owns the Feed.
    const noFacts = useHasFacts() === false;
    const offline = useIsConnected() === false;
    const zero = zeroState({ mode, noFacts, offline, articleCount, analysedCount, relevantCount });
    const zeroText = useZeroText(zero);
    // The icon reads whether a card is showing from this count.
    useEffect(() => registerStatusCard(), []);
    const stateLabel = tAny(a11yStateKey(mode));
    const processing = mode === 'processing';

    const reduceMotion = useReducedMotion();
    const colors = useColors();

    const toggle = useCallback(() => setStatusCardExpanded(!useFeedStatusCard.getState().expanded), []);

    const notice = mode === 'limited' || mode === 'error';
    // With counts to show, the card LEADS with the sentence, collapsed and
    // expanded (the details' Stage row already says the state). At zero the
    // sentence says nothing, so then the status line leads.
    const countsTop = articleCount > 0;
    const details = expanded ? (
        <Animated.View
            entering={reduceMotion ? undefined : FadeIn.duration(MOTION.status.open)}
            exiting={reduceMotion ? undefined : FadeOut.duration(MOTION.status.close)}
        >
            <FeedStatusDetails mode={mode} />
            {processing ? <AnalysingProgress /> : null}
        </Animated.View>
    ) : null;

    return (
        <View className="mb-2" testID={`${testID}-anchor`}>
            <GlassPanel
                radius={12}
                contentClassName="px-4 py-3"
                testID={testID}
            >
                {notice ? (
                    <FeedStatusNotice mode={mode} />
                ) : (
                    <>
                        {/* A hidden visual under a CHILDLESS labelled button: a
                            glyph inside a button surfaces on iOS as its own
                            StaticText (captured class, ux2). */}
                        <View>
                            <View pointerEvents="none" {...HIDDEN}>
                                {/* The day's counts sentence leads (owner), wrapping
                                    beside the ⌄; the status line only when there
                                    is nothing to count. */}
                                <HStack className={countsTop || zeroText ? 'items-start' : 'items-center'} space="sm">
                                    {countsTop && processing ? (
                                        <LoopScene
                                            source={processingAnimationFor('analysing')}
                                            size={SCENE_SIZE}
                                            testID={`${testID}-scene`}
                                        />
                                    ) : null}
                                    <View style={{ flex: 1, minWidth: 0 }}>
                                        {zeroText ? (
                                            <Text
                                                size="sm"
                                                className="text-ink font-medium"
                                                style={TABULAR}
                                                testID="dashboard-stats-card-zero"
                                            >
                                                {zeroText}
                                            </Text>
                                        ) : countsTop ? (
                                            <FeedStatsSentence syncing={processing} className="text-ink font-medium" />
                                        ) : (
                                            <StatusLine label={stateLabel} syncing={processing} />
                                        )}
                                    </View>
                                    <MaterialIcons
                                        name={expanded ? 'expand-less' : 'expand-more'}
                                        size={20}
                                        color={colors.ink}
                                        {...HIDDEN}
                                    />
                                </HStack>
                            </View>
                            <Pressable
                                onPress={toggle}
                                accessibilityRole="button"
                                accessibilityState={{ expanded }}
                                accessibilityLabel={`${zeroText ?? stateLabel}. ${t(
                                    expanded ? 'feedStatus.collapseA11y' : 'feedStatus.expandA11y',
                                )}`}
                                testID={`${testID}-toggle`}
                                style={StyleSheet.absoluteFill}
                            />
                        </View>
                        {details}
                    </>
                )}
            </GlassPanel>
        </View>
    );
};

const styles = StyleSheet.create({
    // fontSize with its own lineHeight (the ui Text clipping trap).
    line: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
});

export default DashboardStatsCard;
