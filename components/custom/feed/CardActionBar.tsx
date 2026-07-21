// CardActionBar — the Instagram-style action row under each feed card's hero
// image. Deliberately SMALL, borderless icons (the old pill buttons read as "too
// big and weirdly aligned"): thumb-up · thumb-down · Mera on the left, bookmark
// pushed to the right by a flex spacer. No pills, no borders, no backgrounds.

import { Pressable } from '@/components/ui/pressable';
import { HStack } from '@/components/ui/hstack';
import { Box } from '@/components/ui/box';
import MeraLogo from '@/components/custom/MeraLogo';
import type { Verdict } from '@/lib/stores/feed-session-store';
import { ThumbsUp, ThumbsDown, Bookmark } from 'lucide-react-native';
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
}

const CardActionBar: React.FC<CardActionBarProps> = ({
  verdict,
  saved,
  onLike,
  onDislike,
  onAskMera,
  onToggleSave,
}) => {
  const { t } = useTranslation();
  const liked = verdict === 'like';
  const disliked = verdict === 'dislike';

  return (
    <HStack
      className="items-center"
      style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 16 }}
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

      {/* Spacer pushes the bookmark to the right edge. */}
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
    </HStack>
  );
};

export default CardActionBar;
