// The feed status card's two bodies (DashboardStatsCard):
//
// - `FeedStatusDetails`, level 2 under the chevron: Stage, scoring progress
//   with its bar, Published / Analysed / Relevant so far, Last processed.
//   Values roll to a new number (FinalFeedStatus #2); Reduce Motion swaps.
// - `FeedStatusNotice`, the whole card at the daily limit or on a problem
//   (FinalFeedStatus #4, #5): what happened, when it clears, one action, and
//   Last processed. No count sentence and no stage rows there.
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
    useForYouDailyLimitResetAt,
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
import { COLORS, useColors } from '@/lib/theme/tokens';
import { pickScoringProgress, STATUS_INK } from './status-ink';
import { useLastProcessedLabel } from './use-last-processed-label';

/** Explicit size AND line height: an inline fontSize on the ui Text keeps the
 *  token's smaller line box and clips (see the mera-app-feed fontSize trap). */
const ROW_TYPE = { fontSize: 14, lineHeight: 20 } as const;

function StatRow({ label, value, testID }: { label: string; value: string; testID?: string }) {
    const reduceMotion = useReducedMotion();
    return (
        <HStack className="items-center justify-between py-1" testID={testID}>
            <Text style={[ROW_TYPE, { color: STATUS_INK.secondary }]}>{label}</Text>
            {/* Keyed by value, so a change mounts a new node that rolls in. */}
            <Animated.Text
                key={value}
                entering={reduceMotion ? undefined : FadeInDown.duration(220)}
                exiting={reduceMotion ? undefined : FadeOutUp.duration(160)}
                style={[ROW_TYPE, { color: STATUS_INK.primary, fontWeight: '600' }]}
            >
                {value}
            </Animated.Text>
        </HStack>
    );
}

/** Level 2: the details inside the card. */
const FeedStatusDetails: React.FC = () => {
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

    const isSyncActive =
        syncStatusMessage !== null &&
        syncStatusMessage.state !== 'idle' &&
        syncStatusMessage.state !== 'done' &&
        syncStatusMessage.state !== 'failed' &&
        syncStatusMessage.state !== 'paused-offline';

    // Cloud/device phases take precedence over the raw sync-machine state.
    // `headlineKey` is computed, hence `tAny`.
    const stageMessage =
        asyncJobPhase === 'relevance'
            ? t('feed.syncToast.relevanceTitle')
            : asyncJobPhase === 'reasons'
              ? t('feed.syncToast.reasonsTitle')
              : isDeviceProcessing
                ? t('feed.syncToast.onDeviceTitle')
                : isSyncActive && syncStatusMessage?.headlineKey
                  ? tAny(syncStatusMessage.headlineKey)
                  : t('feedStatus.idle');

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
    if (!batchProgress || batchProgress.total <= 0 || !progress) return null;
    return (
        <Text style={{ fontSize: 12, lineHeight: 17, color: STATUS_INK.secondary, marginTop: 4 }}>
            {t('feed.analysingProgress', { done: progress.done, total: progress.total })}
        </Text>
    );
}

/** The daily-limit and problem cards. Renders nothing in any other mode. */
export const FeedStatusNotice: React.FC<{
    readonly mode: FeedStatusMode;
    /** Called before "Manage plan" or the upgrade link navigates. */
    readonly onBeforeNavigate?: () => void;
}> = ({ mode, onBeforeNavigate }) => {
    const { t } = useTranslation();
    const router = useRouter();
    const lastProcessedLabel = useLastProcessedLabel();
    const dailyLimitResetAt = useForYouDailyLimitResetAt();
    const scoringError = useForYouScoringError();
    const { onRefresh } = useFeedSyncRefresh();
    const colors = useColors();
    if (mode !== 'limited' && mode !== 'error') return null;

    const managePlan = () => {
        onBeforeNavigate?.();
        router.push('/logged-in/preferences/manage-subscription' as never);
    };
    const lastRow = lastProcessedLabel ? (
        <StatRow label={t('feedStatus.lastProcessed')} value={lastProcessedLabel} />
    ) : null;

    if (mode === 'limited') {
        // Device timezone from an absolute instant: the cap resets at 00:00
        // UTC, so "tomorrow" would be false west of UTC. The sync machine always
        // supplies a reset instant; the gallery's injected mode may not.
        const time = dailyLimitResetAt
            ? new Date(dailyLimitResetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            : '';
        return (
            <VStack testID="feed-status-daily-limit">
                <Text style={[ROW_TYPE, { color: colors.accentText, fontWeight: '600' }]}>
                    {t('feed.dailyLimit.title')}
                </Text>
                <Text style={[ROW_TYPE, { color: STATUS_INK.secondary, marginTop: 4 }]}>
                    {t('feed.dailyLimit.bodyWithTime', { time })}{' '}
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
                    <Pressable
                        onPress={managePlan}
                        accessibilityRole="button"
                        accessibilityLabel={t('subscription.managePlan')}
                        testID="feed-status-manage-subscription"
                        style={styles.pillFrame}
                    >
                        <View style={styles.pill}>
                            <Text style={[ROW_TYPE, { color: colors.onAccent, fontWeight: '600' }]}>
                                {t('subscription.managePlan')}
                            </Text>
                        </View>
                    </Pressable>
                </HStack>
                {lastRow}
            </VStack>
        );
    }

    const keys = SCORING_ERROR_I18N_KEYS[scoringError ?? 'generic'];
    return (
        <VStack testID="feed-status-error">
            <Text style={[ROW_TYPE, { color: colors.negative, fontWeight: '600' }]}>{t(keys.title)}</Text>
            <Text style={[ROW_TYPE, { color: STATUS_INK.secondary, marginTop: 4 }]}>
                {t(keys.message)}{' '}
                <Text
                    onPress={() => onRefresh()}
                    accessibilityRole="button"
                    testID="feed-status-try-now"
                    style={[ROW_TYPE, { color: colors.accentText }]}
                >
                    {t('feedStatus.tryNow')}
                </Text>
            </Text>
            <View style={{ marginTop: 6 }}>{lastRow}</View>
        </VStack>
    );
};

const styles = StyleSheet.create({
    track: { height: 4, borderRadius: 2, backgroundColor: STATUS_INK.divider, marginBottom: 4 },
    bar: { height: 4, borderRadius: 2, backgroundColor: COLORS.dark.accent },
    // A 44pt frame around a 30pt pill, margins given back so the row keeps its
    // height (never hitSlop: QA measures a hitSlop target as its glyph box).
    pillFrame: { minHeight: 44, justifyContent: 'center', marginVertical: -7 },
    pill: { backgroundColor: COLORS.dark.accent, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
});

export default FeedStatusDetails;
