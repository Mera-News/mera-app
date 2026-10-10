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
import { HStack } from '@/components/ui/hstack';
import { AlertCircleIcon, Icon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { isSuggestionOpened } from '@/lib/stores/fact-rows-selector';
import InlineChoiceChip from '@/components/custom/nav/InlineChoiceChip';
import { RELATED_SORT_LABEL } from '@/components/custom/news-detail/RelatedCoverage';
import { RELATED_SORT_MODES } from '@/lib/stores/related-sort-store';
import { secureUrlOrNull } from '@/lib/algorithms/secure-url';
import { MaterialIcons } from '@expo/vector-icons';
import { useColors } from '@/lib/theme/tokens';
import { useArticleSuggestionScreen } from '@/components/custom/news-detail/useArticleSuggestionScreen';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ArticleSuggestionScreenProps {
    articleSuggestionId: string;
    onBack: () => void;
    backIcon?: 'back' | 'home';
    /** The article this page was opened from (a Related row): its own Related
     *  list leads with it. */
    fromArticleId?: string;
}

/** The page ends 12pt above the Mera button's bottom-corner position. */
const LIST_END_ABOVE_MERA = MERA_BUTTON_BAR_GAP + MERA_BUTTON_SIZE + 12;
/** ScrollToTopFab adds its own 20 to this. */
const ABOVE_MERA_BUTTON = LIST_END_ABOVE_MERA - 20;

/**
 * Detail screen for a single ArticleSuggestion. Header shows the primary
 * article from the local DB row. Sibling coverage of the same story is shown
 * in the footer as ONE flat, sorted "Related Articles" list that merges two
 * sources, deduped by article id:
 *   1. Locally-derived siblings, computed in-screen by running
 *      `buildStoryGroups` over ALL store suggestions (not just the
 *      feed-visible ones). These are the user's own personalized cards for the
 *      same story that the feed collapsed away, so they surface even when
 *      low-relevance or unscored, and tap into the richer suggestion-detail
 *      route. Superset signal vs. the server join below.
 *   2. `relatedArticles(articleId)`, fetched lazily on mount via Apollo
 *      (no-cache). Limited to the CURRENT clustering generation on the server,
 *      so it can miss cross-generation siblings that the local title-Jaccard
 *      grouping catches; rows already shown as local siblings (or the opened
 *      article itself) are filtered out, and the survivors tap into the
 *      article-detail route.
 * Both origins are merged and ordered into contiguous per-country blocks (via
 * `orderRelatedArticles`): this suggestion's country first, then the remaining
 * countries biggest-block first, countryless rows last; within a block,
 * language → publication → date → id.
 */
const ArticleSuggestionScreen: React.FC<ArticleSuggestionScreenProps> = ({
    articleSuggestionId,
    onBack,
    backIcon = 'back',
    fromArticleId,
}) => {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const {
        suggestion,
        isSaved,
        isLoading,
        error,
        reasonWriting,
        openedIds,
        factCheckPhase,
        aiAccess,
        showScrollToTop,
        titleDisplay,
        handleTitleDisplayChange,
        relatedEntries,
        isLoadingRelated,
        isLoadingMoreRelated,
        loadMoreRelated,
        relatedError,
        retryRelated,
        relatedSortMode,
        setRelatedSortMode,
        scrollViewRef,
        handleScrollPositionChange,
        scrollToTop,
        scrollToRelated,
        factCheckAsked,
        handleStartFactCheck,
        handleToggleSave,
        handleArticleUrlPress,
    } = useArticleSuggestionScreen({ articleSuggestionId });

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

    if (error || !suggestion) {
        // No deletion here: render must stay pure, and only the load effect's
        // confirmed not-found branch may delete (see there).
        return (
            <Box className="flex-1 items-center justify-center p-5">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

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
                <Pressable onPress={onBack} className="mt-6 bg-surface-raised rounded-lg px-6 py-3">
                    <Text size="md" className="text-ink">{t('common.goBack')}</Text>
                </Pressable>
            </Box>
        );
    }

    const sourceLanguage = suggestion.language_code ?? null;
    // Item 16 (defence in depth): a locally-stored suggestion row can predate
    // the server's insecure-article filter. An `http://` URL reads as
    // UNAVAILABLE — an explicit notice in place of the read/translate/share
    // block — never as a button that quietly does nothing.
    const articleUrl = secureUrlOrNull(suggestion.article_url);
    const insecureLink = !!suggestion.article_url && !articleUrl;
    const read = isSuggestionOpened(suggestion, openedIds);
    // Keyed on the ARTICLE id. `startedByReader` shows the working state at
    // once for a check the reader just asked for (no progress delay, and no
    // toast: the panel is right under the tick).
    const factCheckPanel = (
        <FactCheckPanel articleId={suggestion.articleId} startedByReader={factCheckAsked} />
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

            {/* Content */}
            <ArticleSuggestionContainer
                suggestion={suggestion}
                variant="screen"
                read={read}
                reasonWriting={reasonWriting}
                onTitleDisplayChange={handleTitleDisplayChange}
                scrollViewRef={scrollViewRef}
                onScrollPositionChange={handleScrollPositionChange}
                onEndReached={loadMoreRelated}
                contentTopInset={insets.top}
                contentBottomInset={insets.bottom + LIST_END_ABOVE_MERA}
                aboveReason={
                    <PublicationVisitBadge
                        publicationName={suggestion.publication_name}
                        countryCode={suggestion.country_code}
                    />
                }
                footer={
                    <>
                        {/* Read Article CTA */}
                        {articleUrl ? (
                            <VStack space="md">
                                <ArticleFeedbackPrompt
                                    // See ArticleDetailScreen — hidden entirely
                                    // on a locked free-tier plan (the server
                                    // resolvers are behind SubscriptionGuard)
                                    // or when the reader has turned fact
                                    // checking off, rather than left as a dead
                                    // tap. NO LONGER hidden on on-device
                                    // processing: that gate existed for the
                                    // chat's cloud-only claim picker, and this
                                    // tick no longer opens a chat.
                                    factCheck={aiAccess !== 'locked' ? {
                                        onStart: () => handleStartFactCheck(),
                                        // See ArticleDetailScreen — 'stalled'
                                        // reads as 'pending' on the tick; the
                                        // panel is where it gets its own copy.
                                        state: factCheckPhase === 'terminal'
                                            ? 'done'
                                            : factCheckPhase === 'processing' || factCheckPhase === 'stalled'
                                                ? 'pending'
                                                : 'none',
                                    } : undefined}
                                    articleId={suggestion.articleId}
                                    suggestionId={suggestion._id}
                                    title={suggestion.title_en ?? ''}
                                    // No feedback context is passed any more:
                                    // the prompt resolves the LOCAL
                                    // article_suggestions row itself (by
                                    // articleId), which carries strictly more
                                    // than this screen could hand it — category,
                                    // event type, cluster size and place.
                                    onBrowseRelated={scrollToRelated}
                                    publicationName={suggestion.publication_name ?? null}
                                    save={{ saved: isSaved, onToggle: handleToggleSave }}
                                    track={{
                                        origin: 'suggestion',
                                        surface: 'detail',
                                        articleId: suggestion.articleId,
                                        suggestionId: suggestion._id,
                                        title: suggestion.title_en ?? '',
                                        // REQUIRED: without it the tracked-story
                                        // seed snapshot falls back to "now", so
                                        // the timeline's first row showed the
                                        // TRACK moment ("4m ago") under the same
                                        // clock chip every other row uses for
                                        // publication age — and pinned a 13h-old
                                        // article above a 1h-old one.
                                        pubDate: suggestion.firstPubDate ?? suggestion.createdAt,
                                        publicationName: suggestion.publication_name,
                                        countryCode: suggestion.country_code,
                                        stableClusterId: suggestion.clusters?.find(
                                            (c) => c.stableClusterId,
                                        )?.stableClusterId ?? undefined,
                                        matchedTopics: suggestion.matchedTopics,
                                    }}
                                    share={{
                                        url: articleUrl,
                                        titleEnglish: suggestion.title_en,
                                        titleOriginal: suggestion.title_original,
                                        sourceLanguage: suggestion.language_code,
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
                                    publicationName={suggestion.publication_name}
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

                        {/* Related Articles — ONE flat, sorted list merging the
                            local cluster siblings (the user's own personalized
                            cards the feed collapsed, tapping into the richer
                            suggestion-detail route) and the server's current-
                            generation cluster join (tapping into article-detail),
                            deduped by article id and ordered by the user's
                            language/country signals first. Local rows render
                            immediately and work offline; server pages arrive 10
                            at a time as the reader scrolls, already ordered.
                            Renders unvirtualized (`.map`), which is why the page
                            size is the render budget as much as the network
                            one. */}
                        <RelatedCoverage
                            rows={relatedEntries}
                            selfArticleId={suggestion.articleId}
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

export default ArticleSuggestionScreen;
