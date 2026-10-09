import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { ArticleFeedbackPrompt } from '@/components/custom/ArticleFeedbackPrompt';
import { ArticleSuggestionContainer } from '@/components/custom/ArticleSuggestionContainer';
import FactCheckPanel from '@/components/custom/news-detail/FactCheckPanel';
import ReadTranslateActions from '@/components/custom/news-detail/ReadTranslateActions';
import RelatedCoverage from '@/components/custom/news-detail/RelatedCoverage';
import PublicationVisitBadge from '@/components/custom/PublicationVisitBadge';
import ScrollToTopFab from '@/components/custom/ScrollToTopFab';
import { MERA_BUTTON_BAR_GAP, MERA_BUTTON_SIZE } from '@/lib/navigation/tab-bar';
import DetailTopBar from '@/components/custom/news-detail/DetailTopBar';
import StatusBarScrim from '@/components/custom/StatusBarScrim';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    getSubscribedCoverageForArticle,
    type SubscribedCoverage,
} from '@/lib/database/services/subscribed-sibling-service';
import { isOpenedId } from '@/lib/stores/fact-rows-selector';
import InlineChoiceChip from '@/components/custom/nav/InlineChoiceChip';
import { RELATED_SORT_LABEL } from '@/components/custom/news-detail/RelatedCoverage';
import { RELATED_SORT_MODES } from '@/lib/stores/related-sort-store';
import { secureUrlOrNull } from '@/lib/secure-url';
import { MaterialIcons } from '@expo/vector-icons';
import { useColors } from '@/lib/theme/tokens';
import { useArticleDetailScreen } from '@/components/custom/news-detail/useArticleDetailScreen';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import FactCheckCard from '@/components/custom/fact-checks/FactCheckCard';
import { DisplayPublicationName } from '@/lib/stores/publication-display-store';
import { notifyScrollTick } from '@/lib/visibility-tick';

interface ArticleDetailScreenProps {
    articleId: string;
    onBack: () => void;
    backIcon?: 'back' | 'home';
    /** Stable story id from nav params, when the caller already knows it. When
     *  absent, the track flow resolves it lazily via getNewsClusterForArticle. */
    stableClusterId?: string;
    /** The article this page was opened from (a Related row): its own Related
     *  list leads with it. */
    fromArticleId?: string;
}

/** The page ends 12pt above the Mera button's bottom-corner position. */
const LIST_END_ABOVE_MERA = MERA_BUTTON_BAR_GAP + MERA_BUTTON_SIZE + 12;
/** ScrollToTopFab adds its own 20 to this. */
const ABOVE_MERA_BUTTON = LIST_END_ABOVE_MERA - 20;

/**
 * "From your subscriptions" — coverage of this story by a publication the user
 * pays for.
 *
 * Sourced LOCALLY from `article_suggestions` via the story's stable cluster id,
 * not by partitioning the server-paged related list. Two consequences worth
 * knowing before changing it:
 *
 *  - It never removes anything from "Related coverage" below. The two lists
 *    are independent, so an entry can legitimately appear in both.
 *  - It inherits no ordering from `orderRelatedArticles`, so it states its own:
 *    newest publication first, chosen in `findSubscribedSiblings`.
 *
 * Three states, and the middle one is the one people get wrong: a sibling whose
 * `subscription_read` is still null renders the CARD WITH NO READ LINE. No
 * spinner, no "analysing" — a read may never be written for this row, and a
 * permanent spinner would be a lie.
 *
 * Nothing here may imply we read the full article. The read is built from the
 * sibling's title, English description and existing enrichment; subscription
 * publishers paywall their bodies and we never fetch one.
 */
const SubscribedCoverageBlock: React.FC<{ readonly articleId: string }> = ({ articleId }) => {
    const { t } = useTranslation();
    const [coverage, setCoverage] = useState<SubscribedCoverage | null>(null);

    useEffect(() => {
        let cancelled = false;
        void getSubscribedCoverageForArticle(articleId).then((result) => {
            if (!cancelled) setCoverage(result);
        });
        return () => {
            cancelled = true;
        };
    }, [articleId]);

    // Absent, not empty: no subscribed sibling means no heading either.
    if (!coverage) return null;

    return (
        <VStack space="md">
            <Heading size="lg" className="text-ink">
                {t('articleDetail.relatedFromSubscriptions')}
            </Heading>
            <VStack space="sm">
                {coverage.publicationName ? (
                    <Text size="sm" className="text-ink-2">
                        <DisplayPublicationName name={coverage.publicationName} />
                    </Text>
                ) : null}
                {coverage.titleEn ? (
                    <Text size="md" className="text-ink">
                        {coverage.titleEn}
                    </Text>
                ) : null}
                <Text size="sm" className="text-ink-2">
                    {t('subscriptions.coversThisStory')}
                </Text>
                {coverage.read ? (
                    <Text size="sm" className="text-ink">
                        {coverage.read}
                    </Text>
                ) : null}
            </VStack>
        </VStack>
    );
};

const ArticleDetailScreen: React.FC<ArticleDetailScreenProps> = ({
    articleId,
    onBack,
    backIcon = 'back',
    stableClusterId,
    fromArticleId,
}) => {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const {
        article,
        isSaved,
        isLoading,
        error,
        factCheckPhase,
        aiAccess,
        orphanFactChecks,
        offlineUnavailable,
        snapshotSource,
        showScrollToTop,
        titleDisplay,
        handleTitleDisplayChange,
        relatedRows,
        isLoadingRelated,
        isLoadingMoreRelated,
        loadMoreRelated,
        relatedError,
        retryRelated,
        relatedSortMode,
        setRelatedSortMode,
        scrollViewRef,
        openedIds,
        handleScrollPositionChange,
        scrollToTop,
        scrollToRelated,
        factCheckAsked,
        handleStartFactCheck,
        handleToggleSave,
        handleArticleUrlPress,
    } = useArticleDetailScreen({ articleId, stableClusterId });


    if (isLoading) {
        return (
            <Box className="flex-1 items-center justify-center">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <Spinner size="large" />
                {/* S8: a way back while loading (the by-id query can take up
                    to 30s on a slow network before it aborts). */}
                <DetailTopBar onBack={onBack} backIcon={backIcon} />
            </Box>
        );
    }

    if (offlineUnavailable) {
        // Offline, and no local snapshot to fall back to — a friendlier,
        // non-alarming empty state (not the red "error" card) since this is
        // an expected condition, not a failure. Auto-retries when
        // connectivity returns (see the retryNonce effect above).
        return (
            <Box className="flex-1 items-center justify-center p-5">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <MaterialIcons
                    name="wifi-off"
                    size={48}
                    color={colors.ink2}
                    accessibilityElementsHidden={true}
                    importantForAccessibility="no-hide-descendants"
                />
                <Text size="lg" className="text-ink mt-4 text-center">
                    {t('articleDetail.offlineUnavailable')}
                </Text>
                <Pressable onPress={onBack} className="mt-6 bg-surface-raised rounded-lg px-6 py-3">
                    <Text size="md" className="text-ink">{t('common.goBack')}</Text>
                </Pressable>
            </Box>
        );
    }

    if (error || !article) {
        return (
            // ScrollView, not a centred Box: this state can now carry a fact
            // check, which is taller than the screen once it lists several
            // organisations.
            <Box className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <ScrollView
                    // Rows below the first screen ask for their translation only
                    // when a scroll tick finds them on screen (lib/visibility-tick).
                    onScroll={notifyScrollTick}
                    scrollEventThrottle={16}
                    onContentSizeChange={notifyScrollTick}
                    contentContainerStyle={{
                        flexGrow: 1,
                        justifyContent: orphanFactChecks.length > 0 ? 'flex-start' : 'center',
                        alignItems: 'center',
                        padding: 20,
                        paddingTop: orphanFactChecks.length > 0 ? insets.top + 24 : 20,
                        paddingBottom: insets.bottom + 40,
                    }}
                >
                    <MaterialIcons
                        name="error-outline"
                        size={48}
                        color={colors.negative}
                        accessibilityElementsHidden={true}
                        importantForAccessibility="no-hide-descendants"
                    />
                    <Text size="lg" className="text-ink mt-4 text-center">
                        {error || t('articleDetail.articleNotFound')}
                    </Text>

                    {/* THE 48h CASE. `NewsArticle` rows are swept at 48h while
                        `fact_checks` rows deliberately outlive them, so every
                        fact check older than ~2 days lands here — that is the
                        normal state of an older row, not an edge case. The
                        reader tapped a fact check; losing it to a bare "Article
                        not found" would throw away everything the device still
                        holds for it — post-v52 that can be SEVERAL rows, one
                        per claim the reader asked about. No `onPress`: there is
                        nowhere further to go. Gated with the panel below: a
                        reader who turned fact checking off must not meet it
                        here either, on rows mirrored before they did. */}
                    {orphanFactChecks.length > 0 && (
                        <Box className="w-full mt-6" testID="article-detail-orphan-fact-check">
                            <Text size="sm" className="text-typography-400 text-center mb-3">
                                {t('factCheck.dashboard.articleGone')}
                            </Text>
                            <VStack space="sm">
                                {orphanFactChecks.map((item) => (
                                    <FactCheckCard
                                        key={item.id}
                                        item={item}
                                        testIDPrefix="article-detail-fact-check"
                                    />
                                ))}
                            </VStack>
                        </Box>
                    )}

                    <Pressable onPress={onBack} className="mt-6 bg-surface-raised rounded-lg px-6 py-3">
                        <Text size="md" className="text-ink">{t('common.goBack')}</Text>
                    </Pressable>
                </ScrollView>
            </Box>
        );
    }

    const sourceLanguage = article.original_language_code ?? null;
    // Item 16 (defence in depth): the server already drops insecure articles
    // from every serving path, but a row restored from a local snapshot (saved
    // article, 30-day publication-visit history) can predate that filter. An
    // `http://` URL is treated as UNAVAILABLE — an explicit notice replaces the
    // read/translate/share block — never as a button that quietly does nothing.
    const rawArticleUrl = article.article_url ?? null;
    const articleUrl = secureUrlOrNull(rawArticleUrl);
    const insecureLink = !!rawArticleUrl && !articleUrl;
    const read = isOpenedId(article._id, stableClusterId, openedIds);
    // Keyed on the ARTICLE id. `startedByReader` shows the working state at
    // once for a check the reader just asked for (no progress delay, and no
    // toast: the panel is right under the tick).
    const factCheckPanel = (
        <FactCheckPanel articleId={article._id ?? articleId} startedByReader={factCheckAsked} />
    );

    return (
        <Box className="flex-1">
            {/* Page background. Must be the FIRST child so it paints behind
                everything else on the page. */}
            <AbstractGradientBackdrop />

            {/* Status bar scrim in `overHero` mode (T-1): only a soft top-down
                fade inside the status-bar height, so the white clock and
                battery glyphs stay readable over a light photo. No dark band
                at ANY scroll position (owner: "earlier in detail page i never
                saw this dark header. even when scrolled up."): content scrolls
                freely under the status area. zIndex 5, below the back button
                (20), which floats on its own dark circle. */}
            <StatusBarScrim overHero />

            <DetailTopBar onBack={onBack} backIcon={backIcon} />

            <ArticleSuggestionContainer
                article={article}
                variant="screen"
                read={read}
                onTitleDisplayChange={handleTitleDisplayChange}
                scrollViewRef={scrollViewRef}
                onScrollPositionChange={handleScrollPositionChange}
                onEndReached={loadMoreRelated}
                contentTopInset={insets.top}
                contentBottomInset={insets.bottom + LIST_END_ABOVE_MERA}
                aboveReason={
                    <>
                        {/* Only the 'saved' snapshot gets a banner. That one is
                            the offline path, where "showing cached content" is
                            true and the read button may not even work.
                            'visit' and 'retained' are deliberately silent: both
                            happen ONLINE, and the only thing missing is Mera's
                            server copy — the publisher's page is right there and
                            the read/translate block below opens it. Every warning
                            string this app owns ("no longer available",
                            "offline: showing cached") would contradict the
                            working Read button a few lines further down. An
                            honest string — "Mera no longer has this story, you
                            can still open it at the publisher" — is new copy, and
                            new copy means the 20-locale wave. */}
                        {snapshotSource === 'saved' && (
                            <HStack className="items-center bg-warning-900 rounded-lg px-3 py-2 mb-2" space="sm">
                                <Icon as={AlertCircleIcon} size="sm" className="text-warning-400" />
                                <Text size="sm" className="text-warning-400">{t('feed.offlineCached')}</Text>
                            </HStack>
                        )}
                        <PublicationVisitBadge
                            publicationName={article.publicationSource?.publication_name}
                            countryCode={article.publicationSource?.country_code}
                        />
                    </>
                }
                footer={
                    <>
                        {articleUrl ? (
                            <VStack space="md">
                                <ArticleFeedbackPrompt
                                    // Hidden entirely on a locked free-tier plan
                                    // (the server resolvers are behind
                                    // SubscriptionGuard) or when the reader has
                                    // turned fact checking off.
                                    // `requestArticleFactCheck` no-ops in both
                                    // cases too (belt-and-suspenders, see that
                                    // file), but a tick that visibly does
                                    // nothing is worse than no tick at all.
                                    //
                                    // NO LONGER hidden on on-device processing:
                                    // that gate existed because the CHAT's
                                    // claim picker is cloud-only, and the tick
                                    // no longer opens a chat — it asks the
                                    // server, which needs no cloud chat.
                                    factCheck={aiAccess !== 'locked' ? {
                                        onStart: () => handleStartFactCheck(),
                                        // 'stalled' reads as 'pending' here too —
                                        // the tick only has a single/double
                                        // vocabulary (asked-or-unasked vs
                                        // answered), and a poll that gave up is
                                        // still "asked, no answer yet" from the
                                        // tick's point of view. The PANEL is
                                        // where 'stalled' gets its own honest copy.
                                        state: factCheckPhase === 'terminal'
                                            ? 'done'
                                            : factCheckPhase === 'processing' || factCheckPhase === 'stalled'
                                                ? 'pending'
                                                : 'none',
                                    } : undefined}
                                    articleId={article._id ?? articleId}
                                    title={article.title_en_internal_only ?? article.title ?? ''}
                                    // REQUIRED: this screen also serves articles
                                    // with NO local article_suggestions row
                                    // (Explore, a tracked story, a shared link).
                                    // Without it those verdicts persist an empty
                                    // context and the feedback tree has no
                                    // publication / category / event / place to
                                    // act on — the gap this wave closed.
                                    article={article}
                                    publicationName={article.publicationSource?.publication_name ?? null}
                                    onBrowseRelated={scrollToRelated}
                                    save={{ saved: isSaved, onToggle: handleToggleSave }}
                                    track={{
                                        origin: 'article',
                                        surface: 'detail',
                                        articleId: article._id ?? articleId,
                                        title: article.title_en_internal_only ?? article.title ?? '',
                                        // See ArticleSuggestionScreen — omitting
                                        // this makes the timeline's seed row show
                                        // the track moment instead of the
                                        // article's publication age.
                                        pubDate: article.pubDate ?? null,
                                        publicationName: article.publicationSource?.publication_name,
                                        countryCode: article.publicationSource?.country_code,
                                        stableClusterId,
                                    }}
                                    share={{
                                        url: articleUrl,
                                        titleEnglish: article.title_en_internal_only ?? article.title,
                                        titleOriginal: article.title,
                                        sourceLanguage: article.original_language_code,
                                        displayedTitle: titleDisplay?.text ?? null,
                                        displayedLanguage: titleDisplay?.language ?? null,
                                    }}
                                />
                                {/* F33: the fact check sits DIRECTLY under the action
                                    row whose tick starts it, so its "Searching" line
                                    and its result land where the reader asked, not
                                    at the very end of the footer below the fold. */}
                                {factCheckPanel}
                                <ReadTranslateActions
                                    articleUrl={articleUrl}
                                    sourceLanguage={sourceLanguage}
                                    publicationName={article.publicationSource?.publication_name}
                                    onOpenUrl={handleArticleUrlPress}
                                />
                            </VStack>
                        ) : insecureLink ? (
                            <HStack className="items-center bg-warning-900 rounded-lg px-3 py-2" space="sm">
                                <Icon as={AlertCircleIcon} size="sm" className="text-warning-400" />
                                <Text size="sm" className="text-warning-400 flex-1">
                                    {t('articleDetail.linkUnavailable')}
                                </Text>
                            </HStack>
                        ) : null}

                        {/* No link to open: the panel still renders (it is keyed
                            on the article id), just without the actions above it. */}
                        {!articleUrl && factCheckPanel}

                        <SubscribedCoverageBlock articleId={article._id ?? articleId} />

                        <RelatedCoverage
                            rows={relatedRows}
                            selfArticleId={article._id ?? articleId}
                            fromArticleId={fromArticleId}
                            loading={isLoadingRelated}
                            loadingMore={isLoadingMoreRelated}
                            error={!!relatedError}
                            onRetry={retryRelated}
                            headerAccessory={
                                <InlineChoiceChip
                                    options={RELATED_SORT_MODES}
                                    value={relatedSortMode}
                                    labelOf={(m) => t(RELATED_SORT_LABEL[m])}
                                    a11yLabelOf={(m) => t(RELATED_SORT_LABEL[m])}
                                    onChange={setRelatedSortMode}
                                    testID="related-sort"
                                />
                            }
                        />
                    </>
                }
            />
            {/* Above the Mera button's bottom corner, never under it. */}
            <ScrollToTopFab visible={showScrollToTop} onPress={scrollToTop} bottomInset={ABOVE_MERA_BUTTON + insets.bottom} />
            {/* The Mera button, always shown (FinalRead #7): asks about this
                article; a nested page asks about its own story. */}
        </Box>
    );
};

export default ArticleDetailScreen;
