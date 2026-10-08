// The feed's ONE counts card (FinalFeed #1, FinalFeedStatus #1-5): the FIRST
// item of the Feed list in both views (`useStatsCardItem`, the list header),
// so a page swipe carries it like any card. When it shows and whether it is
// open live in feed-status-card.ts. There
// is never an overlay and never two. The chevron opens the details INSIDE the
// card, their height animated on the UI thread (`ExpandingDetails`). The Mera
// mark leads the sentence (`StatusMark`), moving while a run is in flight: the
// Feed header has no status icon any more, so this is the Feed's "working".
//
// ONE layout for every state (owner). Level 1, the lead row: the Mera mark,
// a sentence and the ⌄. The sentence is the day's counts ("being analysed"
// while syncing), or the status line at zero articles (a light sweeps across
// it while a sync runs), or a state's own sentence (card-state.ts): the daily
// limit (when articles unlock), a scoring problem, nothing fetched, nothing
// analysed, nothing relevant, or offline, as plain text (no links, owner).
// Level 2, under the ⌄ and INSIDE the card: FeedStatusDetails (its Stage row
// names the limit or the problem), then FeedStatusActions (upgrade and Manage
// plan at the limit, Try now on a problem).
//
// No announcement here: FeedScreen announces the capped and error states.

import { GlassPanel } from '@/components/custom/GlassSurface';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { useHasFacts } from '@/components/custom/feed/use-has-facts';
import { useIsConnected } from '@/lib/stores/network-store';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { formatCount } from '@/lib/utils/format-count';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo } from 'react';
import { setStatusCardExpanded, statsCardShown, useFeedStatusCard } from './feed-status-card';
import MeraLogo from '@/components/custom/MeraLogo';
import { useMotionAllowed } from '@/lib/motion-gate';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { ShimmerText } from '@/components/ui/shimmer';
import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import FeedStatsSentence from './FeedStatsSentence';
import FeedStatusDetails, { AnalysingProgress, FeedStatusActions, limitUnlockTime } from './FeedStatusDetails';
import { a11yStateKey } from './status-ink';
import { cardState, type CardState } from './card-state';
import { useForYouDailyLimitResetAt, useForYouScoringError } from '@/lib/stores/selectors';
import { SCORING_ERROR_I18N_KEYS } from '@/lib/services/scoring-error';

const HIDDEN = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
} as const;

/** The Mera mark at the lead row's start: 1.3x the old 20pt (owner). */
const MARK_SIZE = 26;

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

/** A state's lead sentence, plain text (owner: no links; the reader finds
 *  Settings and their profile themselves; the limit's and the error's actions
 *  are in the details). */
function useStateText(kind: CardState | null): string | null {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();
    const { articleCount, analysedCount } = useFeedCounts();
    const resetAt = useForYouDailyLimitResetAt();
    const scoringError = useForYouScoringError();
    const fmt = (count: number) => ({ count, formatted: formatCount(count, appLanguage) });
    if (kind === 'limited') return t('feed.dailyLimit.bodyWithTime', { time: limitUnlockTime(resetAt) });
    if (kind === 'error') return t(SCORING_ERROR_I18N_KEYS[scoringError ?? 'generic'].message);
    if (kind === 'offline') return t('common.offlineBannerOffline');
    if (kind === 'fetched') return t('feed.statsZeroFetched');
    if (kind === 'analysed') return `${t('feed.statsPublished', fmt(articleCount))} ${t('feed.statsZeroAnalysedTail')}`;
    if (kind === 'relevant')
        return `${t('feed.statsPublished', fmt(articleCount))} ${t('feed.statsAnalysed', fmt(analysedCount))} ${t('feed.statsZeroRelevantTail')}`;
    return null;
}

/** Expanding and collapsing the details. */
const DETAILS_MOTION = { duration: 250, easing: Easing.out(Easing.cubic) };

/**
 * The details under the chevron. Always mounted, so a tap never pays a mount;
 * laid out at their natural height in an absolute body, and the clip's height
 * runs from 0 to that height on the UI thread with the opacity, so the list
 * under the card slides instead of jumping. Instant in Lite and Reduce Motion.
 */
function ExpandingDetails({ open, children }: { open: boolean; children: React.ReactNode }) {
    const motionAllowed = useMotionAllowed();
    // Written from onLayout and never read back on JS.
    const bodyHeight = useSharedValue(0);
    const shown = useSharedValue(open ? 1 : 0);
    useEffect(() => {
        shown.value = motionAllowed ? withTiming(open ? 1 : 0, DETAILS_MOTION) : open ? 1 : 0;
    }, [open, motionAllowed, shown]);
    const clip = useAnimatedStyle(() => ({ height: bodyHeight.value * shown.value, opacity: shown.value }));
    return (
        <Animated.View
            style={[styles.detailsClip, clip]}
            pointerEvents={open ? 'box-none' : 'none'}
            accessibilityElementsHidden={!open}
            importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
            testID="dashboard-stats-card-details"
        >
            <View
                style={styles.detailsBody}
                onLayout={(e) => {
                    bodyHeight.value = e.nativeEvent.layout.height;
                }}
            >
                {children}
            </View>
        </Animated.View>
    );
}

/** The Mera mark, always at the sentence's start (owner): moving while a run
 *  is in flight, a still frame when idle. MeraLogo itself holds still in Lite,
 *  under Reduce Motion and off screen. */
export function StatusMark({ working }: { working: boolean }) {
    const colors = useColors();
    return (
        <View {...HIDDEN} style={styles.mark} testID="dashboard-stats-card-mark">
            <MeraLogo size={MARK_SIZE} color={colors.ink} animated={working} />
        </View>
    );
}

/**
 * The Feed list's first item: the card when it shows (`statsCardShown`), else
 * null. `emptyWants` and `hasRows` are the list's own state, so the card is
 * there the moment the page slides in, not after it lands.
 */
export function useStatsCardItem(emptyWants: boolean, hasRows: boolean): React.ReactElement | null {
    const limited = useFeedStatusMode() === 'limited';
    const shown = statsCardShown({ limited, emptyWants, hasRows });
    // One element per state, so the list header is not re-rendered per render.
    return useMemo(() => (shown ? <DashboardStatsCard testID="feed-status-card" /> : null), [shown]);
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
    const state = cardState({ mode, noFacts, offline, articleCount, analysedCount, relevantCount });
    const zeroText = useStateText(state);
    const stateLabel = tAny(a11yStateKey(mode));
    const processing = mode === 'processing';

    const colors = useColors();

    const toggle = useCallback(() => setStatusCardExpanded(!useFeedStatusCard.getState().expanded), []);

    // With counts to show, the card LEADS with the sentence, collapsed and
    // expanded (the details' Stage row already says the state). At zero the
    // sentence says nothing, so then the status line leads.
    const countsTop = articleCount > 0;
    const details = (
        <ExpandingDetails open={expanded}>
            <FeedStatusDetails mode={mode} />
            {processing ? <AnalysingProgress /> : null}
            <FeedStatusActions mode={mode} />
        </ExpandingDetails>
    );

    return (
        <View className="mb-2" testID={`${testID}-anchor`}>
            <GlassPanel
                radius={12}
                contentClassName="px-4 py-3"
                testID={testID}
            >
                    <>
                        {/* A hidden visual under a CHILDLESS labelled button: a
                            glyph inside a button surfaces on iOS as its own
                            StaticText (captured class, ux2). */}
                        <View>
                            <View pointerEvents="none" {...HIDDEN}>
                                {/* The day's counts sentence leads (owner), wrapping
                                    beside the ⌄; the status line only when there
                                    is nothing to count. */}
                                <HStack className="items-center" space="sm">
                                    <StatusMark working={processing} />
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
                                style={styles.leadPress}
                            />
                        </View>
                        {details}
                    </>
            </GlassPanel>
        </View>
    );
};

const styles = StyleSheet.create({
    // fontSize with its own lineHeight (the ui Text clipping trap).
    line: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
    detailsClip: { overflow: 'hidden' },
    // The lead row centres mark, sentence and ⌄ on ONE line: the sentence
    // block's centre (level with the 2nd of 3 lines, owner).
    // The lead row's press, 9pt into the card's 12pt padding above and below:
    // a one-line row (26pt) is still a 44pt target.
    leadPress: { ...StyleSheet.absoluteFillObject, top: -9, bottom: -9 },
    mark: { width: MARK_SIZE, height: MARK_SIZE, alignItems: 'center', justifyContent: 'center' },
    detailsBody: { position: 'absolute', top: 0, left: 0, right: 0 },
});

export default DashboardStatsCard;
