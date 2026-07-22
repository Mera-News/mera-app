// CardActionBar — the Instagram-style action row under a story card. Deliberately
// SMALL, borderless icons (the old pill buttons read as "too big and weirdly
// aligned"): thumb-up · thumb-down · Mera on the left, then bookmark (+ optional
// share) pushed to the right by a flex spacer. No pills, no borders, no
// backgrounds. Shared by the For You feed (FeedScreen) and the fact feed
// (FactFeedScreen) via the one suggestion card (ArticleSuggestionCard).

import { Pressable } from '@/components/ui/pressable';
import { HStack } from '@/components/ui/hstack';
import { Box } from '@/components/ui/box';
import MeraLogo from '@/components/custom/MeraLogo';
import type { Verdict } from '@/lib/stores/feed-order-store';
import { ThumbsUp, ThumbsDown, Bookmark, Share2 } from 'lucide-react-native';
import React from 'react';
import { useTranslation } from 'react-i18next';

const WHITE = '#FFFFFF';
const LIKE = '#22C55E';
const DISLIKE = '#EF4444';
const SAVE_ACCENT = 'rgb(231,138,83)';
const ICON_SIZE = 24;
const STROKE = 1.8;

interface CardActionBarProps {
  verdict: Verdict | null;
  saved: boolean;
  onLike: () => void;
  onDislike: () => void;
  onAskMera: () => void;
  onToggleSave: () => void;
  /** Optional share action — renders a Share2 icon right of the bookmark. Hidden
   *  entirely when undefined (e.g. a story with no article URL). */
  onShare?: () => void;
  /** Horizontal padding of the row. Defaults to 16 (the card-root look). Hosts
   *  that already inset the row (e.g. ArticleCardBase's `p-4`) pass 0 to avoid
   *  doubling the horizontal padding. */
  horizontalPadding?: number;
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
}) => {
  const { t } = useTranslation();
  const liked = verdict === 'like';
  const disliked = verdict === 'dislike';

  return (
    <HStack
      className="items-center"
      style={{ paddingHorizontal: horizontalPadding, paddingVertical: 12, gap: 16 }}
    >
      <Pressable
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
          fill={liked ? LIKE : 'none'}
        />
      </Pressable>

      <Pressable
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
          fill={disliked ? DISLIKE : 'none'}
        />
      </Pressable>

      <Pressable
        onPress={onAskMera}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('swipeFeed.askMera')}
      >
        <MeraLogo size={ICON_SIZE} />
      </Pressable>

      {/* Spacer pushes the bookmark (+ share) to the right edge. */}
      <Box className="flex-1" />

      <Pressable
        onPress={onToggleSave}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityState={{ selected: saved }}
        accessibilityLabel={t('savedSuggestions.savedToastTitle')}
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
