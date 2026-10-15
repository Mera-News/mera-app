// The feed status card's level 2, under the chevron (DashboardStatsCard; the
// card has ONE layout, its lead row saying the state):
//
// - `FeedStatusDetails`: Stage (at the daily limit or on a problem, that
//   state's title), scoring progress with its bar, Published / Analysed /
//   Relevant so far, Last processed. Values roll to a new number
//   (FinalFeedStatus #2); Reduce Motion swaps.
// - `FeedStatusActions`: the read hold's See plans, Read on this phone instead
//   and Show all articles, or a problem's Try now. Nothing in any other mode.
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
import { formatCount } from '@/lib/algorithms/format-count';
import { useRouter } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutUp, useReducedMotion } from 'react-native-reanimated';
import { themedStyles, useColors } from '@/lib/theme/tokens';
import { checkRequirements } from '@/lib/mera-protocol-toolkit/core/systemRequirements';
import { useSubscriptionTier } from '@/lib/stores/subscription-store';
import { navigateToTabScreen } from '@/components/custom/nav/navigate-to-page';
import { setFeedShow, setFeedView } from '@/components/custom/feed/feed-view-prefs';
import { useNotReadWaiting } from './feed-status-card';
import { syncFailureKey, syncFailureOf } from './card-state';
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
    const dailyLimitStage = mode === 'limited' ? t('feedStatus.modeLimited') : null;
    const errorStage = mode === 'error' ? t(SCORING_ERROR_I18N_KEYS[scoringError ?? 'generic'].title) : null;
    const failureKey = syncFailureKey(syncFailureOf(syncStatusMessage));
    const failureStage = failureKey ? tAny(failureKey) : null;
    const stageMessage = dailyLimitStage ?? errorStage ?? failureStage ?? (
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

export { limitUnlockTime } from '@/components/custom/cards/reset-time';

/** The read hold's and the error's actions, under the details (the lead row
 *  says the state): See plans, Read on this phone instead and Show all
 *  articles at the hold, Try now on a problem. Nothing in any other mode. */
export const FeedStatusActions: React.FC<{ readonly mode: FeedStatusMode }> = ({ mode }) => {
    const { t } = useTranslation();
    const router = useRouter();
    const { onRefresh } = useFeedSyncRefresh();
    const colors = useColors();
    const styles = useStyles();
    const tier = useSubscriptionTier();
    const waiting = useNotReadWaiting();
    // Resolved once: whether this phone can run Mera's reading itself.
    const [canReadOnPhone, setCanReadOnPhone] = React.useState(false);
    React.useEffect(() => {
        let alive = true;
        checkRequirements().then(
            (r) => alive && setCanReadOnPhone(r.supported),
            () => undefined,
        );
        return () => {
            alive = false;
        };
    }, []);
    if (mode !== 'limited' && mode !== 'error') return null;
    const pill = (label: string, onPress: () => void, testID: string, outline = false) => (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={testID} style={styles.pillFrame}>
            <View style={outline ? styles.pillOutline : styles.pill}>
                <Text style={[ROW_TYPE, { color: outline ? colors.ink : colors.onAccent, fontWeight: '600' }]}>{label}</Text>
            </View>
        </Pressable>
    );
    if (mode === 'limited') {
        return (
            <VStack className="mt-2" testID="feed-status-read-hold">
                <HStack className="justify-end mt-2 flex-wrap" style={{ gap: 8 }}>
                    {tier !== 'professional'
                        ? pill(
                              t('feedStatus.seePlans'),
                              () => router.push('/logged-in/preferences/manage-subscription' as never),
                              'feed-status-see-plans',
                          )
                        : null}
                    {canReadOnPhone
                        ? pill(
                              t('feedStatus.readOnPhone'),
                              () => navigateToTabScreen('you', 'mera-protocol', { params: { focus: 'on-device' } }),
                              'feed-status-read-on-phone',
                              true,
                          )
                        : null}
                    {waiting === null
                        ? pill(
                              t('feed.show.showAll'),
                              () => {
                                  setFeedView('continuous');
                                  setFeedShow('all');
                              },
                              'feed-status-show-all',
                              true,
                          )
                        : null}
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
    pillOutline: { borderColor: c.ink, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
}));

export default FeedStatusDetails;
