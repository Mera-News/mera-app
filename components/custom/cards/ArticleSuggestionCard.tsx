import ArticleCardBase from '@/components/custom/cards/ArticleCardBase';
import CardActionBar from '@/components/custom/cards/CardActionBar';
import type { CardFeedbackHandlers } from '@/components/custom/feed/use-feedback-sheet';
import { getCachedFacts, setCachedFacts } from '@/components/custom/cards/facts-cache';
import { pendingSinceMs } from '@/components/custom/cards/pending-since';
import ReasonNote from '@/components/custom/cards/ReasonNote';
import { relevanceSpokenLabel } from '@/components/custom/relevance-spoken-label';
import { useArticleMenu } from '@/components/custom/cards/use-article-menu';
import { inlineAccessibilityActions } from '@/components/custom/cards/use-article-actions';
import { visitFromSuggestion } from '@/components/custom/cards/article-actions';
import { feedbackSubjectFromSuggestion } from '@/components/custom/cards/feedback-subject';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { getFactsForTopicTexts } from '@/lib/database/services/fact-service';
import {
  saveSuggestion,
  deleteSavedSuggestion,
  isSuggestionSaved,
} from '@/lib/database/services/saved-article-suggestion-service';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import { useShareArticle } from '@/lib/hooks/useShareArticle';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { reasonBoxColors } from '@/lib/relevance-utils';
import type { Verdict } from '@/lib/stores/feed-order-store';
import { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useHardFilterLabel } from '@/lib/stores/hard-filter-label-store';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSavedOverride } from '@/lib/saved-state';

interface ArticleCardProps {
  suggestion: ForYouSuggestion;
  /**
   * Called with the row's suggestion when the card is pressed. Takes the
   * suggestion (not a zero-arg thunk) so callers can pass a single STABLE
   * handler for every row — that stable identity is what lets the `React.memo`
   * boundary below skip re-rendering unchanged rows (perf item A2).
   */
  onPress: (suggestion: ForYouSuggestion) => void;
  timestamp?: string;
  isNew?: boolean;
  // ── Action row (the small borderless CardActionBar) ────────────────────
  // The action row renders ONLY when `onVerdict` is provided. Surfaces that use
  // it (the For You feed + the fact feed) pass the flat trio below; surfaces that
  // don't (Saved) omit them and get a pixel-identical action-less card. Kept as
  // FLAT, memo-safe props so a row re-renders only when its own verdict flips.
  /** The card's currently-stored verdict (null when undecided). */
  verdict?: Verdict | null;
  /** A thumb was tapped — the host records the verdict; the card then opens
   *  the ••• sheet at that verdict's tree root. */
  onVerdict?: (suggestion: ForYouSuggestion, verdict: Verdict) => void;
  /** The Mera glyph on the rationale block was tapped — open the default article
   *  chat. Absent ⇒ no Ask-Mera affordance renders (e.g. the Saved list). */
  onAskMera?: (suggestion: ForYouSuggestion) => void;
  // ── Feedback tree (in the shared ••• sheet) ─────────────────────────────
  /** Stable per-card tree-leaf handlers from `useFeedbackSheet`. Without them
   *  a thumb only records the verdict (no tree to give a reason in). */
  feedbackHandlers?: CardFeedbackHandlers;
  /** Dims the card (~0.55 opacity) — e.g. already-opened Earlier-zone rows. */
  dimmed?: boolean;
  /** Marks the card as already-read. Draws NO indicator of its own — there is
   *  no green tick chip and no eye glyph; both were deliberately removed. It
   *  only suppresses the NEW badge. (`ArticleCardBase`'s doc is the source of
   *  truth.) The Dashboard surfaces use this. */
  read?: boolean;
  /** Pass-through to `ArticleCardBase` — show the age label + NEW badge on the
   *  meta row. Default true; the Feed passes false. See `ArticleMetaRow`'s
   *  `showRecency` doc for why the badge travels with the timestamp. */
  showRecency?: boolean;
  /** Pass-through to `ArticleCardBase` — renders as the floating neumorphic
   *  card (Dashboard's list treatment) instead of the default Card chrome.
   *  Default false. */
  flat?: boolean;
  /** Fired when the user TOGGLES save (either direction). Optional — only the Feed tab
   *  passes it, so every other surface is unaffected. NOT fired by the mount-time
   *  `isSuggestionSaved` restore, which is not a user interaction. */
  onSaveToggled?: (suggestion: ForYouSuggestion, saved: boolean) => void;
  /** Pass-through to `ArticleCardBase` — space kept clear at the meta row for a
   *  host-owned control floating over the card's top-right (Saved list). */
  metaRowRightReserve?: number;
}

export type { ArticleCardProps };

/**
 * The suggestion (personalized) full-size card. Owns the suggestion-specific
 * chrome moved out of `ArticleSuggestionContainer`'s card path — status gating,
 * the reason box, the fact chips (+ their LRU cache), and the __DEV__ relevance
 * readout — and delegates all layout to `ArticleCardBase`.
 *
 * Drop-in for the old `ArticleCard`: same props + memo/stable-handler contract.
 */
const ArticleSuggestionCardImpl: React.FC<ArticleCardProps> = ({
  suggestion,
  onPress,
  timestamp,
  isNew = false,
  verdict = null,
  onVerdict,
  onAskMera,
  feedbackHandlers,
  dimmed = false,
  read = false,
  showRecency = true,
  flat = false,
  onSaveToggled,
  metaRowRightReserve,
}) => {
  const { t } = useTranslation();
  const [facts, setFacts] = useState<Fact[]>([]);

  // Card-local saved state — restored across remounts (ported verbatim from
  // FeedArticleCard, which mirrored ArticleActionsRow). Only wired when the
  // action row is present (onVerdict provided).
  const savedId = suggestion._id;
  const [savedFromDb, setSavedFromDb] = useState(false);
  // An override wins over the mount-time read: it means the row was saved or
  // deleted somewhere else this session (e.g. the Dashboard's Saved list), which
  // used to leave this bookmark filled against a row that no longer existed.
  const savedOverride = useSavedOverride(savedId);
  const saved = savedOverride ?? savedFromDb;
  useEffect(() => {
    if (!onVerdict) return;
    let cancelled = false;
    isSuggestionSaved(savedId)
      .then((v) => {
        if (!cancelled) setSavedFromDb(v);
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, [savedId, onVerdict]);

  const handleToggleSave = () => {
    // The service publishes the new state, which flows back through
    // `useSavedOverride` — so local state is only the pre-override seed and does
    // not need to be nudged here.
    if (saved) {
      hapticLight();
      void deleteSavedSuggestion(savedId);
    } else {
      hapticSuccess();
      void saveSuggestion(suggestion);
    }
    onSaveToggled?.(suggestion, !saved);
  };

  // D3: the shared ••• menu. Its hooks run unconditionally; the button and
  // the sheet render only where the card has an action row at all.
  const menuSubject = useMemo(() => feedbackSubjectFromSuggestion(suggestion, 'for_you'), [suggestion]);
  const menuVisit = useMemo(() => visitFromSuggestion(suggestion), [suggestion]);
  const handleShare = useShareArticle({
    url: suggestion.article_url,
    titleEnglish: suggestion.title_en,
    titleOriginal: suggestion.title_original,
    sourceLanguage: suggestion.language_code,
  });
  // A thumb records the verdict, then opens the SAME ••• sheet as the menu,
  // straight at that verdict's tree root (no Back row): one feedback
  // behaviour across the app (owner). A second tap on the recorded thumb
  // removes the verdict and opens nothing. `menuRef` because the menu is
  // built below with these very actions.
  const menuRef = React.useRef<{ openFeedback: (v: Verdict) => void } | null>(null);
  const tapThumb = (v: Verdict) => {
    if (!onVerdict) return;
    const opensTree = verdict !== v && !!feedbackHandlers;
    onVerdict(suggestion, v);
    if (opensTree) menuRef.current?.openFeedback(v);
  };
  // The action row's own buttons, as VoiceOver custom actions on the card: the
  // card root is one accessibility element, which hides the row inside it.
  const inlineActions = onVerdict
    ? inlineAccessibilityActions(t, {
        saved,
        onLike: () => tapThumb('like'),
        onDislike: () => tapThumb('dislike'),
        onToggleSave: handleToggleSave,
        onShare: suggestion.article_url ? () => void handleShare() : undefined,
      })
    : undefined;
  const menu = useArticleMenu({
    surface: 'card',
    subject: menuSubject,
    articleUrl: suggestion.article_url,
    languageCode: suggestion.language_code,
    titleOriginal: suggestion.title_original,
    visit: menuVisit,
    // A check started from a card is answered on the detail screen, directly
    // under the action row there, so the card opens it after asking.
    onCheckFacts: () => {
      // Required at call time: the fact-check client pulls in Apollo and the
      // database, and this card is the Feed's row component.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { requestArticleFactCheck } = require('@/lib/fact-check/request-article-fact-check') as typeof import('@/lib/fact-check/request-article-fact-check');
      const asked = requestArticleFactCheck({
        articleId: suggestion.articleId,
        title: suggestion.title_en ?? suggestion.title_original ?? '',
        suggestion,
      });
      if (asked) onPress(suggestion);
      return asked;
    },
    inlineActions,
    onLeafPicked: feedbackHandlers
      ? (v, pathIds, applied, committed) => feedbackHandlers.onLeafPicked(suggestion, v, pathIds, applied, committed)
      : undefined,
    onFeedbackChat: feedbackHandlers ? (v, pathIds) => feedbackHandlers.onInvokeMera(suggestion, v, pathIds) : undefined,
    onBrowseRelated: feedbackHandlers ? () => feedbackHandlers.onBrowseRelated(suggestion) : undefined,
  });
  menuRef.current = menu;


  const status = suggestion.status;
  const relevanceReady = !!status && status !== ArticleSuggestionStatus.Unscored;
  const reasonReady = status === ArticleSuggestionStatus.Complete;
  const relevance = suggestion.relevance ?? 0;
  const reason = relevanceReady ? suggestion.reason ?? '' : '';
  const reasonLoading = status === ArticleSuggestionStatus.ReasonPending && !reason;

  // Fact chips only render on a complete, reason-less suggestion; mirror that
  // exact gate here so facts are only queried when the chips can appear. The
  // module-level LRU cache lets cards sharing a topic set skip the query (A5).
  const canRenderFactChips = reasonReady && !reason;
  const topicIdsKey = (suggestion.userTopicIds ?? []).join(' ');
  useEffect(() => {
    const topicIds = suggestion.userTopicIds ?? [];
    if (!canRenderFactChips || topicIds.length === 0) {
      setFacts([]);
      return;
    }
    const cacheKey = [...topicIds].sort().join(' ');
    const cached = getCachedFacts(cacheKey);
    if (cached) {
      setFacts(cached);
      return;
    }
    let cancelled = false;
    getFactsForTopicTexts(topicIds)
      .then((f) => {
        if (cancelled) return;
        setCachedFacts(cacheKey, f);
        setFacts(f);
      })
      .catch(() => {
        if (!cancelled) setFacts([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRenderFactChips, topicIdsKey]);

  // P6 — the filtered-but-shown label. A hard "not interested" filter no longer
  // removes a TOP HEADLINE; the story is demoted instead, so it can legitimately
  // appear on a subject the user asked to keep out. Seeing that with no
  // explanation is worse than not having the feature, so the card says so
  // outright, naming the filter that matched. `null` for every ordinary row —
  // the store is empty unless the user has hard filters at all.
  //
  // Gated on `onVerdict` — the same discriminator the action row uses to tell a
  // FEED surface from the Saved list. A saved row keeps the suggestion's `_id`
  // (`saved-article-suggestion-service.saveSuggestion` assigns `r._raw.id =
  // s._id`), so it would otherwise inherit the label; but a story the user
  // deliberately saved is not a surprise that needs explaining.
  const hardFilterLabel = useHardFilterLabel(suggestion._id);
  const hardFilterLabelEl = onVerdict && hardFilterLabel ? (
    <Box
      testID="card-hard-filter-label"
      className="bg-warning-900 rounded-lg px-3 py-2"
    >
      <Text size="xs" className="text-warning-400" numberOfLines={2}>
        {t('notInterested.cardExemptLabel', { filter: hardFilterLabel })}
      </Text>
    </Box>
  ) : null;

  const factChipsEl = reasonReady && !reason && facts.length > 0 ? (
    <HStack className="flex-wrap justify-end" space="xs">
      {facts.map((fact) => (
        <Box
          key={fact.id}
          className="px-2.5 py-1 rounded-full mb-1"
          style={{ backgroundColor: reasonBoxColors.backgroundColor }}
        >
          {/* `size="2xs"` is 11px — same pixels, but the `size="xs"` class and
              the inline `fontSize: 11` are no longer contradicting each other,
              and it is on the scale. */}
          <Text
            size="2xs"
            style={{ color: reasonBoxColors.textColor, fontWeight: '600' }}
            numberOfLines={1}
          >
            {fact.statement}
          </Text>
        </Box>
      ))}
    </HStack>
  ) : null;

  // The note as displayed (it may be translated), for the card's spoken label.
  const [shownReason, setShownReason] = useState<string | null>(null);
  const reasonBoxEl = relevanceReady && (reason || reasonLoading) ? (
    <ReasonNote
      relevance={relevance}
      reason={reason}
      pendingSinceMs={pendingSinceMs(suggestion)}
      testID="card-reason"
      onNoteDisplayChange={setShownReason}
    />
  ) : null;
  // What the card root reads after the meta strings: the chip's priority
  // (only where the chip renders), then the filtered-but-shown notice, the
  // AI-note flag and the note, exactly as shown. Never the dev score readout.
  const spokenPriority = reasonBoxEl ? relevanceSpokenLabel(t, relevance) : null;
  const spokenTail = [
    hardFilterLabelEl && hardFilterLabel ? t('notInterested.cardExemptLabel', { filter: hardFilterLabel }) : null,
    reason ? t('aiDisclosure.caption') : null,
    reason ? shownReason ?? reason : null,
  ];

  const metaAccessory = __DEV__ && relevanceReady ? (
    <Box className="px-2 py-0.5 rounded bg-background-50">
      <Text size="xs" className="text-typography-400 font-mono">
        {relevance.toFixed(2)}
      </Text>
    </Box>
  ) : undefined;

  // Action row lives in the base's `footer` slot.
  // `horizontalPadding = 0` because the footer wrapper already insets it.
  const actionBar = onVerdict ? (
    <CardActionBar
      // A recorded verdict is filled at once (see CardActionBar's header).
      verdict={verdict}
      saved={saved}
      onLike={() => tapThumb('like')}
      onDislike={() => tapThumb('dislike')}
      onAskMera={() => onAskMera?.(suggestion)}
      onToggleSave={handleToggleSave}
      onShare={suggestion.article_url ? () => void handleShare() : undefined}
      onOverflow={menu.open}
      horizontalPadding={0}
    />
  ) : undefined;

  return (
    <>
    <ArticleCardBase
      testID={`card-${suggestion._id}`}
      accessibilityActions={onVerdict ? menu.accessibilityActions : undefined}
      onAccessibilityAction={onVerdict ? menu.onAccessibilityAction : undefined}
      imageUrl={suggestion.image_url}
      titleEnglish={suggestion.title_en}
      titleOriginal={suggestion.title_original ?? undefined}
      sourceLanguage={suggestion.language_code ?? undefined}
      pubDate={timestamp ?? suggestion.firstPubDate ?? suggestion.createdAt ?? ''}
      languageCode={suggestion.language_code}
      publicationName={suggestion.publication_name}
      countryCode={suggestion.country_code}
      isNew={isNew}
      recyclingKey={suggestion._id}
      dimmed={dimmed}
      read={read}
      showRecency={showRecency}
      flat={flat}
      onPress={() => onPress(suggestion)}
      metaAccessory={metaAccessory}
      metaRowRightReserve={metaRowRightReserve}
      footer={actionBar}
      spokenPriority={spokenPriority}
      spokenTail={spokenTail}
    >
      {hardFilterLabelEl}
      {factChipsEl}
      {reasonBoxEl}
    </ArticleCardBase>
    {onVerdict ? menu.element : null}
    </>
  );
};

// Memoized (shallow compare) so a row only re-renders when its own props change
// — the feed sync keeps the same `suggestion` ref for untouched rows and
// `onPress` is stable, so shallow compare bails out unchanged rows (perf A2).
export const ArticleSuggestionCard = React.memo(ArticleSuggestionCardImpl);

export default ArticleSuggestionCard;
