import React from 'react';
import { useHasFacts } from '@/components/custom/feed/use-has-facts';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useIsConnected } from '@/lib/stores/network-store';
import { useForYouScoringError, useForYouSyncStatusMessage } from '@/lib/stores/selectors';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useChatInCloud, useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import { SCORING_ERROR_I18N_KEYS } from '@/lib/services/scoring-error';
import { formatCount } from '@/lib/algorithms/format-count';
import { useTranslation } from 'react-i18next';
import { useReadHold, resetDayWord } from '@/lib/subscription/read-hold';
import { useNotReadWaiting } from './feed-status-card';
import { limitUnlockTime } from './FeedStatusDetails';
import { a11yStateKey } from './status-ink';
import { cardState, hasIssue, joinClauses, outageLanesOf, readHoldGap, readHoldSentenceKey, syncFailureKey, syncFailureOf, type CardState, type SyncFailure } from './card-state';
import { useUpgradeFrom } from './ReadHoldUpgradeButton';

/** A state's lead sentence, plain text (owner: no links; the reader finds
 *  Settings and their profile themselves; the limit's and the error's actions
 *  are in the details). */
function useStateText(kind: CardState | null, failure: SyncFailure | null): string | null {
    const { t, i18n } = useTranslation();
    const tAny = t as unknown as (key: string) => string;
    const appLanguage = useAppLanguage();
    const { articleCount, analysedCount, relevantCount } = useFeedCounts();
    const { resetAt } = useReadHold();
    const waiting = useNotReadWaiting();
    const scoringError = useForYouScoringError();
    const fmt = (count: number) => ({ count, formatted: formatCount(count, appLanguage) });
    if (kind === 'outage') return t('feed.outage.title');
    if (kind === 'limited') {
        const count = waiting ?? 0;
        const day = resetDayWord(resetAt ?? Date.now());
        const time = limitUnlockTime(resetAt);
        // Owner's final copy. `articleCount` is everything PUBLISHED, never "found for
        // you"; the reset time moved to level 2's last line (ReadHoldFooter).
        if (articleCount > 0)
            return joinClauses(
                [
                    t('feed.readHold.publishedToday', fmt(articleCount)),
                    ...(analysedCount > 0
                        ? [t('feed.readHold.readKept', { ...fmt(relevantCount), read: formatCount(analysedCount, appLanguage) })]
                        : []),
                ],
                i18n.language,
            );
        return t(readHoldSentenceKey(day, waiting), { count, formatted: formatCount(count, appLanguage), time });
    }
    if (kind === 'error') return t(SCORING_ERROR_I18N_KEYS[scoringError ?? 'generic'].message);
    // The key is computed from the failure, hence `tAny`.
    if (kind === 'syncFailed') return tAny(syncFailureKey(failure)!);
    if (kind === 'offline') return t('common.offlineBannerOffline');
    if (kind === 'fetched') return t('feed.statsZeroFetched');
    if (kind === 'analysed')
        return joinClauses([t('feed.statsPublished', fmt(articleCount)), t('feed.statsZeroAnalysedTail')], i18n.language);
    if (kind === 'relevant')
        return joinClauses(
            [
                t('feed.statsPublished', fmt(articleCount)),
                t('feed.statsAnalysed', fmt(analysedCount)),
                t('feed.statsZeroRelevantTail'),
            ],
            i18n.language,
        );
    return null;
}

/** The down lanes this reader's setup uses (cloud: all four; On this phone: chat only when chat runs in the cloud). */
export function useOutageLanes() {
    const down = useForYouStore((s) => s.laneOutage);
    const onDevice = useIsOnDeviceProcessing();
    const chatInCloud = useChatInCloud();
    return React.useMemo(() => outageLanesOf(down, { onDevice, chatInCloud }), [down, onDevice, chatInCloud]);
}

/** Whether the Feed has an issue (see `hasIssue`): the card shows and the first-sync scene gives way. */
export function useFeedIssue(): boolean {
    const outage = useOutageLanes().length > 0;
    return hasIssue(useFeedStatusMode(), syncFailureOf(useForYouSyncStatusMessage()), outage);
}

/** The counts card's lead line: the mode, the counts, the card state and the
 *  sentence or status label that leads the card. */
export function useStatsCardLead() {
    const { t } = useTranslation();
    // `a11yStateKey` is computed from the mode; see its own note on `tAny`.
    const tAny = t as unknown as (key: string) => string;
    const mode = useFeedStatusMode();
    const { articleCount, analysedCount, relevantCount } = useFeedCounts();
    // Not the list's emptiness (an empty Feed past a run, exactly where a zero needs
    // explaining): with no facts at all the no-facts card owns the Feed.
    const noFacts = useHasFacts() === false;
    const offline = useIsConnected() === false;
    const syncFailure = syncFailureOf(useForYouSyncStatusMessage());
    const outageLanes = useOutageLanes();
    const state = cardState({ mode, noFacts, offline, articleCount, analysedCount, relevantCount, syncFailure, outageLanes });
    const zeroText = useStateText(state, syncFailure);
    const stateLabel = tAny(a11yStateKey(mode));
    const processing = mode === 'processing';
    // The held card's bar draws the same gap the sentence names.
    const waiting = useNotReadWaiting();
    const gap = state === 'limited' ? readHoldGap(articleCount, analysedCount, waiting) : null;
    // Line 2: only where an upgrade exists and something waits (0 waiting: no line).
    const upgradeFrom = useUpgradeFrom();
    const appLanguage = useAppLanguage();
    const upsell =
        state === 'limited' && upgradeFrom !== null && waiting != null && waiting > 0
            ? t('feed.readHold.upsell', { count: waiting, formatted: formatCount(waiting, appLanguage) })
            : null;
    return { mode, outageLanes, articleCount, state, zeroText, stateLabel, processing, gap, upsell };
}
