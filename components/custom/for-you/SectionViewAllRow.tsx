import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

interface SectionViewAllRowProps {
  /** Total stories in the section — the footer only renders when > 3, so this
   *  count always reads "View all N stories" with the full section size. */
  total: number;
  onPress: () => void;
}

/**
 * Footer row under a Dashboard section's 3-card preview. Right-aligned
 * "View all N stories" + chevron; taps into the section's full fact feed. Only
 * rendered by `DashboardSectionsFeed` when a section has more than 3 groups.
 */
const SectionViewAllRow: React.FC<SectionViewAllRowProps> = ({ total, onPress }) => {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('forYou.openFactFeed')}
      className="self-end mb-3 rounded-full border px-4 py-1.5"
      style={{ borderColor: ACCENT, borderWidth: 1.25 }}
    >
      <HStack className="items-center" space="xs">
        <Text size="sm" style={{ color: ACCENT, fontWeight: '600' }}>
          {t('forYou.viewAllStories', { count: total })}
        </Text>
        <MaterialIcons name="chevron-right" size={16} color={ACCENT} />
      </HStack>
    </Pressable>
  );
};

export default SectionViewAllRow;
