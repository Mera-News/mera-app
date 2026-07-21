// ReadArticleButton — the Feed deck's "read the original article" CTA. Replicates
// the suggestion-detail screen's read button (ArticleSuggestionScreen): an
// outline, rounded-full, primary-bordered button with an open-in-new glyph and
// the same `articleDetail.readOn` / `articleDetail.readArticle` label. Tapping it
// opens the publisher URL in the in-app browser (via use-open-article-url) — the
// same action as the detail page, NOT "open suggestion detail". Rendered in two
// places: pinned at the bottom of SwipeArticleCard (always visible) and in the
// in-card feedback overlay's footer (reachable while the card is dimmed).

import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ReadArticleButton: React.FC<{
  publicationName?: string | null;
  onPress?: () => void;
  disabled?: boolean;
}> = ({ publicationName, onPress, disabled = false }) => {
  const { t } = useTranslation();
  const label = publicationName
    ? t('articleDetail.readOn', { publication: publicationName })
    : t('articleDetail.readArticle');
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="flex-row items-center justify-center rounded-full border border-primary-500 px-4 py-2.5"
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <MaterialIcons name="open-in-new" size={18} color="#FFFFFF" />
      <Text
        className="text-white ml-2"
        style={{ fontSize: 14, fontWeight: '600' }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
};

export default ReadArticleButton;
