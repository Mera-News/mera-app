import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

interface SectionArticlesPillProps {
  /** Total stories in the section. */
  total: number;
  onPress: () => void;
  testID?: string;
}

/**
 * "N Articles" — the pill in a Dashboard section's HEADER, opening its full fact
 * feed. Right-aligned, with the fact title wrapping to its left.
 *
 * The section's closing CTA is deliberately NOT this component any more: it is
 * plain "View all N articles" text + chevron (see SectionViewAllText), styled
 * like the section title rather than as a second identical pill. Two identical
 * pills in one section read as two different destinations.
 *
 * Copy says ARTICLES, not stories: a section counts articles, and "stories" was
 * colliding with the app's separate followed-"stories" feature.
 */
const SectionArticlesPill: React.FC<SectionArticlesPillProps> = ({ total, onPress, testID }) => {
  const { t } = useTranslation();
  return (
    <Pressable
      testID={testID ?? 'dashboard-section-pill'}
      onPress={onPress}
      accessibilityRole="button"
      // Spoken label equals the visible text, count included (Apple's rule).
      accessibilityLabel={t('forYou.articlesCount', { count: total })}
      hitSlop={6}
      className="flex-shrink-0 rounded-full border px-3 py-1"
      style={{ borderColor: ACCENT, borderWidth: 1.25 }}
    >
      <HStack className="items-center" space="xs">
        <Text size="sm" style={{ color: ACCENT, fontWeight: '600' }} numberOfLines={1}>
          {t('forYou.articlesCount', { count: total })}
        </Text>
        <MaterialIcons name="chevron-right" size={16} color={ACCENT} />
      </HStack>
    </Pressable>
  );
};

export default SectionArticlesPill;
