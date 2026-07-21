import { Pressable } from '@/components/ui/pressable';
import { toastManager } from '@/lib/toast-manager';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The "already read" indicator — a small green check chip pinned top-right of a
 * card. Replaces the old opacity-dimming of opened rows on Dashboard surfaces.
 * Tapping it shows a transient toast explaining the mark. Own Pressable + hitSlop
 * so the tap never falls through to the card's open handler.
 */
const ReadTickChip: React.FC = () => {
  const { t } = useTranslation();
  const onPress = useCallback(() => {
    toastManager.showInfo(t('feed.readArticleToast'));
  }, [t]);

  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('feed.readArticleToast')}
      className="absolute top-2 right-2 z-10 h-6 w-6 items-center justify-center rounded-full bg-success-600"
    >
      <MaterialIcons name="check" size={16} color="#FFFFFF" />
    </Pressable>
  );
};

export default ReadTickChip;
