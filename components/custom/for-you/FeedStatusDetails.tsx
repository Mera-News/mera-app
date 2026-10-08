// The feed status card's level 2, under the chevron (DashboardStatsCard; the
// card has ONE layout, its lead row saying the state):
//
// - `FeedStatusDetails`: Stage (at the daily limit or on a problem, that
//   state's title), scoring progress with its bar, Published / Analysed /
//   Relevant so far, Last processed. Values roll to a new number
//   (FinalFeedStatus #2); Reduce Motion swaps.
// - `FeedStatusActions`: the limit's "Or upgrade your plan." and Manage plan,
//   or a problem's Try now. Nothing in any other mode.
//
// The counts come from the shared minute-clock `useFeedCounts`, so they match
// the sentence on level 1.

import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useFeedSyncRefresh } from '@/components/custom/FeedSyncIndicator';
import { type FeedStatusMode } from '@/lib/feed-status-mode';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { SCORING_ERROR_I18N_KEYS } from '@/lib/services/scoring-error';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import {
    useForYouAsyncJobPhase,
    useForYouAsyncJobProcessedCount,
    useForYouAsyncJobTotalCount,
    useForYouBatchProgress,
    useForYouDeviceProcessing,
    useForYouScoringError,
    useForYouSyncStatusMessage,
} from '@/lib/stores/selectors';
import { formatCount } from '@/lib/utils/format-count';
import { useRouter } from 'expo-router';
import React from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutUp, useReducedMotion } from 'react-native-reanimated';
import { themedStyles, useColors } from '@/lib/theme/tokens';
import { pickScoringProgress } from './status-ink';
import { useLastProcessedLabel } from './use-last-processed-label';

/** Explicit size AND line height: an inline fontSize on the ui Text keeps the
 *  token's smaller line box and clips (see the mera-app-feed fontSize trap). */
const ROW_TYPE = { fontSize: 14, lineHeight: 20 } as const;

function StatRow({ label, value, testID }: { label: string; value: string; testID?: string }) {
    const reduceMotion = useReducedMotion();
    const c = useColors();
    return (
        <HStack className="items-center justify-between py-1" testID={testID}>
            <Text style={[ROW_TYPE, { color: c.ink }]}>{label}</Text>
            {/* Keyed by value, so a change mounts a new node that rolls in. */}
            <Animated.Text
                key={value}
                entering={reduceMotion ? undefined : FadeInDown.duration(220)}
                exiting={reduceMotion ? undefined : FadeOutUp.duration(160)}
                style={[ROW_TYPE, { color: c.ink, fontWeight: '600' }]}
            >
                {value}
            </Animated.Text>
        </HStack>
    );
}

/** Level 2: the details inside the card. `mode` is the card's own, so the
 *  Stage row can never say "Up to date" under "Updating your feed". */
const FeedStatusDetails: React.FC<{ readonly mode: FeedStatusMode }> = ({ mode }) => {
    const { t } = useTranslation();
    const tAny = t as unknown as (key: string) => string;
    const appLanguage = useAppLanguage();
    const { articleCount, analysedCount, relevantCount } = useFeedCounts();
    const batchProgress = useForYouBatchProgress();
    const lastProcessedLabel = useLastProcessedLabel();
    const syncStatusMessage = useForYouSyncStatusMessage();
    const asyncJobPhase = useForYouAsyncJobPhase();
    const asyncDone = useForYouAsyncJobProcessedCount();
    const asyncTotal = useForYouAsyncJobTotalCount();
    const { isDeviceProcessing, deviceProcessedCount, deviceTotalCount } = useForYouDeviceProcessing();
    const scoringError = useForYouScoringError();
    const styles = useStyles();

    const isSyncActive =
        syncStatusMessage !== null &&
        syncStatusMessage.state !== 'idle' &&
        syncStatusMessage.state !== 'done' &&
        syncStatusMessage.state !== 'failed' &&
        syncStatusMessage.state !== 'paused-offline';

    // Cloud/device phases take precedence over the raw sync-machine state.
    // `headlineKey` is computed, hence `tAny`.
    const dailyLimitStage = mode === 'limited' ? t('feed.dailyLimit.title') : null;
    const errorStage = mode === 'error' ? t(SCORING_ERROR_I18N_KEYS[scoringError ?? 'generic'].title) : null;
    const stageMessage = dailyLimitStage ?? errorStage ?? (
        asyncJobPhase === 'relevance'
            ? t('feed.syncToast.relevanceTitle')
            : asyncJobPhase === 'reasons'
              ? t('feed.syncToast.reasonsTitle')
              : isDeviceProcessing
                ? t('feed.syncToast.onDeviceTitle')
                : isSyncActive && syncStatusMessage?.headlineKey
                  ? tAny(syncStatusMessage.headlineKey)
                  : mode === 'processing'
                    ? t('feedStatus.modeProcessing')
                    : t('feedStatus.idle'));

    // ONE scoring figure, shared with the "Analysing X of Y" line.
    const cloud = pickScoringProgress(batchProgress, asyncDone, asyncTotal);
    const fmt = (n: number) => formatCount(n, appLanguage);

    return (
        <VStack className="pt-2" testID="feed-status-details">
            <StatRow label={t('feedStatus.stage')} value={stageMessage} testID="feed-status-stage-row" />
            {cloud ? (
                <>
                    <StatRow label={t('feedStatus.cloudProgress')} value={`${fmt(cloud.done)} / ${fmt(cloud.total)}`} />
                    <View style={styles.track}>
                        <View
                            style={[styles.bar, { width: `${Math.min(100, (cloud.done / cloud.total) * 100)}%` }]}
                        />
                    </View>
                </>
            ) : null}
            {deviceTotalCount > 0 ? (
                <StatRow
                    label={t('feedStatus.deviceProgress')}
                    value={`${fmt(deviceProcessedCount)} / ${fmt(deviceTotalCount)}`}
                />
            ) : null}
            <StatRow label={t('feedStatus.published')} value={fmt(articleCount)} />
            <StatRow label={t('feedStatus.analysed')} value={fmt(analysedCount)} />
            <StatRow label={t('feedStatus.relevant')} value={fmt(relevantCount)} />
            {lastProcessedLabel ? <StatRow label={t('feedStatus.lastProcessed')} value={lastProcessedLabel} /> : null}
        </VStack>
    );
};

/** "Analysing X of Y articles", from the same figure as the scoring row, so
 *  the two can never name different totals. Nothing until a total is known. */
export function AnalysingProgress() {
    const { t } = useTranslation();
    const batchProgress = useForYouBatchProgress();
    const asyncDone = useForYouAsyncJobProcessedCount();
    const asyncTotal = useForYouAsyncJobTotalCount();
    const progress = pickScoringProgress(batchProgress, asyncDone, asyncTotal);
    const c = useColors();
    if (!batchProgress || batchProgress.total <= 0 || !progress) return null;
    return (
        <Text style={{ fontSize: 12, lineHeight: 17, color: c.ink, marginTop: 4 }}>
            {t('feed.analysingProgress', { done: progress.done, total: progress.total })}
        </Text>
    );
}

/** When new articles unlock, in the device's own clock. The cap resets at
 *  00:00 UTC, so "tomorrow" would be false west of UTC. The sync machine
 *  always stores a reset instant; without one (an injected mode, a cleared
 *  store) the next UTC midnight IS the reset, so the sentence never reads
 *  "unlock at .". */
export function limitUnlockTime(resetAt: number | null, now: Date = new Date()): string {
    const at = resetAt ?? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The daily limit's and the error's actions, under the details (the lead
 *  row says the state): "Or upgrade your plan." and Manage plan at the limit,
 *  Try now on a problem. Nothing in any other mode. */
export const FeedStatusActions: React.FC<{ readonly mode: FeedStatusMode }> = ({ mode }) => {
    const { t } = useTranslation();
    const router = useRouter();
    const { onRefresh } = useFeedSyncRefresh();
    const colors = useColors();
    const styles = useStyles();
    if (mode !== 'limited' && mode !== 'error') return null;
    const managePlan = () => router.push('/logged-in/preferences/manage-subscription' as never);
    const pill = (label: string, onPress: () => void, testID: string) => (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={testID} style={styles.pillFrame}>
            <View style={styles.pill}>
                <Text style={[ROW_TYPE, { color: colors.onAccent, fontWeight: '600' }]}>{label}</Text>
            </View>
        </Pressable>
    );
    if (mode === 'limited') {
        return (
            <VStack className="mt-2" testID="feed-status-daily-limit">
                <Text style={[ROW_TYPE, { color: colors.ink }]}>
                    <Trans
                        i18nKey="feedStatus.limitUpgrade"
                        components={[
                            <Text
                                key="upgrade"
                                onPress={managePlan}
                                accessibilityRole="link"
                                style={[ROW_TYPE, { color: colors.accentText }]}
                            />,
                        ]}
                    />
                </Text>
                <HStack className="justify-end mt-2">
                    {pill(t('subscription.managePlan'), managePlan, 'feed-status-manage-subscription')}
                </HStack>
            </VStack>
        );
    }
    return (
        <HStack className="justify-end mt-2" testID="feed-status-error">
            {pill(t('feedStatus.tryNow'), () => onRefresh(), 'feed-status-try-now')}
        </HStack>
    );
};

const useStyles = themedStyles((c) => StyleSheet.create({
    track: { height: 4, borderRadius: 2, backgroundColor: c.line, marginBottom: 4 },
    bar: { height: 4, borderRadius: 2, backgroundColor: c.accent },
    // A 44pt frame around a 30pt pill, margins given back so the row keeps its
    // height (never hitSlop: QA measures a hitSlop target as its glyph box).
    pillFrame: { minHeight: 44, justifyContent: 'center', marginVertical: -7 },
    pill: { backgroundColor: c.accent, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
}));

export default FeedStatusDetails;
