// CardActionBar — the Instagram-style action row under a story card. Borderless
// icons, no pills, no backgrounds: Mera · thumb-up · thumb-down · bookmark ·
// (optional) share, distributed EVENLY across the row. Shared by the For You
// feed (FeedScreen) and the fact feed (FactFeedScreen) via the one suggestion
// card (ArticleSuggestionCard).
//
// The Mera glyph is DELIBERATELY here as well as on the rationale block
// ("Mera's voice" — see ArticleSuggestionCard). It was briefly removed from this
// row, which left suggestion cards inconsistent with standalone cards
// (ArticleActionsRow always kept its Mera button). View consistency across card
// types won: both entry points call the SAME handler, and this one is the
// canonical affordance carrying `card-action-mera` — the rationale glyph is
// `rationale-mera`.
//
// Icons are larger than the original (ICON_SIZE) and the old "left cluster +
// flex spacer + right cluster" layout is `space-evenly`, so nothing is jammed
// against the card's right edge — where the Feed's scroll-to-top FAB overlaps
// it. `space-evenly` recomputes itself for 4 or 5 buttons, so restoring Mera
// needed no spacing constant to change.

import { Pressable } from '@/components/ui/pressable';
import { HStack } from '@/components/ui/hstack';
import MeraLogo from '@/components/custom/MeraLogo';
import type { Verdict } from '@/lib/stores/feed-order-store';
import { ThumbsUp, ThumbsDown, Bookmark, Share2 } from 'lucide-react-native';
import React from 'react';
import { useTranslation } from 'react-i18next';

const WHITE = '#FFFFFF';
const LIKE = '#22C55E';
const DISLIKE = '#EF4444';
const SAVE_ACCENT = 'rgb(231,138,83)';
const ICON_SIZE = 27;
const STROKE = 1.8;

interface CardActionBarProps {
  verdict: Verdict | null;
  saved: boolean;
  onLike: () => void;
  onDislike: () => void;
  /** Ask Mera. The SAME handler the rationale block's glyph calls. */
  onAskMera: () => void;
  onToggleSave: () => void;
  /** Optional share action — renders a Share2 icon right of the bookmark. Hidden
   *  entirely when undefined (e.g. a story with no article URL). */
  onShare?: () => void;
  /** Horizontal padding of the row. Defaults to 16 (the card-root look). Hosts
   *  that already inset the row (e.g. ArticleCardBase's `p-4`) pass 0 to avoid
   *  doubling the horizontal padding. */
  horizontalPadding?: number;
  /** D15 — the verdict is recorded but carries NO reason yet, so the thumb is
   *  coloured but left HOLLOW. A filled thumb is a promise ("this changed your
   *  persona") and a bare tap has not earned it; it fills once the user picks
   *  something in the feedback tree or escalates to Mera.
   *
   *  Defaults to false so this stays a dumb presentational row: `verdict` alone
   *  still means "filled" for any host that has no notion of commitment. */
  provisional?: boolean;
}

const CardActionBar: React.FC<CardActionBarProps> = ({
  verdict,
  saved,
  onLike,
  onDislike,
  onAskMera,
  onToggleSave,
  onShare,
  horizontalPadding = 16,
  provisional = false,
}) => {
  const { t } = useTranslation();
  const liked = verdict === 'like';
  const disliked = verdict === 'dislike';
  // Colour tracks the verdict (so a tap is always visibly registered); FILL
  // tracks whether it has been backed by a reason.
  const likeFill = liked && !provisional ? LIKE : 'none';
  const dislikeFill = disliked && !provisional ? DISLIKE : 'none';

  return (
    <HStack
      className="items-center"
      style={{
        paddingHorizontal: horizontalPadding,
        paddingVertical: 12,
        justifyContent: 'space-evenly',
      }}
    >
      <Pressable
        testID="card-action-mera"
        onPress={onAskMera}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('swipeFeed.askMera')}
      >
        <MeraLogo size={ICON_SIZE} animated={false} />
      </Pressable>

      <Pressable
        testID="card-action-like"
        onPress={onLike}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityState={{ selected: liked }}
        accessibilityLabel={t('articleFeedback.likeLabel')}
      >
        <ThumbsUp
          size={ICON_SIZE}
          strokeWidth={STROKE}
          color={liked ? LIKE : WHITE}
          fill={likeFill}
        />
      </Pressable>

      <Pressable
        testID="card-action-dislike"
        onPress={onDislike}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityState={{ selected: disliked }}
        accessibilityLabel={t('articleFeedback.dislikeLabel')}
      >
        <ThumbsDown
          size={ICON_SIZE}
          strokeWidth={STROKE}
          color={disliked ? DISLIKE : WHITE}
          fill={dislikeFill}
        />
      </Pressable>

      <Pressable
        testID="card-action-save"
        onPress={onToggleSave}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityState={{ selected: saved }}
        accessibilityLabel={t(saved ? 'savedSuggestions.removeAction' : 'savedSuggestions.saveAction')}
      >
        <Bookmark
          size={ICON_SIZE}
          strokeWidth={STROKE}
          color={saved ? SAVE_ACCENT : WHITE}
          fill={saved ? SAVE_ACCENT : 'none'}
        />
      </Pressable>

      {onShare ? (
        <Pressable
          testID="card-action-share"
          onPress={onShare}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('articleDetail.share')}
        >
          <Share2 size={ICON_SIZE} strokeWidth={STROKE} color={WHITE} fill="none" />
        </Pressable>
      ) : null}
    </HStack>
  );
};

export default CardActionBar;
