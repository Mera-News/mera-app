import { useHasFacts } from '@/components/custom/feed/use-has-facts';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useIsConnected } from '@/lib/stores/network-store';
import { useForYouDailyLimitResetAt, useForYouScoringError, useForYouSyncStatusMessage } from '@/lib/stores/selectors';
import { SCORING_ERROR_I18N_KEYS } from '@/lib/services/scoring-error';
import { formatCount } from '@/lib/utils/format-count';
import { useTranslation } from 'react-i18next';
import { limitUnlockTime } from './FeedStatusDetails';
import { a11yStateKey } from './status-ink';
import { cardState, joinClauses, syncFailureKey, syncFailureOf, type CardState, type SyncFailure } from './card-state';

/** A state's lead sentence, plain text (owner: no links; the reader finds
 *  Settings and their profile themselves; the limit's and the error's actions
 *  are in the details). */
function useStateText(kind: CardState | null, failure: SyncFailure | null): string | null {
    const { t, i18n } = useTranslation();
    const tAny = t as unknown as (key: string) => string;
    const appLanguage = useAppLanguage();
    const { articleCount, analysedCount } = useFeedCounts();
    const resetAt = useForYouDailyLimitResetAt();
    const scoringError = useForYouScoringError();
    const fmt = (count: number) => ({ count, formatted: formatCount(count, appLanguage) });
    if (kind === 'limited') return t('feed.dailyLimit.bodyWithTime', { time: limitUnlockTime(resetAt) });
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
    const state = cardState({ mode, noFacts, offline, articleCount, analysedCount, relevantCount, syncFailure });
    const zeroText = useStateText(state, syncFailure);
    const stateLabel = tAny(a11yStateKey(mode));
    const processing = mode === 'processing';
    return { mode, articleCount, state, zeroText, stateLabel, processing };
}
